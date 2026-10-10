/**
 * 集成测试层：真实的编排栈 + 可控的 session 替身。
 *
 * 为什么要这一层：既有测试全是纯函数单测，**真实链路一次都没跑过**——
 *   SessionHub → ClientSession → Conversation → SnapshotEmitter → WS transport
 * 这些模块之间的接线错误（参数没传、事件没映射、生命周期没清理）单测看不见，
 * 而这恰恰是 SDK 升级时最该被回归保护的部分。
 *
 * 为什么用替身而不是真模型：真 `buildAgent()` 需要网络与有效 API Key，
 * CI 里跑不起来。这里用一个**遵守 SDK 契约**的 session 替身（同样的事件名、同样的
 * 消息形状、同样的生命周期方法），从而在不依赖网络的前提下验证真实编排逻辑。
 * 替身只替换「最外层的 LLM 调用」，中间的编排代码全是生产代码。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { SessionHub, DEFAULT_MAX_OPEN_CONVERSATIONS, MAX_SNAPSHOT_MESSAGES } from "./session-hub.js";
import { listenExistingServer } from "./test-server.js";
import { resolveRuntimeConfig } from "./config.js";
import { PROTOCOL_VERSION, type ServerMessage, type UiCapabilities, type UiState } from "./protocol.js";
import { attachWebSocket } from "./transport/ws.js";
import { Metrics } from "./metrics.js";
import { AppError } from "./http/errors.js";
import type { SessionCatalog, StoredConversation } from "./sessions/store.js";
import { createToolRegistry } from "./tools/registry.js";
import { SettingsService, memorySettingsPort } from "./settings.js";
import { PlanModeController } from "./modes/plan-mode.js";
import type { BuiltAgent } from "./agent.js";
import type { Model } from "@earendil-works/pi-ai";

/* ────────────────────── 遵守 SDK 契约的 session 替身 ────────────────────── */

interface FakeEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * 复刻 AgentSession 的公开契约。
 * 关键点：subscribe 真的能推事件、messages 真的会被 SDK 追加、dispose 真的清理订阅。
 */
class FakeSession {
  readonly sessionId: string;
  messages: Array<{ role: string; content: string; timestamp: number }> = [];
  model: Model<any> | undefined;
  thinkingLevel = "default";
  isStreaming = false;
  disposed = false;
  activeTools = ["read"];
  /** 统计被取了几次。SDK 的实现每次都会全量过滤会话文件，不该每周期都调。 */
  statsCalls = 0;
  private listeners = new Set<(event: FakeEvent) => void>();
  private steering: string[] = [];
  private followUp: string[] = [];

  constructor(sessionId: string, model: Model<any>) {
    this.sessionId = sessionId;
    this.model = model;
  }

  subscribe(listener: (event: FakeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 供测试驱动：向所有订阅者广播一个 SDK 事件。 */
  emit(event: FakeEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  getSessionStats() {
    this.statsCalls += 1;
    return {
      sessionFile: undefined,
      sessionId: this.sessionId,
      userMessages: this.messages.filter((m) => m.role === "user").length,
      assistantMessages: this.messages.filter((m) => m.role === "assistant").length,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: this.messages.length,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      cost: 0.001,
    };
  }

  getActiveToolNames(): string[] {
    return [...this.activeTools];
  }
  setActiveToolsByName(names: string[]): void {
    this.activeTools = [...names];
  }
  getSteeringMessages(): readonly string[] {
    return this.steering;
  }
  getFollowUpMessages(): readonly string[] {
    return this.followUp;
  }
  setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
  }
  async setModel(model: Model<any>): Promise<void> {
    this.model = model;
  }

  async prompt(text: string): Promise<void> {
    this.messages.push({ role: "user", content: text, timestamp: Date.now() });
    this.emit({ type: "message_end" });
  }

  async abort(): Promise<void> {
    this.isStreaming = false;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

/** 造一个带 N 个独立 session 的 agent 替身（模拟多对话并发）。 */
function makeAgent(): BuiltAgent & { sessions: FakeSession[]; created: number } {
  const model: Model<any> = { provider: "test", id: "m1", name: "M1", contextWindow: 100_000 } as never;
  const sessions: FakeSession[] = [];
  let seq = 0;
  const agent = {
    session: undefined as never,
    get model() {
      return sessions[0]?.model ?? model;
    },
    builtinTools: "off" as const,
    skills: [],
    knowledge: [],
    promptTemplates: [],
    database: {
      driver: "sqlite",
      path: ":memory:",
      ping: () => ({ ok: true as const, driver: "sqlite", path: ":memory:" }),
      listNotes: () => [],
      getNote: () => undefined,
      searchNotes: () => [],
      insertNote: () => ({ id: 1, title: "t", body: "b" }),
      query: () => ({ columns: [], rows: [], truncated: false, totalRows: 0 }),
      close: () => {},
    },
    listModels: async () => [model],
    switchModel: async () => model,
    createSession: async () => {
      const s = new FakeSession(`sess-${++seq}`, model);
      sessions.push(s);
      return s as never;
    },
    dispose: () => {
      for (const s of sessions) s.dispose();
    },
    sessions,
    get created() {
      return seq;
    },
  };
  // The hub may fall back to agent.session when no factory exists; ours always exists.
  agent.session = new FakeSession("sess-0", model) as never;
  sessions.push(agent.session as never);
  return agent as never;
}

/** 收集某个 hub 的全部出站消息。 */
function collector() {
  const frames: ServerMessage[] = [];
  return { frames, push: (m: ServerMessage) => frames.push(m) };
}

/* ────────────────────── 会话编排 ────────────────────── */

test("集成：多对话各自持有独立 session，切换不影响对方", async () => {
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig());

  const a = collector();
  const client = await hub.attach("c1", a.push); // ClientSession
  const firstConv = client.active!;
  const firstId = firstConv.id;

  const secondConv = await client.newConversation();
  assert.notEqual(secondConv.id, firstId, "each conversation must own a distinct session");
  assert.equal(client.listConversations().length, 2);

  // Messages written to one conversation must not surface in the other's snapshot.
  const secondSession = secondConv.sdkSession as unknown as FakeSession;
  secondSession.messages.push({
    role: "user",
    content: "only in second",
    timestamp: Date.now(),
  });

  // Project the first conversation's state and confirm its message list is unaffected.
  a.frames.length = 0;
  firstConv.getState();
  const snap = a.frames.find((f) => f.type === "snapshot") as { state: UiState } | undefined;
  assert.ok(snap, "the first conversation must still emit a snapshot");
  assert.equal(
    snap!.state.messages.length,
    0,
    "messages added to the second conversation must not leak into the first",
  );

  // Both are reachable by id.
  assert.equal(client.get(firstId)!.id, firstId);
  assert.equal(client.get(secondConv.id)!.id, secondConv.id);

  hub.dispose();
  assert.ok(secondSession.disposed, "disposing the hub must dispose owned sessions");
});

test("集成：会话统计按事件失效——流式增量期间不重复全量取数，条目变了必然重取", async () => {
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig());
  const sink = collector();
  const cs = await hub.attach("c-stats", sink.push);
  const conv = cs.active!;
  const session = conv.sdkSession as unknown as FakeSession;

  conv.getState();
  const afterFirst = session.statsCalls;
  assert.ok(afterFirst >= 1, "第一次构建快照必须真的取一次统计");

  // 流式增量不改会话条目、也不改 usage，统计值不变 → 不该再取。
  session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
  session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "!" } });
  conv.getState();
  conv.getState();
  assert.equal(session.statsCalls, afterFirst, "流式增量期间不该重复取统计");

  // 条目变了 → 缓存必须作废，否则快照会显示过期的 token / cost。
  session.emit({ type: "message_end" });
  conv.getState();
  assert.equal(session.statsCalls, afterFirst + 1, "message_end 之后必须重新取一次统计");

  hub.dispose();
});

test("集成：并发会话数达上限后 LRU 回收最久未活动的对话", async () => {
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig(), process.cwd(), () => 6, 3);
  const sink = collector();
  const cs = await hub.attach("c1", sink.push);

  for (let i = 0; i < 5; i += 1) await cs.newConversation();
  assert.equal(
    cs.listConversations().length,
    3,
    `must stay within the cap, got ${cs.listConversations().length}`,
  );

  // The active conversation must never be the eviction victim.
  const activeId = cs.active!.id;
  assert.ok(cs.get(activeId), "active conversation must survive eviction");

  // Keep creating: the cap must hold indefinitely (no leak over time).
  for (let i = 0; i < 20; i += 1) await cs.newConversation();
  assert.equal(cs.listConversations().length, 3, "cap must hold under sustained creation");
  hub.dispose();
});

test("集成：删除对话会真删文件与索引，越界路径与最后一条被拒", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-del-"));
  const file = join(root, "s1.jsonl");
  writeFileSync(file, "{}\n");
  // 另一个目录里的一份：代表“索引被篡改 / 路径越界”，删除必须被拦住。
  const outside = join(mkdtempSync(join(tmpdir(), "pi-out-")), "evil.jsonl");
  writeFileSync(outside, "{}\n");

  const index = new Map<string, StoredConversation>();
  index.set("s1", { sessionId: "s1", sessionFile: file, title: "one", updatedAt: 1, messageCount: 3 });
  index.set("evil", { sessionId: "evil", sessionFile: outside, title: "out", updatedAt: 2, messageCount: 1 });
  const catalog: SessionCatalog = {
    cwd: root,
    list: () => [...index.values()],
    get: (sessionId) => index.get(sessionId),
    upsert: (entry) => void index.set(entry.sessionId, entry),
    remove: (sessionId) => void index.delete(sessionId),
  };

  const hub = new SessionHub(
    makeAgent(),
    resolveRuntimeConfig(),
    process.cwd(),
    () => 6,
    DEFAULT_MAX_OPEN_CONVERSATIONS,
    () => 0,
    [root],
    catalog,
  );
  const sink = collector();
  const cs = await hub.attach("c-del", sink.push);
  const liveId = cs.active!.id;

  // 1) 磁盘态条目：文件与索引一起消失，并重推列表。
  hub.deleteConversation("c-del", "s1");
  assert.ok(!existsSync(file), "会话文件应被删除");
  assert.equal(index.has("s1"), false, "索引条目应被删除");
  const latest = sink.frames.filter((f) => f.type === "conversations").at(-1) as
    | { items: { id: string }[] }
    | undefined;
  assert.ok(latest && !latest.items.some((i) => i.id === "s1"), "重推的列表里不该再有这条");

  // 2) 越界路径：fail-closed，报错且绝不能碰文件。
  assert.throws(() => hub.deleteConversation("c-del", "evil"), (err: unknown) => err instanceof AppError);
  assert.ok(existsSync(outside), "被拒时绝不能删文件");
  assert.equal(index.has("evil"), true, "被拒时也不能先删索引");

  // 3) 最后一条活会话不许删（与 close 的约束一致）。
  assert.throws(() => hub.deleteConversation("c-del", liveId), (err: unknown) => err instanceof AppError);

  // 4) 未知 id 与空 id 都明确拒绝。
  assert.throws(() => hub.deleteConversation("c-del", "nope"), (err: unknown) => err instanceof AppError);
  assert.throws(() => hub.deleteConversation("c-del", "  "), (err: unknown) => err instanceof AppError);
  hub.dispose();
});

test("集成：thinking 与 toolCall 进快照，并与 toolResult 配对", async () => {
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig());
  const sink = collector();
  const cs = await hub.attach("c1", sink.push);
  const conv = cs.active!;
  const session = conv.sdkSession as unknown as FakeSession;

  session.emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "current_time", args: {} });
  session.messages.push({ role: "user", content: "几点了", timestamp: 1 });
  session.messages.push({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "用户想知道时间，应调用 current_time" },
      { type: "toolCall", id: "tc-1", name: "current_time", arguments: { tz: "Asia/Shanghai" } },
    ],
    stopReason: "toolUse",
    timestamp: 2,
  } as never);
  // 工具结果在**另一条**消息里，投影必须把它归回发起调用的那条 assistant 消息；
  // 否则刷新后官方 ToolGroup 只剩一个空文本气泡。
  session.messages.push({
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "current_time",
    content: [{ type: "text", text: "18:00" }],
    isError: false,
    timestamp: 3,
  } as never);
  session.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "现在是 18:00" }],
    stopReason: "stop",
    timestamp: 4,
  } as never);
  session.emit({ type: "tool_execution_end", toolCallId: "tc-1", toolName: "current_time", result: "18:00", isError: false });

  sink.frames.length = 0;
  conv.getState();
  const snap = sink.frames.find((f) => f.type === "snapshot") as { state: UiState } | undefined;
  assert.ok(snap, "getState must emit a snapshot");
  const msgs = snap!.state.messages;
  assert.equal(msgs.length, 3, "toolResult 不能作为独立消息出现在快照里");

  const toolMsg = msgs[1]!;
  assert.equal(toolMsg.text, "", "只调工具的一轮本来就没有文本");
  assert.equal(toolMsg.thinking, "用户想知道时间，应调用 current_time", "思维链不能被 extractText 丢掉");
  assert.equal(toolMsg.stopReason, "toolUse", "停止原因要随消息下发");
  assert.equal(toolMsg.calls?.length, 1);
  assert.equal(toolMsg.calls![0]!.name, "current_time");
  assert.deepEqual(toolMsg.calls![0]!.args, { tz: "Asia/Shanghai" });
  assert.equal(toolMsg.calls![0]!.result, "18:00", "结果必须配对回发起调用的那条消息");
  assert.equal(typeof toolMsg.calls![0]!.durationMs, "number", "耗时由服务端实测带入历史");
  assert.equal(msgs[2]!.text, "现在是 18:00");
  hub.dispose();
});

test("集成：SDK 事件被翻译成协议消息并驱动快照", async () => {
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig());
  const sink = collector();
  const cs = await hub.attach("c1", sink.push);
  const conv = cs.active!;
  const session = conv.sdkSession as unknown as FakeSession;

  session.messages.push({ role: "user", content: "hello", timestamp: 1 });
  session.messages.push({ role: "assistant", content: "world", timestamp: 2 });

  // Tool lifecycle → tool_status start/end with a measured duration.
  session.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
  session.emit({
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "read",
    result: "ok",
    isError: false,
  });
  const statuses = sink.frames.filter((f) => f.type === "tool_status");
  assert.equal(statuses.length, 2, "both tool start and end must be forwarded");
  assert.equal((statuses[0] as { phase: string }).phase, "start");
  assert.equal((statuses[1] as { phase: string }).phase, "end");
  assert.equal((statuses[1] as { isError?: boolean }).isError, false);

  // Retry / compaction must reach the client as notices, not vanish.
  sink.frames.length = 0;
  session.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100 });
  session.emit({ type: "compaction_start", reason: "manual" });
  const notices = sink.frames.filter((f) => f.type === "notice");
  assert.equal(notices.length, 2, "retry and compaction must surface as notices");

  // getState produces an authoritative snapshot with the projected messages.
  sink.frames.length = 0;
  conv.getState();
  const snap = sink.frames.find((f) => f.type === "snapshot") as { state: UiState } | undefined;
  assert.ok(snap, "getState must emit a snapshot");
  assert.equal(snap!.state.messages.length, 2);
  assert.equal(snap!.state.messages[0]!.text, "hello");
  assert.ok(snap!.state.stats.softCap > 0, "soft cap must be derived from the model window");
  hub.dispose();
});

test("集成：会话关闭后释放资源，且保留至少一个对话", async () => {
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig());
  const sink = collector();
  const cs = await hub.attach("c1", sink.push);
  const extra = await cs.newConversation();

  assert.equal(cs.closeConversation(extra.id), true);
  assert.equal(cs.listConversations().length, 1);
  // Closing the last conversation must be refused, not leave the client with nothing.
  assert.equal(cs.closeConversation(cs.active!.id), false);
  assert.equal(cs.listConversations().length, 1);
  hub.dispose();
});

test("集成：模型切换传播到所有对话（REST/WS 不再分裂）", async () => {
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig());
  const sink = collector();
  const cs = await hub.attach("c1", sink.push);
  await cs.newConversation();

  const other: Model<any> = { provider: "test", id: "m2", name: "M2", contextWindow: 200_000 } as never;
  (agent as unknown as { switchModel: (r: string) => Promise<Model<any>> }).switchModel = async () => {
    for (const s of agent.sessions) await s.setModel(other);
    return other;
  };

  await hub.setModel("test/m2");
  // Every conversation's session must now report the new model.
  const models = agent.sessions.map((s) => s.model?.id);
  assert.ok(models.every((id) => id === "m2"), `all sessions must switch, got ${models.join(",")}`);
  hub.dispose();
});

test("集成：hub.setModel 在无客户端时仍更新共享 session", async () => {
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig());
  const other: Model<any> = { provider: "test", id: "m3", name: "M3" } as never;
  (agent as unknown as { switchModel: () => Promise<Model<any>> }).switchModel = async () => {
    await (agent.session as unknown as FakeSession).setModel(other);
    return other;
  };
  await hub.setModel("test/m3");
  assert.equal((agent.session as unknown as FakeSession).model?.id, "m3");
  hub.dispose();
});

/* ────────────────────── 端到端：HTTP + WS ────────────────────── */

interface Harness {
  base: string;
  wsUrl: string;
  frames: ServerMessage[];
  socket: WebSocket;
  close(): Promise<void>;
}

/** 起一套真实的 HTTP + WS 服务，用 agent 替身驱动。 */
async function startHarness(
  rateLimit?: Record<string, { windowMs: number; max: number }>,
  agentOverride?: BuiltAgent,
  options: { planMode?: PlanModeController } = {},
): Promise<Harness> {
  const agent = agentOverride ?? makeAgent();
  const cfg = resolveRuntimeConfig();
  const hub = new SessionHub(
    agent, cfg, process.cwd(), undefined, undefined, undefined, undefined, undefined,
    options.planMode ? { planMode: options.planMode } : {},
  );
  const settings = new SettingsService();
  const metrics = new Metrics();
  // Use the real registry rather than a hand-rolled stub: it keeps the test honest about
  // the actual ToolRegistry shape (a stub would drift silently as the class evolves).
  const registry = createToolRegistry({ builtinTools: ["read", "bash"] });

  const { createApp } = await import("./app.js");
  // `ws` is created after the app, so the gauge is read through a mutable holder — the
  // same pattern the real server.ts uses.
  let wsRef: { connectionCount: number } | undefined;
  const { app } = createApp({
    agent,
    registry,
    settings,
    metrics,
    hub: hub as never,
    rateLimit,
    connectionCount: () => wsRef?.connectionCount ?? 0,
    sessionStats: () => hub.stats(),
    approvalStats: () => 0,
  });
  const server: Server = createServer(app);
  const ws = attachWebSocket(server, {
    agent,
    hub,
    cfg,
    registry,
    settings,
    serverVersion: "test",
    metrics,
  });
  wsRef = ws;
  const listener = await listenExistingServer(server);
  const port = listener.port;
  const base = listener.url;

  const frames: ServerMessage[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: base });
  socket.on("message", (data) => frames.push(JSON.parse(data.toString("utf8")) as ServerMessage));
  socket.on("error", () => {});
  await once(socket, "open");

  return {
    base,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    frames,
    socket,
    async close() {
      try {
        await ws.close();
      } catch {
        /* already closed */
      }
      socket.terminate();
      await listener.close();
      hub.dispose();
    },
  };
}

const send = (h: Harness, msg: unknown) => h.socket.send(JSON.stringify(msg));
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

test("集成：WS set_plan_mode 真的改到权威状态（协议→hub→快照 全链路）", async () => {
  const planMode = new PlanModeController({ defaultEnabled: () => false });
  const h = await startHarness(undefined, undefined, { planMode });
  try {
    send(h, { type: "hello", protocolVersion: PROTOCOL_VERSION });
    await settle(250);

    // 能力目录必须带默认档：客户端要能在连上之前就知道新对话会不会进计划模式。
    send(h, { type: "get_capabilities" });
    await settle(150);
    const caps = h.frames.filter((f) => f.type === "capabilities").at(-1) as
      | { capabilities: UiCapabilities }
      | undefined;
    assert.equal(caps?.capabilities.planModeDefault, false);

    send(h, { type: "set_plan_mode", enabled: true });
    await settle(200);
    const notices = h.frames.filter((f) => f.type === "notice") as { text: string }[];
    assert.ok(
      notices.some((n) => /计划模式已开启/.test(n.text)),
      "the client must be told the mode changed",
    );
    const latest = h.frames.filter((f) => f.type === "snapshot").at(-1) as { state: UiState } | undefined;
    assert.equal(
      latest?.state.planMode,
      true,
      "the snapshot is the authoritative source; a client-held flag would drift from what the gate enforces",
    );

    send(h, { type: "set_plan_mode", enabled: false });
    await settle(200);
    const after = h.frames.filter((f) => f.type === "snapshot").at(-1) as { state: UiState } | undefined;
    assert.equal(after?.state.planMode, false);
  } finally {
    await h.close();
  }
});

test("集成：未装配计划模式时 set_plan_mode 不会假装成功", async () => {
  const h = await startHarness();
  try {
    send(h, { type: "hello", protocolVersion: PROTOCOL_VERSION });
    await settle(250);
    send(h, { type: "set_plan_mode", enabled: true });
    await settle(200);
    // 没有控制器 → 状态恒为 false。谎报开启会让客户端显示「已锁定」而实际没人拦。
    const latest = h.frames.filter((f) => f.type === "snapshot").at(-1) as { state: UiState } | undefined;
    assert.equal(latest?.state.planMode, false);
  } finally {
    await h.close();
  }
});

test("集成：hello → ready 优先，其余命令按序回放", async () => {
  const h = await startHarness();
  try {
    // Sent BEFORE hello: must be queued, not dropped.
    send(h, { type: "prompt", text: "early command" });
    send(h, { type: "hello", protocolVersion: PROTOCOL_VERSION });
    await settle(300);

    assert.equal(h.frames[0]?.type, "ready", "ready must be the very first frame");
    assert.ok(
      h.frames.some((f) => f.type === "snapshot"),
      "a snapshot must follow attach",
    );
    // The queued prompt reached a real session (it appended a user message).
    const client = h.frames.find((f) => f.type === "ready") as { clientId: string } | undefined;
    assert.ok(client?.clientId, "ready must carry a clientId");
  } finally {
    await h.close();
  }
});

test("集成：HTTP 探针与指标端点可用且分离", async () => {
  const h = await startHarness();
  try {
    // Attach a client session first, so the session gauges are meaningful.
    send(h, { type: "hello", protocolVersion: PROTOCOL_VERSION });
    await settle(250);

    const live = await fetch(`${h.base}/health`);
    assert.equal(live.status, 200);
    assert.equal(((await live.json()) as { ok: boolean }).ok, true);

    const ready = await fetch(`${h.base}/health/ready`);
    assert.equal(ready.status, 200);
    const readyBody = (await ready.json()) as { checks: Record<string, { ok: boolean }> };
    assert.equal(readyBody.checks.database?.ok, true);

    const metrics = await fetch(`${h.base}/metrics`);
    const body = (await metrics.json()) as { metrics: Record<string, number> };
    assert.equal(typeof body.metrics.pi_ws_connections, "number");
    // The live socket is counted, not zero.
    assert.equal(body.metrics.pi_ws_connections, 1);
    // …and after `hello` a client session is attached with exactly one conversation.
    assert.equal(body.metrics.pi_client_sessions, 1);
    assert.equal(body.metrics.pi_conversations, 1);

    const prom = await (await fetch(`${h.base}/metrics?format=prometheus`)).text();
    assert.match(prom, /pi_ws_connections 1/);
    assert.match(prom, /pi_client_sessions 1/);

    // Security headers present on every response.
    assert.equal(live.headers.get("x-content-type-options"), "nosniff");
    assert.equal(live.headers.get("x-powered-by"), null);
  } finally {
    await h.close();
  }
});

test("集成：限流在真实 HTTP 上生效，且不影响探针", async () => {
  const h = await startHarness({ "/db/query": { windowMs: 60_000, max: 2 } });
  try {
    const call = () =>
      fetch(`${h.base}/db/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1" }),
      });
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 429, "third call must be rate limited");
    // Probes must stay reachable, or orchestrators would see spurious failures.
    assert.equal((await fetch(`${h.base}/health`)).status, 200);
  } finally {
    await h.close();
  }
});

test("集成：WS 分派层——畸形输入回可读 error 帧，且**一条坏命令不打死整条连接**", async () => {
  // 这一层此前只有跨进程的 `npm run smoke` 覆盖（那些覆盖率不进 `npm test` 的统计），
  // 而它恰好是最容易「一个坏输入让整条连接失效」的地方。所以核心断言不只是「回了 error」，
  // 还有「error 之后连接仍然可用」。
  const h = await startHarness();
  try {
    send(h, { type: "hello", protocolVersion: PROTOCOL_VERSION });
    await settle(250);

    const errorsSince = (from: number) =>
      h.frames.slice(from).filter((f) => f.type === "error") as Array<{ message: string }>;

    // 1) images 带 data: 前缀 —— 模型最容易写错的一种。
    let from = h.frames.length;
    send(h, {
      type: "prompt",
      text: "看图",
      images: [{ mimeType: "image/png", data: "data:image/png;base64,AAAA" }],
    });
    await settle(200);
    const prefixed = errorsSince(from);
    assert.equal(prefixed.length, 1, "必须回一条 error");
    assert.match(prefixed[0]!.message, /不要带 data: 前缀/, "文案要能让人自己改对");

    // 2) MIME 不在白名单 + 张数超限。
    from = h.frames.length;
    send(h, { type: "prompt", text: "x", images: [{ mimeType: "image/svg+xml", data: "AAAA" }] });
    await settle(200);
    assert.match(errorsSince(from)[0]?.message ?? "", /第 1 张图片的类型不支持/);

    from = h.frames.length;
    send(h, {
      type: "prompt",
      text: "x",
      images: Array.from({ length: 5 }, () => ({ mimeType: "image/png", data: "AAAA" })),
    });
    await settle(200);
    assert.match(errorsSince(from)[0]?.message ?? "", /一次最多 4 张图片/);

    // 3) 会话类命令缺必填字段：逐条都要明确回帧，而不是静默什么都不做。
    const conversationId = "conv-1";
    const missingEntryId: Array<[string, Record<string, unknown>]> = [
      ["set_label", { conversationId }],
      ["edit_message", { conversationId }],
      ["rollback_conversation", { conversationId }],
    ];
    for (const [type, payload] of missingEntryId) {
      from = h.frames.length;
      send(h, { type, ...payload });
      await settle(150);
      assert.match(errorsSince(from)[0]?.message ?? "", /entryId is required/, `${type} 缺 entryId 必须报错`);
    }

    from = h.frames.length;
    send(h, { type: "rename_conversation", conversationId });
    await settle(150);
    assert.match(errorsSince(from)[0]?.message ?? "", /title is required/);

    // 4) 不存在的会话 / 目标：回 error 而不是抛到顶层把连接带走。
    from = h.frames.length;
    send(h, { type: "open_conversation", conversationId: "no-such-conversation" });
    await settle(250);
    assert.equal(errorsSince(from).length, 1, "打开不存在的会话必须回 error");

    from = h.frames.length;
    send(h, { type: "delete_conversation", conversationId: "no-such-conversation" });
    await settle(250);
    assert.equal(errorsSince(from).length, 1, "删除不存在的会话必须回 error");

    // 5) 非法思考档位：文案要列出合法取值（否则客户端只能瞎猜）。
    from = h.frames.length;
    send(h, { type: "set_thinking", level: "very-high" });
    await settle(150);
    assert.match(errorsSince(from)[0]?.message ?? "", /invalid thinking level/);

    // 6) 没见过的名字：`isClientMessage` 会把「无空白的任意名字」当成**业务自定义命令**放行，
    //    所以走的是 runCustom 的「未注册」分支 —— 这比粗暴拒绝更有用，它会带上最接近的
    //    命令名做提示。（原先落到 switch 的 default 静默丢弃，前端只会一直等一个永不到来的响应。）
    from = h.frames.length;
    send(h, { type: "definitely_not_a_command" });
    await settle(150);
    assert.match(errorsSince(from)[0]?.message ?? "", /unknown command: definitely_not_a_command/);

    // 而空串 / 纯空白是真的不合法，必须在协议层就被拒。
    for (const bad of ["", "   "]) {
      from = h.frames.length;
      send(h, { type: bad });
      await settle(150);
      assert.match(
        errorsSince(from)[0]?.message ?? "",
        /unknown message type/,
        `type=${JSON.stringify(bad)} 应被协议层拒`,
      );
    }

    // 7) 一路错下来，连接必须还活着 —— 这才是「坏命令不打死连接」的真正断言。
    from = h.frames.length;
    send(h, { type: "ping" });
    await settle(150);
    assert.ok(
      h.frames.slice(from).some((f) => f.type === "pong"),
      "经历一连串畸形输入之后，ping 仍必须得到 pong",
    );
  } finally {
    await h.close();
  }
});

test("集成：连接关闭后 hub 回收会话（无泄漏）", async () => {
  const h = await startHarness();
  try {
    send(h, { type: "hello", protocolVersion: PROTOCOL_VERSION });
    await settle(250);
    send(h, { type: "new_conversation" });
    await settle(200);
    const list = h.frames.filter((f) => f.type === "conversations").pop() as
      | { items: unknown[] }
      | undefined;
    assert.ok((list?.items.length ?? 0) >= 2, "second conversation must be listed");

    h.socket.terminate();
    await settle(300);
    // A fresh connection must get a clean attach, proving the old one was detached.
    const before = h.frames.length;
    const fresh = new WebSocket(h.wsUrl, { origin: h.base });
    const freshFrames: ServerMessage[] = [];
    fresh.on("message", (d) => freshFrames.push(JSON.parse(d.toString("utf8")) as ServerMessage));
    fresh.on("error", () => {});
    await once(fresh, "open");
    fresh.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
    await settle(250);
    assert.equal(freshFrames[0]?.type, "ready");
    fresh.terminate();
    void before;
  } finally {
    await h.close();
  }
});

test("集成：断开后重建的客户端拿到全新快照（rev 链自愈的前提）", async () => {
  const h = await startHarness();
  try {
    send(h, { type: "hello", protocolVersion: PROTOCOL_VERSION });
    await settle(250);
    h.socket.terminate();
    await settle(200);

    const fresh = new WebSocket(h.wsUrl, { origin: h.base });
    const frames: ServerMessage[] = [];
    fresh.on("message", (d) => frames.push(JSON.parse(d.toString("utf8")) as ServerMessage));
    fresh.on("error", () => {});
    await once(fresh, "open");
    fresh.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
    // A reconnecting client asks for a full rebuild; it must get one.
    fresh.send(JSON.stringify({ type: "get_state" }));
    await settle(300);

    const full = frames.filter((f) => f.type === "snapshot") as Array<{ state: UiState }>;
    assert.ok(full.length >= 1, "reconnect must yield a full snapshot");
    assert.ok(full[full.length - 1]!.state.rev > 0, "snapshot must carry a monotonic rev");
    fresh.terminate();
  } finally {
    await h.close();
  }
});

/**
 * 回归：WS 切模型后，REST 侧报告的模型必须跟着变。
 *
 * 曾经的真实缺陷：`createApp` 用 `let currentModel = options.agent.model` 把模型快照成局部
 * 变量，只在 `POST /model` 里更新；而 WS 的 `set_model` 走 `hub.setModel()`，**绕过 app**。
 * 结果每个对话都跑在新模型上，`/info` 与 `/health/ready` 却一直报旧模型——正是"过期快照"
 * 这类bug 换了个地方复现。修复方式是每请求读 `agent.model` getter，不缓存。
 */
test("集成：WS 切模型后 /info 与 /health/ready 报告的模型不再过期", async () => {
  const m2: Model<any> = { provider: "test", id: "m2", name: "M2", contextWindow: 200_000 } as never;
  const agent = makeAgent();
  // Real switch semantics: the shared session's model actually changes.
  (agent as unknown as { switchModel: () => Promise<Model<any>> }).switchModel = async () => {
    const shared = agent.session as unknown as FakeSession;
    await shared.setModel(m2);
    return m2;
  };
  (agent as unknown as { listModels: () => Promise<Model<any>[]> }).listModels = async () => [
    agent.model,
    m2,
  ];

  const h = await startHarness(undefined, agent);
  try {
    const before = (await (await fetch(`${h.base}/info`)).json()) as { model: string };
    assert.equal(before.model, "test/m1", "precondition: starts on m1");

    send(h, { type: "hello", protocolVersion: PROTOCOL_VERSION });
    await settle(250);
    send(h, { type: "set_model", modelId: "test/m2" });
    await settle(400);

    const truth = `${agent.model.provider}/${agent.model.id}`;
    assert.equal(truth, "test/m2", "the switch must actually reach the shared session");

    const info = (await (await fetch(`${h.base}/info`)).json()) as { model: string; modelId: string };
    assert.equal(info.model, truth, "/info must report the live model, not a cached one");
    assert.equal(info.modelId, "m2");

    const ready = (await (await fetch(`${h.base}/health/ready`)).json()) as {
      ok: boolean;
      checks: { model: { detail: string } };
    };
    assert.equal(ready.checks.model.detail, truth, "/health/ready must not report a stale model");
  } finally {
    await h.close();
  }
});

/**
 * 回归：轮次结束与工具流式输出必须有权威信号。
 *
 * 内核曾经判断了 `agent_end` 要立即 flush 快照，却没有对应分支——于是：
 *   - 客户端拿不到「本轮结束」，只能靠快照里 `isStreaming` 轮询推断；
 *   - 长工具运行期间只有 start/end 两个点，中间过程完全不可见。
 * SDK 的 `agent_end` 不带 stopReason，必须从最后一条 assistant 消息推导。
 */
test("集成：agent_end 发出 run_end（含 stopReason / aborted），工具 update 发tool_delta", async () => {
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig());
  const sink = collector();
  const cs = await hub.attach("c1", sink.push);
  const conv = cs.active!;
  const session = conv.sdkSession as unknown as FakeSession;

  sink.frames.length = 0;
  session.emit({ type: "agent_start" });
  assert.ok(
    sink.frames.some((f) => f.type === "run_start"),
    "a turn must announce its start",
  );

  sink.frames.length = 0;
  session.emit({
    type: "tool_execution_update",
    toolCallId: "t1",
    toolName: "bash",
    args: {},
    partialResult: "partial output",
  });
  const delta = sink.frames.find((f) => f.type === "tool_delta") as
    | { toolCallId: string; toolName: string; delta: string; seq: number }
    | undefined;
  assert.ok(delta, "a streaming tool update must surface as tool_delta");
  assert.equal(delta!.toolName, "bash");
  assert.equal(delta!.delta, "partial output");
  assert.ok(Number.isInteger(delta!.seq), "tool_delta must carry an ordered seq");

  // A plain string, and a content-block shape, both have to render as text.
  sink.frames.length = 0;
  session.emit({
    type: "tool_execution_update",
    toolCallId: "t2",
    toolName: "read",
    args: {},
    partialResult: [{ type: "text", text: "chunk-a" }, { type: "text", text: "chunk-b" }],
  });
  const joined = sink.frames.find((f) => f.type === "tool_delta") as { delta: string } | undefined;
  assert.equal(joined?.delta, "chunk-achunk-b", "content blocks must be concatenated in order");

  sink.frames.length = 0;
  session.emit({
    type: "agent_end",
    willRetry: false,
    messages: [
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: "yo", timestamp: 2, stopReason: "stop" },
    ] as never,
  });
  const end = sink.frames.find((f) => f.type === "run_end") as
    | { stopReason?: string; willRetry?: boolean; aborted?: boolean }
    | undefined;
  assert.ok(end, "a turn must emit the authoritative run_end signal");
  assert.equal(end!.stopReason, "stop", "stopReason must be derived from the last assistant message");
  assert.ok(!end!.aborted, "a normal finish is not an abort");
  assert.ok(
    sink.frames.some((f) => f.type === "conversations"),
    "finishing a turn refreshes the conversation list",
  );

  // Aborted and retrying are distinct states and must not be reported as a clean finish.
  sink.frames.length = 0;
  session.emit({
    type: "agent_end",
    willRetry: true,
    messages: [{ role: "assistant", content: "x", timestamp: 3, stopReason: "error" }] as never,
  });
  const retry = sink.frames.find((f) => f.type === "run_end") as
    | { willRetry?: boolean }
    | undefined;
  assert.equal(retry!.willRetry, true, "an auto-retry must be distinguishable from a clean finish");

  sink.frames.length = 0;
  session.emit({
    type: "agent_end",
    willRetry: false,
    messages: [{ role: "assistant", content: "x", timestamp: 4, stopReason: "aborted" }] as never,
  });
  const aborted = sink.frames.find((f) => f.type === "run_end") as { aborted?: boolean } | undefined;
  assert.equal(aborted!.aborted, true, "an abort must be flagged");

  hub.dispose();
});

test("集成：turn_start / turn_end 逐迭代播报，轮次序号自增", async () => {
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig());
  const sink = collector();
  const cs = await hub.attach("c1", sink.push);
  const session = cs.active!.sdkSession as unknown as FakeSession;

  // 一次 prompt 里模型可能「调用工具 → 再想」多轮；run_start 只来一次，
  // 所以逐迭代的进度只能靠 turn_* 帧——缺了它客户端只能显示「在忙」而看不出走到第几步。
  const isSnapshot = (f: ServerMessage) => f.type === "snapshot" || f.type === "snapshot_delta";
  const latestRev = () =>
    Math.max(0, ...sink.frames.filter(isSnapshot).map((f) => (f as { rev?: number }).rev ?? 0));

  sink.frames.length = 0;
  const revBefore = latestRev();
  session.emit({ type: "turn_start" });
  session.emit({
    type: "turn_end",
    message: { role: "assistant", content: "a", timestamp: 2, stopReason: "toolUse" },
    toolResults: [{ toolCallId: "t1", toolName: "read", output: "ok" }],
  } as never);
  session.emit({ type: "turn_start" });
  session.emit({
    type: "turn_end",
    message: { role: "assistant", content: "b", timestamp: 3, stopReason: "stop" },
  } as never);

  const starts = sink.frames.filter((f) => f.type === "turn_start") as { turnIndex: number }[];
  const ends = sink.frames.filter((f) => f.type === "turn_end") as {
    turnIndex: number;
    stopReason?: string;
    toolResults?: number;
  }[];
  assert.equal(starts.length, 2, "every ReAct iteration must be announced");
  assert.equal(ends.length, 2);
  assert.deepEqual(
    starts.map((f) => f.turnIndex),
    [1, 2],
    "turn index must increase monotonically within the connection",
  );
  assert.equal(ends[0]!.turnIndex, 1, "an iteration ends under the index it started with");
  assert.equal(ends[1]!.turnIndex, 2);
  assert.equal(ends[0]!.stopReason, "toolUse", "stopReason must be carried over");
  assert.equal(ends[0]!.toolResults, 1, "the tool-result count must reach the client");
  assert.equal(ends[1]!.toolResults, undefined, "no array → no invented count");

  // 逐迭代结束也要推进快照版本：进度条靠它更新，而不是等整轮跑完。
  //（帧可能是全量 snapshot 或增量 snapshot_delta，两者都算推进，所以看 rev 而不是看类型。）
  assert.ok(
    latestRev() > revBefore,
    `each iteration boundary must advance the snapshot rev, got ${latestRev()} <= ${revBefore}`,
  );

  hub.dispose();
});

test("集成：计划模式按会话隔离，快照里的 planMode 是权威值", async () => {
  const planMode = new PlanModeController({ defaultEnabled: () => false });
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig(), process.cwd(), undefined, undefined, undefined, undefined, undefined, {
    planMode,
  });
  const sink = collector();
  const cs = await hub.attach("c1", sink.push);
  const other = await hub.attach("c2", collector().push);

  const snapshotPlanMode = () =>
    (sink.frames.filter((f) => f.type === "snapshot").at(-1) as { state: UiState } | undefined)
      ?.state.planMode;
  assert.equal(snapshotPlanMode(), false, "plan mode must be part of the authoritative snapshot");

  assert.equal(cs.active!.setPlanMode(true), true);
  assert.equal(snapshotPlanMode(), true, "toggling must publish a fresh snapshot immediately");
  assert.equal(
    other.active!.isPlanMode(),
    false,
    "plan mode is per conversation: one being planned must not freeze another",
  );

  // 再建一条对话：跟随默认档，而不是继承上一条的选择。
  const fresh = await cs.newConversation();
  assert.equal(fresh.isPlanMode(), false, "a new conversation starts from the default");

  hub.dispose();
});

test("集成：settings.planMode 只影响跟随默认档的会话", async () => {
  const settings = new SettingsService(memorySettingsPort());
  const planMode = new PlanModeController({ defaultEnabled: () => settings.get().planMode });
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig(), process.cwd(), undefined, undefined, undefined, undefined, undefined, {
    planMode,
  });
  const cs = await hub.attach("c1", collector().push);

  settings.patch({ planMode: true });
  assert.equal(cs.active!.isPlanMode(), true, "a conversation with no explicit choice follows the default");
  cs.active!.setPlanMode(false);
  settings.patch({ planMode: false });
  assert.equal(
    cs.active!.isPlanMode(),
    false,
    "an explicit choice must outrank the default, otherwise flipping the setting silently overrides it",
  );

  hub.dispose();
});

test("集成：UI 消息投影稳定（增量快照快路径的前提）", async () => {
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig());
  const sink = collector();
  const cs = await hub.attach("c1", sink.push);
  const conv = cs.active!;
  const session = conv.sdkSession as unknown as FakeSession;

  for (let i = 0; i < 5; i += 1) {
    session.messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}`, timestamp: i });
  }

  sink.frames.length = 0;
  conv.getState();
  const first = sink.frames.find((f) => f.type === "snapshot") as { state: UiState } | undefined;
  session.messages.push({ role: "user", content: "m5", timestamp: 99 });
  sink.frames.length = 0;
  conv.getState();
  const second = sink.frames.find((f) => f.type === "snapshot") as { state: UiState } | undefined;

  // Same SDK message objects must project to the SAME UiMessage references, otherwise the
  // append-only check degrades into a full snapshot on every tick.
  assert.ok(first && second);
  for (let i = 0; i < first!.state.messages.length; i += 1) {
    assert.equal(first!.state.messages[i], second!.state.messages[i], `message ${i} must be reference-stable`);
  }
  assert.equal(second!.state.messages.length, 6);
  hub.dispose();
});

test("集成：超出上限的快照被截断并如实标记（不静默丢历史）", async () => {
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig());
  const sink = collector();
  const client = await hub.attach("c1", sink.push);
  const conv = client.active!;
  const session = conv.sdkSession as unknown as FakeSession;

  // One more message than the cap allows.
  const total = MAX_SNAPSHOT_MESSAGES + 25;
  for (let i = 0; i < total; i += 1) {
    session.messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}`, timestamp: i });
  }

  sink.frames.length = 0;
  conv.getState();
  const snap = sink.frames.find((f) => f.type === "snapshot") as { state: UiState } | undefined;
  assert.ok(snap, "must emit a snapshot");
  assert.equal(snap!.state.messages.length, MAX_SNAPSHOT_MESSAGES, "wire payload must be capped");
  assert.equal(snap!.state.messagesTruncated, true, "truncation must be reported, not silent");
  assert.equal(snap!.state.totalMessages, total, "the true total must remain visible");
  // The retained window is the TAIL (what the UI is currently rendering).
  assert.equal(snap!.state.messages.at(-1)!.text, `m${total - 1}`);

  // The server keeps full history regardless of the wire cap.
  assert.equal(session.messages.length, total, "full history must be retained server-side");

  hub.dispose();
  assert.ok(DEFAULT_MAX_OPEN_CONVERSATIONS > 0);
});
