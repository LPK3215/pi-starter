/**
 * 主动压缩上下文的测试。
 *
 * 之前内核只有 SDK 自动触发时的被动 notice——客户端看得见压缩发生了，却没有任何办法
 * 主动发起。这里覆盖四件事：门槛判断、流式期拒绝、成功后缓存失效、REST 端点接线。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionHub, MIN_COMPACTABLE_TOKENS } from "./session-hub.js";
import { resolveRuntimeConfig } from "./config.js";
import type { Model } from "@earendil-works/pi-ai";
import type { BuiltAgent } from "./agent.js";
import type { ServerMessage } from "./protocol.js";

const model = { provider: "test", id: "m1", name: "M1", contextWindow: 200_000 } as Model<any>;

/** 会话替身：只需满足 compact() 走到的分支。 */
class FakeSession {
  readonly sessionId = "s-compact-1";
  readonly messages: Array<{ role: string; content: string; timestamp: number }> = [];
  model: Model<any> = model;
  isStreaming = false;
  thinkingLevel = "default";
  /** 记录 compact 被调用的次数与参数。 */
  compactCalls: Array<string | undefined> = [];
  /**
   * 压缩如何改写历史，两种模式都要覆盖：
   * - `replace`：换一批新对象（WeakMap 键变了，天然 miss）；
   * - `inplace`：**原地改写**已有对象——键引用不变，WeakMap 会命中压缩前的缓存。
   *
   * 真实 SDK 走哪种不由我们决定，所以内核必须两种都防得住；只测replace 会让
   * `inplace` 下的缓存失效漏洞悄悄存在。
   */
  compactMode: "replace" | "inplace" = "replace";
  compactThrows: string | null = null;
  handlers: Array<(event: unknown) => void> = [];

  subscribe(fn: (event: unknown) => void): () => void {
    this.handlers.push(fn);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== fn);
    };
  }
  emit(event: unknown): void {
    for (const h of [...this.handlers]) h(event);
  }
  getSessionStats() {
    return { tokens: { input: 0, output: 0, total: 0 }, cost: 0 };
  }
  getActiveToolNames(): string[] {
    return [];
  }
  getSteeringMessages(): string[] {
    return [];
  }
  getFollowUpMessages(): string[] {
    return [];
  }
  setActiveToolsByName(): void {}
  setThinking(): void {}
  setModel(next: Model<any>): void {
    this.model = next;
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {
    this.isStreaming = false;
  }
  dispose(): void {}
  async compact(instructions?: string): Promise<unknown> {
    this.compactCalls.push(instructions);
    if (this.compactThrows) throw new Error(this.compactThrows);
    if (this.compactMode === "inplace") {
      // 真·原地改写：复用**同一个对象**，只换 content。对象身份不变，所以任何以
      // 消息对象为键的 WeakMap 缓存都会命中压缩前的投影与 token 数——这正是要防的情况。
      const first = this.messages[0];
      first.content = "[摘要] 之前的对话要点";
      first.timestamp = 99;
      this.messages.length = 1;
      this.messages.push({ role: "assistant", content: "好的，我已了解上下文。", timestamp: 100 });
    } else {
      this.messages.length = 0;
      this.messages.push({ role: "user", content: "[摘要] 之前的对话要点", timestamp: 99 });
      this.messages.push({ role: "assistant", content: "好的，我已了解上下文。", timestamp: 100 });
    }
    return {};
  }
}

function makeAgent(session: FakeSession): BuiltAgent {
  return {
    builtinTools: "off",
    skills: [],
    knowledge: [],
    database: { ping: () => ({ driver: "memory", path: ":memory:" }), listNotes: () => [], getNote: () => undefined, query: () => ({ columns: [], rows: [], truncated: false, totalRows: 0 }), setNote: () => 0, deleteNote: () => false, close: () => {} },
    model,
    session: session as never,
    listModels: async () => [model],
    switchModel: async () => model,
    createSession: async () => session as never,
    dispose: () => {},
  } as unknown as BuiltAgent;
}

/** 塞足够多的消息，让 token 估算越过压缩门槛。 */
function fillToCompactable(session: FakeSession): void {
  const chunk = "x".repeat(4000);
  for (let i = 0; i < 20; i += 1) {
    session.messages.push({ role: i % 2 ? "assistant" : "user", content: chunk, timestamp: i });
  }
}

async function attach(session: FakeSession): Promise<{
  hub: SessionHub;
  frames: ServerMessage[];
  cs: Awaited<ReturnType<SessionHub["attach"]>>;
}> {
  const hub = new SessionHub(makeAgent(session), resolveRuntimeConfig());
  const frames: ServerMessage[] = [];
  const cs = await hub.attach("c1", (m) => frames.push(m));
  return { hub, frames, cs };
}

test("压缩：上下文太小时拒绝，并说明收益不大（不白花一次 LLM 调用）", async () => {
  const session = new FakeSession();
  session.messages.push({ role: "user", content: "短", timestamp: 1 });
  const { hub, cs } = await attach(session);
  const conv = cs.active!;

  const outcome = await conv.compact();
  assert.equal(outcome.ok, false, "a tiny context must not be compacted");
  assert.match(outcome.reason ?? "", /很小/, "the reason must be actionable, not just false");
  assert.equal(session.compactCalls.length, 0, "the SDK must not be called at all");
  hub.dispose();
});

test("压缩：流式进行中拒绝（重写历史会与正在追加的消息冲突）", async () => {
  const session = new FakeSession();
  fillToCompactable(session);
  session.isStreaming = true;
  const { hub, cs } = await attach(session);

  const outcome = await cs.active!.compact();
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason ?? "", /生成中/);
  assert.equal(session.compactCalls.length, 0);
  hub.dispose();
});

test("压缩：成功时透传 instructions，并作废投影/ token 缓存", async () => {
  const session = new FakeSession();
  fillToCompactable(session);
  const { hub, frames, cs } = await attach(session);
  const conv = cs.active!;

  frames.length = 0;
  const outcome = await conv.compact("保留所有文件路径与最终结论");

  assert.equal(outcome.ok, true, outcome.reason);
  assert.deepEqual(session.compactCalls, ["保留所有文件路径与最终结论"], "instructions must reach the SDK");
  assert.ok((outcome.tokensAfter ?? 0) < (outcome.tokensBefore ?? 0), "tokens must actually drop");

  // 缓存作废的**可观测后果**：压缩后的快照必须是新历史，不是压缩前的。
  const snap = frames.filter((f) => f.type === "snapshot").pop() as
    | { state: { messages: Array<{ role: string; text?: string }> } }
    | undefined;
  assert.ok(snap, "compaction must produce a fresh snapshot");
  const texts = snap!.state.messages.map((m) => m.text ?? "").join("|");
  assert.ok(!texts.includes("xxxx"), "the snapshot must not still show the pre-compaction history");
  assert.ok(texts.includes("摘要") || texts.includes("了解"), "it must show the compacted history");

  // notice 反馈：开始与完成都要让用户看见
  const notices = frames.filter((f) => f.type === "notice") as Array<{ text: string }>;
  assert.ok(notices.some((n) => n.text.includes("开始压缩")), "compaction start must be announced");
  assert.ok(notices.some((n) => n.text.includes("压缩完成")), "compaction result must be reported");
  hub.dispose();
});

test("压缩：SDK 抛错时如实报错，不吞异常也不崩连接", async () => {
  const session = new FakeSession();
  fillToCompactable(session);
  session.compactThrows = "模型不支持摘要";
  const { hub, frames, cs } = await attach(session);

  const outcome = await cs.active!.compact();
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason ?? "", /不支持摘要/, "the SDK's reason must reach the caller");
  const notices = frames.filter((f) => f.type === "notice") as Array<{ level: string; text: string }>;
  assert.ok(notices.some((n) => n.level === "error" && n.text.includes("压缩失败")));
  hub.dispose();
});

test("压缩：SDK 没有 compact 方法时如实说明，不假装成功", async () => {
  const session = new FakeSession();
  fillToCompactable(session);
  (session as unknown as { compact?: unknown }).compact = undefined;
  const { hub, cs } = await attach(session);

  const outcome = await cs.active!.compact();
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason ?? "", /不支持/);
  hub.dispose();
});

test("压缩：SDK 原地改写历史时，缓存必须作废（WeakMap 键不变会命中过期投影）", async () => {
  const session = new FakeSession();
  fillToCompactable(session);
  session.compactMode = "inplace";
  const { hub, frames, cs } = await attach(session);
  const conv = cs.active!;

  // 先让投影与 token 缓存热起来——这正是"命中过期值"的前提
  conv.getState();

  frames.length = 0;
  const outcome = await conv.compact();
  assert.equal(outcome.ok, true, outcome.reason);

  const snap = frames.filter((f) => f.type === "snapshot").pop() as
    | { state: { messages: Array<{ role: string; text?: string }>; stats: { contextTokens: number } } }
    | undefined;
  assert.ok(snap, "compaction must produce a fresh snapshot");
  const texts = snap!.state.messages.map((m) => m.text ?? "").join("|");
  assert.ok(
    !texts.includes("xxxx"),
    "in-place rewrite must not surface through a stale projection cache: " + texts.slice(0, 60),
  );
  assert.ok(
    snap!.state.stats.contextTokens < MIN_COMPACTABLE_TOKENS,
    `token count must be recomputed, not served from the stale cache (got ${snap!.state.stats.contextTokens})`,
  );
  hub.dispose();
});

test("压缩：门槛常量与文档一致，且不是个随意的小数字", () => {
  // 低于这个量压了也省不下什么；但也不能高到让「主动压缩」几乎永远触发不了。
  assert.ok(MIN_COMPACTABLE_TOKENS >= 1_000, "too low: compaction would trigger on trivial contexts");
  assert.ok(MIN_COMPACTABLE_TOKENS <= 20_000, "too high: manual compaction would be unreachable");
});

test("压缩：REST 汇总多个连接，串行执行并报出每个结果", async () => {
  const sessionA = new FakeSession();
  const sessionB = new FakeSession();
  fillToCompactable(sessionA);
  fillToCompactable(sessionB);
  const hub = new SessionHub(makeAgent(sessionA), resolveRuntimeConfig());
  const cs1 = await hub.attach("c1", () => {});
  void cs1;
  const cs2 = await hub.attach("c2", () => {});
  void cs2;
  // 让 c2 不可压缩，验证「部分失败」不会被整体吞掉
  sessionB.messages.length = 0;
  sessionB.messages.push({ role: "user", content: "短", timestamp: 1 });

  const result = await hub.compactAcrossClients("统一要求");
  assert.equal(result.ok, true, "at least one compaction succeeded");
  assert.equal(result.compacted, 1);
  assert.equal(result.results.length, 2, "every client must be reported, not just the lucky one");
  const failed = result.results.find((r) => !r.ok);
  assert.ok(failed, "the failing client must appear in the results with a reason");
  assert.ok(failed!.reason);
  assert.deepEqual(sessionA.compactCalls, ["统一要求"]);
  hub.dispose();
});

test("压缩：没有活动连接时如实说明，而不是返回空成功", async () => {
  const hub = new SessionHub(makeAgent(new FakeSession()), resolveRuntimeConfig());
  const result = await hub.compactAcrossClients();
  assert.equal(result.ok, false);
  assert.equal(result.compacted, 0);
  assert.match(result.reason ?? "", /没有活动连接/);
  hub.dispose();
});
