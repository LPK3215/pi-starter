/**
 * WS 客户端的帧归约测试（前端首个测试）。
 *
 * 这里**不引入新依赖**：走根项目已有的 `tsx --test`（node 内置 test runner）。
 * `client.ts` 不依赖 React/DOM，只在方法里用到 WebSocket / location / localStorage
 * 这几个全局，测试里换成替身即可。
 *
 * 重点覆盖"多会话并发"这条主线上的高危缺陷：
 * 后端把**每条已打开对话**的帧都推到同一个 socket（`ClientSession.emit` 不按 active 过滤），
 * 客户端必须按 `conversationId` 过滤，否则后台会话会污染当前视图。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { PiWsClient } from "./client.js";
import type { ServerMessage, UiMessage, UiState, UiStateLight } from "@pi/protocol";

/* ─────────────────── 全局替身 ─────────────────── */

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly url: string;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  /** 测试驱动：模拟服务端就绪。 */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  private emit(type: string, ev: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

function installGlobals(): void {
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  (globalThis as { location?: unknown }).location = { protocol: "http:", host: "localhost:3000" };
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

/** 建连并把 FakeWebSocket 推到 OPEN。 */
function connected(): { client: PiWsClient; ws: FakeWebSocket } {
  installGlobals();
  FakeWebSocket.instances = [];
  const client = new PiWsClient();
  client.connect();
  const ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  return { client, ws };
}

/** 构造一份完整 UiState（字段以协议为准，测试只关心 conversationId）。 */
function fullState(conversationId: string, over: Record<string, unknown> = {}): UiState {
  return {
    clientId: "c1",
    cwd: "/tmp",
    sessionId: "s1",
    conversationId,
    rev: 1,
    title: "t",
    messages: [],
    streamingMessage: null,
    isStreaming: false,
    model: { provider: "p", id: "m", name: "m" },
    thinkingLevel: "off",
    tools: [],
    queue: { steering: [], followUp: [] },
    stats: {
      context: { tokens: 0, softCap: 0, usage: 0 },
      cost: 0,
      totalMessages: 0,
      contextTruncated: false,
    },
    conversations: [],
    planMode: false,
    pendingApproval: null,
    messagesTruncated: false,
    ...over,
  } as unknown as UiState;
}

function lightState(conversationId: string, rev: number): UiStateLight {
  return { conversationId, rev } as unknown as UiStateLight;
}

function snapshotOf(conversationId: string, over: Record<string, unknown> = {}): ServerMessage {
  return { type: "snapshot", state: fullState(conversationId, over) };
}

function deltaOf(conversationId: string, rev: number, baseRev: number, appended: UiMessage[] = []): ServerMessage {
  return { type: "snapshot_delta", conversationId, rev, baseRev, appended, state: lightState(conversationId, rev) };
}

/** 直接投递一帧（不经 socket，测试聚焦归约逻辑）。 */
function feed(client: PiWsClient, msg: ServerMessage): void {
  (client as unknown as { handle(m: ServerMessage): void }).handle(msg);
}

/* ─────────────────── 跨会话过滤（高危回归） ─────────────────── */

test("跨会话：非当前会话的 snapshot 不覆盖当前视图", () => {
  const { client } = connected();
  feed(client, snapshotOf("A"));
  assert.equal(client.getSnapshot().state?.conversationId, "A");

  // 后台会话 B 发全量快照：必须被丢弃，而不是把 A 顶掉。
  feed(client, snapshotOf("B"));
  assert.equal(client.getSnapshot().state?.conversationId, "A", "当前会话不能被后台快照替换");
  assert.equal(client.droppedForeignFrames, 1);
});

test("跨会话：snapshot_delta 是被忽略，而不是清空当前视图", () => {
  const { client } = connected();
  feed(client, snapshotOf("A"));
  const before = client.getSnapshot().state;

  // 这条回归的核心：以前这里调 resetConversationView()，把 A 的消息整个抹掉。
  feed(client, deltaOf("B", 2, 1, [{ role: "user", text: "来自 B 的消息" }]));

  const after = client.getSnapshot();
  assert.equal(after.state?.conversationId, "A", "当前会话必须原样保留");
  assert.equal(after.state, before, "state 引用都不应被换掉");
});

test("跨会话：message_delta / tool_status / run_start 都不污染当前视图", () => {
  const { client } = connected();
  feed(client, snapshotOf("A"));

  feed(client, { type: "message_delta", conversationId: "B", seq: 1, channel: "text", delta: "B 的流式文本" });
  feed(client, { type: "tool_status", conversationId: "B", toolCallId: "t1", toolName: "bash", phase: "start" });
  feed(client, { type: "run_start", conversationId: "B" });

  const snap = client.getSnapshot();
  assert.equal(snap.streamText, "", "后台会话的流式文本不能拼进当前视图");
  assert.deepEqual(snap.tools, [], "后台会话的工具轨迹不能混进来");
  assert.equal(snap.runActive, false, "后台会话的 run_start 不能把当前视图标成运行中");
  assert.equal(client.droppedForeignFrames, 3);
});

test("跨会话：切换会话期间只接受目标会话的快照", () => {
  const { client } = connected();
  feed(client, snapshotOf("A"));

  client.switchConversation("C");
  // 切到 C 之后、C 的快照到达之前，抢跑的后台会话 B 的快照必须被忽略。
  feed(client, snapshotOf("B"));
  assert.equal(client.getSnapshot().state, null, "等待期间不应被别的会话建立身份");

  feed(client, snapshotOf("C"));
  assert.equal(client.getSnapshot().state?.conversationId, "C", "目标会话的快照必须被接受");
});

test("修订链断裂会请求全量快照自愈（同会话）", () => {
  const { client, ws } = connected();
  feed(client, snapshotOf("A"));
  ws.sent.length = 0;

  feed(client, deltaOf("A", 9, 99)); // baseRev 与本地 rev=1 不连续

  assert.ok(
    ws.sent.some((raw) => (JSON.parse(raw) as { type: string }).type === "get_state"),
    "链断裂必须请求全量快照，否则会长期显示旧内容",
  );
});

/* ─────────────────── 思维链与离线 ─────────────────── */

test("快照回填 streamThinking（思维链不丢半截）", () => {
  const { client } = connected();
  feed(client, snapshotOf("A"));
  feed(client, { type: "message_delta", conversationId: "A", seq: 1, channel: "thinking", delta: "先想第一步" });
  assert.equal(client.getSnapshot().streamThinking, "先想第一步");

  // 流式过程中到达全量快照：思维链必须从 streamingMessage 回填（以前这里置空 → 闪断）。
  feed(
    client,
    snapshotOf("A", {
      isStreaming: true,
      streamingMessage: { role: "assistant", text: "部分文本", thinking: "先想第一步再说" },
    }),
  );
  assert.equal(client.getSnapshot().streamThinking, "先想第一步再说", "思维链不能被清零");
  assert.equal(client.getSnapshot().streamText, "部分文本");
});

test("离线时 send 返回 false、给出提示，且不擅自清空视图", () => {
  installGlobals();
  FakeWebSocket.instances = [];
  const client = new PiWsClient(); // 不 connect：没有 socket
  feed(client, snapshotOf("A"));

  assert.equal(client.send({ type: "abort" }), false);

  // newConversation 也走 send：发送失败时不能清空本地视图。
  client.newConversation();
  assert.equal(client.getSnapshot().state?.conversationId, "A", "离线切换失败不应清空视图");
  assert.ok(
    client.getSnapshot().notices.some((n) => n.text.includes("尚未连接")),
    "离线发消息必须给用户反馈，而不是静默丢弃",
  );
});
