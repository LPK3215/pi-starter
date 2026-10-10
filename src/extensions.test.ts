/**
 * 扩展点测试：业务方能否在不碰内核的前提下接入。
 *
 * 这层是脚手架的立项目标所在——业务逻辑经接口注入。曾经的实际情况是：
 *   - HTTP：业务方挂的路由排在错误处理器之后 → 密码/路径/堆栈原样返回客户端；
 *   - WS：dispatch 是封闭 switch → 业务方命令落入 default **静默无响应**。
 * 两者都是「脚手架自己受益、业务方受害」的静默陷阱。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createApp } from "./app.js";
import { AppError, notFound } from "./errors.js";
import { attachWebSocket, defineCommand, type WsCommandRegistry } from "./transport/ws.js";
import { listenExistingServer, waitFor } from "./test-server.js";
import { SessionHub } from "./session-hub.js";
import { resolveRuntimeConfig } from "./config.js";
import { PROTOCOL_VERSION, type ServerMessage } from "./protocol.js";
import { Metrics } from "./metrics.js";
import { createToolRegistry } from "./tools/registry.js";
import { SettingsService } from "./settings.js";
import type { BuiltAgent } from "./agent.js";
import type { Model } from "@earendil-works/pi-ai";

/* ────────────────────── 遵守 SDK 契约的最小 session 替身 ────────────────────── */

class FakeSession {
  messages: Array<{ role: string; content: string; timestamp: number }> = [];
  thinkingLevel = "default";
  isStreaming = false;
  activeTools = ["read"];
  private listeners = new Set<(e: Record<string, unknown>) => void>();
  constructor(readonly sessionId: string, public model: Model<any>) {}
  subscribe(l: (e: Record<string, unknown>) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  getSessionStats() {
    return {
      sessionFile: undefined, sessionId: this.sessionId,
      userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0,
      totalMessages: this.messages.length,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0,
    };
  }
  getActiveToolNames() { return [...this.activeTools]; }
  setActiveToolsByName(n: string[]) { this.activeTools = [...n]; }
  getSteeringMessages() { return [] as readonly string[]; }
  getFollowUpMessages() { return [] as readonly string[]; }
  setThinkingLevel(l: string) { this.thinkingLevel = l; }
  async setModel(m: Model<any>) { this.model = m; }
  async prompt(t: string) { this.messages.push({ role: "user", content: t, timestamp: 1 }); }
  async abort() { this.isStreaming = false; }
  dispose() { this.listeners.clear(); }
}

function makeAgent(): BuiltAgent {
  const model = { provider: "test", id: "m1", name: "M1", contextWindow: 1000 } as never;
  const sessions: FakeSession[] = [];
  const shared = new FakeSession("sess-0", model);
  sessions.push(shared);
  let seq = 0;
  return {
    session: shared,
    get model() { return sessions[0]!.model as Model<any>; },
    builtinTools: "off" as const,
    skills: [], knowledge: [], promptTemplates: [],
    database: {
      driver: "sqlite", path: ":memory:",
      ping: () => ({ ok: true as const, driver: "sqlite", path: ":memory:" }),
      listNotes: () => [], getNote: () => undefined, searchNotes: () => [],
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
    dispose: () => { for (const s of sessions) s.dispose(); },
  } as never;
}


/** 起一套真实的 HTTP + WS，业务命令通过 commands 注入。 */
async function start(commands?: WsCommandRegistry) {
  const agent = makeAgent();
  const cfg = resolveRuntimeConfig();
  const hub = new SessionHub(agent, cfg);
  const settings = new SettingsService();
  const { app, seal } = createApp({
    agent,
    registry: createToolRegistry({ builtinTools: ["read"] }),
    settings,
    hub: hub as never,
    // 扩展点：业务路由在错误处理器之前注入。
    configure: (a) => {
      a.get("/biz/ok", (_q, r) => { r.json({ ok: true }); });
      a.get("/biz/typed", (_q, _r) => { throw notFound("没有这个东西"); });
      a.get("/biz/internal", (_q, _r) => {
        throw new AppError("internal", "数据库密码是 hunter2，路径 D:\\secret\\db.sqlite");
      });
      a.get("/biz/async", async () => {
        throw new AppError("internal", "异步路由泄漏内部细节");
      });
    },
  });
  // 第二种用法：先拿到 app 加路由，再 seal()。
  app.get("/biz/sealed", (_q, _r) => { throw new AppError("internal", "seal 之后也必须被翻译"); });
  seal();

  const server: Server = createServer(app);
  const ws = attachWebSocket(server, {
    agent, hub, cfg,
    registry: createToolRegistry({ builtinTools: ["read"] }),
    settings,
    serverVersion: "test",
    metrics: new Metrics(),
    commands,
    slashCommands: commands
      ? [{ name: "/biz", description: "业务斜杠命令" }]
      : undefined,
  });
  const listener = await listenExistingServer(server);
  const port = listener.port;
  const base = listener.url;

  const frames: ServerMessage[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: base });
  socket.on("message", (d) => frames.push(JSON.parse(d.toString("utf8")) as ServerMessage));
  socket.on("error", () => {});
  await once(socket, "open");

  return {
    base, frames, socket,
    send: (m: unknown) => socket.send(JSON.stringify(m)),
    async close() {
      socket.terminate();
      await ws.close().catch(() => undefined);
      hub.dispose();
      await listener.close();
    },
  };
}

/* ────────────────────── HTTP 扩展点 ────────────────────── */

test("扩展点：业务路由的 AppError 被统一翻译，internal 不泄漏细节", async () => {
  const h = await start();
  try {
    const typed = await fetch(`${h.base}/biz/typed`);
    const typedBody = (await typed.json()) as { error: string };
    assert.equal(typed.status, 404, "typed error must keep its status");
    assert.equal(typedBody.error, "没有这个东西", "a safe message must reach the caller");

    for (const path of ["/biz/internal", "/biz/async", "/biz/sealed"]) {
      const r = await fetch(`${h.base}${path}`);
      const text = await r.text();
      assert.equal(r.status, 500, `${path} must be 500`);
      assert.ok(!text.includes("hunter2"), `${path} leaked the secret into the response`);
      assert.ok(!text.includes("D:\\secret"), `${path} leaked an absolute path`);
      assert.ok(!text.includes("zz-"), `${path} leaked a source path / stack`);
      assert.ok(!text.includes("AppError:"), `${path} leaked the error class`);
    }
  } finally {
    await h.close();
  }
});

test("扩展点：业务路由的正常响应不受影响", async () => {
  const h = await start();
  try {
    const r = await fetch(`${h.base}/biz/ok`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  } finally {
    await h.close();
  }
});

/* ────────────────────── WS 扩展点 ────────────────────── */

test("扩展点：业务方注册的 WS 命令被正确执行", async () => {
  const h = await start({
    biz_sum: defineCommand<{ a: number; b: number }>({
      describe: "把两个数相加",
      handler: ({ payload, send }) => {
        send({ type: "notice", level: "info", text: `sum=${payload.a + payload.b}` });
      },
    }),
  });
  try {
    h.send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    await waitFor(() => h.frames.some((f) => f.type === "ready"), "ready");
    h.send({ type: "biz_sum", a: 2, b: 40 });
    await waitFor(() => h.frames.some((f) => f.type === "notice"), "自定义命令的 notice 回帧");

    const notice = h.frames.find((f) => f.type === "notice") as { text: string } | undefined;
    assert.ok(notice, "the custom command must produce a reply");
    assert.equal(notice!.text, "sum=42");
  } finally {
    await h.close();
  }
});

test("扩展点：未注册的 WS 命令明确报错，不再静默", async () => {
  const h = await start({
    biz_sum: { handler: () => {} },
  });
  try {
    h.send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    await waitFor(() => h.frames.some((f) => f.type === "ready"), "ready");
    h.frames.length = 0;
    h.send({ type: "biz_nope", x: 1 });
    await waitFor(() => h.frames.some((f) => f.type === "error"), "未注册命令的 error 回帧");

    const err = h.frames.find((f) => f.type === "error") as { message: string } | undefined;
    assert.ok(err, "an unknown command MUST get an explicit error frame");
    assert.match(err!.message, /unknown command: biz_nope/);
    assert.match(err!.message, /biz_sum/, "the reply should list what is registered");
  } finally {
    await h.close();
  }
});

test("扩展点：业务命令抛错不会杀掉连接", async () => {
  const h = await start({
    biz_boom: {
      handler: () => {
        throw new Error("业务处理失败");
      },
    },
  });
  try {
    h.send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    await waitFor(() => h.frames.some((f) => f.type === "ready"), "ready");
    h.send({ type: "biz_boom" });
    await waitFor(() => h.frames.some((f) => f.type === "error"), "命令失败的 error 回帧");
    h.send({ type: "ping" });
    await waitFor(() => h.frames.some((f) => f.type === "pong"), "失败后的 pong");

    const err = h.frames.find((f) => f.type === "error") as { message: string } | undefined;
    assert.ok(err, "the failure must surface as an error frame");
    assert.match(err!.message, /业务处理失败/);
    assert.ok(
      h.frames.some((f) => f.type === "pong"),
      "the connection must stay usable after a failing command",
    );
    assert.equal(h.socket.readyState, WebSocket.OPEN);
  } finally {
    await h.close();
  }
});

test("扩展点：自定义命令不能覆盖内置命令", async () => {
  // 注册一个与内置同名的处理器：内置行为必须获胜（否则协议行为不可预测）。
  const h = await start({
    ping: { handler: ({ send }) => send({ type: "notice", level: "info", text: "hijacked" }) },
    prompt: { handler: () => { throw new Error("hijacked"); } },
  });
  try {
    h.send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    await waitFor(() => h.frames.some((f) => f.type === "ready"), "ready");
    h.frames.length = 0;
    h.send({ type: "ping" });
    // 等 pong 而不是等固定时长：全量并发时消息处理会变慢，固定 sleep 会偶发失败。
    await waitFor(() => h.frames.some((f) => f.type === "pong"), "内置 ping 的 pong");

    assert.ok(
      h.frames.some((f) => f.type === "pong"),
      "the built-in ping must still answer with pong",
    );
    assert.ok(
      !h.frames.some((f) => f.type === "notice" && f.text === "hijacked"),
      "a registered command must never shadow a built-in one",
    );
  } finally {
    await h.close();
  }
});

test("扩展点：注册的资源随 dispose / close 一起回收", async () => {
  const agent = makeAgent();
  const cfg = resolveRuntimeConfig();
  const hub = new SessionHub(agent, cfg);
  const settings = new SettingsService();
  const { app, addDisposer, dispose } = createApp({
    agent,
    registry: createToolRegistry({ builtinTools: ["read"] }),
    settings,
    hub: hub as never,
  });
  const server: Server = createServer(app);
  const ws = attachWebSocket(server, {
    agent, hub, cfg,
    registry: createToolRegistry({ builtinTools: ["read"] }),
    settings,
    serverVersion: "test",
    metrics: new Metrics(),
  });
  const lifecycleListener = await listenExistingServer(server);

  let appDisposed = 0;
  let wsDisposed = 0;
  addDisposer(() => { appDisposed += 1; });
  addDisposer(() => { throw new Error("disposer 故意失败"); });
  addDisposer(() => { appDisposed += 1; });
  ws.addDisposer(() => { wsDisposed += 1; });

  await ws.close();
  assert.equal(wsDisposed, 1, "the WS disposer must run on close");

  dispose();
  assert.equal(appDisposed, 2, "both working disposers run even though one threw");

  hub.dispose();
  await lifecycleListener.close();
});

test("扩展点：业务斜杠命令进入能力目录", async () => {
  const h = await start({ biz_x: { handler: () => {} } });
  try {
    h.send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    await waitFor(() => h.frames.some((f) => f.type === "ready"), "ready");
    // `ready` carries the capability catalog (get_capabilities replies with a standalone frame).
    const ready = h.frames.find((f) => f.type === "ready") as
      | { capabilities: { commands: Array<{ name: string }> } }
      | undefined;
    assert.ok(ready, "hello must deliver ready with capabilities");
    const names = ready!.capabilities.commands.map((c) => c.name);
    assert.ok(names.includes("/new"), "built-ins stay advertised");
    assert.ok(names.includes("/biz"), "the embedder command must be advertised too");
  } finally {
    await h.close();
  }
});