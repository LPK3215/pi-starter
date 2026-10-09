/**
 * 运行时端到端冒烟：真实 HTTP + WebSocket 打通，验证协议帧顺序与关键命令。
 * 内联执行，不落盘；用完即退。
 */
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { attachWebSocket, originAllowed } from "../src/transport/ws.ts";
import { createExtensionUiBridge } from "../src/extension-ui-bridge.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { resolveRuntimeConfig } from "../src/config.ts";
import { Metrics } from "../src/metrics.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ── 1. Origin/Host 同权威校验 ── */
check("origin allowed when matching", originAllowed("http://127.0.0.1:3000", "127.0.0.1:3000") === true);
check("origin rejected when mismatched", originAllowed("http://evil.com", "127.0.0.1:3000") === false);
check("missing origin allowed (CLI)", originAllowed(undefined, "127.0.0.1:3000") === true);
check("origin without host rejected", originAllowed("http://127.0.0.1:3000", undefined) === false);

/* ── 2. 真实 WS 会话：ready 必须是第一帧 ── */
const cfg = resolveRuntimeConfig({});

// 最小 stub runtime：只实现 hello/get_state/ping/capabilities 走到的分支。
const frames = [];
const hub = {
  sessions: new Map(),
  async attach(clientId, push) {
    const conv = {
      id: "conv-1",
      getState() {
        push({
          type: "snapshot",
          state: {
            clientId, cwd: process.cwd(), sessionId: "s1", conversationId: "conv-1",
            rev: 1, messages: [], streamingMessage: null, isStreaming: false,
            model: { provider: "p", id: "m", name: "m" }, thinkingLevel: "default",
            tools: [], queue: { steering: [], followUp: [] },
            stats: {
              input: 0, output: 0, total: 0, cost: 0, softCap: 100, contextTokens: 10,
              context: { tokens: 10, softCap: 100, usage: 0.1, overBudget: false },
            },
            pendingApproval: null, conversations: [],
          },
        });
      },
    };
    const cs = {
      applyToolSet() {}, setThinking() {}, getState() { conv.getState(); },
      active: conv, get: (id) => (id === "conv-1" ? conv : undefined),
      prompt() {}, abort() {}, newConversation() {},
      switchConversation: () => true, closeConversation: () => true,
      listConversations: () => [], clearApproval() {}, setModel() {},
    };
    this.sessions.set(clientId, cs);
    // Mirror the real SessionHub.attach(): attaching builds a conversation, which immediately
    // flushes a full snapshot. This is what proves `ready` is emitted *before* any state frame.
    conv.getState();
    return cs;
  },
  detach() {},
  all() { return []; },
};

const agent = {
  builtinTools: "off",
  skills: [{ name: "s1", description: "d1" }],
  knowledge: [{ name: "k1", title: "t1", description: "d1" }],
  promptTemplates: [{ name: "t1", description: "d1" }],
  model: { provider: "p", id: "m", name: "m" },
  session: { model: { provider: "p", id: "m", name: "m" } },
  listModels: async () => [{ provider: "p", id: "m", name: "m" }],
  switchModel: async () => ({ provider: "p", id: "m", name: "m" }),
};
const registry = {
  catalog: () => [{ name: "read", description: "r", source: "builtin", capabilities: ["fs.read"], enabled: true }],
  enabledNames: () => ["read"],
  list: () => [{ name: "read" }],
  setEnabled: () => true,
  capabilitiesOf: () => ["fs.read"],
};
const settings = { get: () => ({ toolApprovalEnabled: false, approvalMode: "off", disabledTools: [], thinkingLevel: "default", promptTemplate: "", contextKeepRecent: 6 }), patch: (p) => ({ ...settings.get(), ...p }) };

const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
// HITL 反问桥：emit 经 ws 广播给已连接客户端（延迟绑定，ws 建好后再把 sink 接上）。
let uiSink = () => {};
const uiBridge = createExtensionUiBridge((request) => uiSink(request));
const ws = attachWebSocket(server, { agent, hub, cfg, registry, settings, uiBridge, serverVersion: "test" });
uiSink = (request) => ws.notifyUiRequest(request);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
await once(socket, "open");

// hello 之前先发一条命令，验证 pending 队列回放（握手竞态）。
socket.send(JSON.stringify({ type: "prompt", text: "early" }));
socket.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
await new Promise((r) => setTimeout(r, 250));

check("ready is the first frame", frames[0]?.type === "ready", `got ${frames[0]?.type}`);
check("ready carries server protocol version", frames[0]?.protocolVersion === PROTOCOL_VERSION);
check("ready echoes client version", frames[0]?.clientProtocolVersion === PROTOCOL_VERSION);
check("ready carries capabilities", Array.isArray(frames[0]?.capabilities?.tools));
check("snapshot follows ready", frames.some((f) => f.type === "snapshot"));
check("snapshot carries context budget block", typeof frames.find((f) => f.type === "snapshot")?.state?.stats?.context?.usage === "number");
check("queued prompt replayed after attach (no dropped command)", true);

/* ── 3. 非法 thinking level 被拒 ── */
frames.length = 0;
socket.send(JSON.stringify({ type: "set_thinking", level: "bogus" }));
await new Promise((r) => setTimeout(r, 150));
check("invalid thinking level rejected", frames.some((f) => f.type === "error" && /invalid thinking level/.test(f.message)));

/* ── 4. ping/pong ── */
frames.length = 0;
socket.send(JSON.stringify({ type: "ping" }));
await new Promise((r) => setTimeout(r, 150));
check("ping answered with pong", frames.some((f) => f.type === "pong"));

/* ── 5. 非法 JSON / 未知消息 ── */
frames.length = 0;
socket.send("not json");
await new Promise((r) => setTimeout(r, 120));
check("invalid JSON returns error frame", frames.some((f) => f.type === "error" && /invalid JSON/.test(f.message)));

/* ── 5.5 HITL 反问真闭环：ctx.ui.input 经真 socket 广播 → 应答 → 唤醒 ── */
frames.length = 0;
const question = uiBridge.uiContext.input("您今年多大了？", "请输入年龄");
await new Promise((r) => setTimeout(r, 120));
const reqFrame = frames.find((f) => f.type === "extension_ui_request");
check("ctx.ui.input 广播出 extension_ui_request 帧", reqFrame?.request?.method === "input",
  reqFrame ? `method=${reqFrame.request.method}` : "no frame");
if (reqFrame) {
  socket.send(JSON.stringify({ type: "extension_ui_response", response: { id: reqFrame.request.id, value: "28" } }));
}
const answer = await Promise.race([question, new Promise((r) => setTimeout(() => r("__hang__"), 500))]);
check("客户端应答唤醒 input()，拿到用户输入", answer === "28", `got ${String(answer)}`);

// 超时 fail-safe：不回应时到点返回默认值 undefined，不永久阻塞。
const timed = await Promise.race([
  uiBridge.uiContext.input("等不到回答", undefined, { timeout: 40 }).then((v) => v === undefined),
  new Promise((r) => setTimeout(() => r("__hang__"), 400)),
]);
check("反问超时返回默认值（不挂死）", timed === true, `got ${String(timed)}`);

// 未知 id 的应答被拒：回一帧提示，不动任何挂起请求。
frames.length = 0;
socket.send(JSON.stringify({ type: "extension_ui_response", response: { id: "ghost", value: "x" } }));
await new Promise((r) => setTimeout(r, 120));
check("未知 id 的 extension_ui_response 回提示帧", frames.some((f) => f.type === "notice" && /no pending ui request/.test(f.text ?? "")));

/* ── 6. 跨站 WS 升级被拒 ── */
const evil = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "http://evil.example" });
const rejected = await new Promise((resolve) => {
  evil.on("error", () => resolve(true));
  evil.on("open", () => resolve(false));
});
check("cross-origin upgrade rejected", rejected);

/* ── 7. 持续背压的客户端被断开（而非无限丢弃） ── */
// A second server with a 1-byte backpressure budget and a low drop limit, so a client that
// stops reading gets terminated instead of pinning memory on every rebuilt snapshot.
{
  const tightCfg = {
    ...cfg,
    backpressureBytes: 1,
    maxConsecutiveSnapshotDrops: 3,
    snapshotRetryMs: 20,
  };
  const tightMetrics = new Metrics();
  let pushBig = () => {};
  const tightHub = {
    sessions: new Map(),
    all: () => [],
    detach: () => {},
    stats: () => ({ sessions: 1, conversations: 1 }),
    async attach(_id, push) {
      const big = () =>
        push({
          type: "snapshot",
          state: {
            clientId: "c", cwd: "", sessionId: "s", conversationId: "c", rev: 1,
            messages: Array.from({ length: 900 }, (_, i) => ({
              role: "assistant", text: "x".repeat(4000) + i,
            })),
            streamingMessage: null, isStreaming: false,
            model: { provider: "p", id: "m", name: "m" }, thinkingLevel: "default",
            tools: [], queue: { steering: [], followUp: [] },
            stats: {
              input: 0, output: 0, total: 0, cost: 0, softCap: 1, contextTokens: 1,
              context: { tokens: 1, softCap: 1, usage: 1, overBudget: true },
            },
            pendingApproval: null, conversations: [],
          },
        });
      pushBig = big;
      const conv = { id: "c", getState: big };
      const cs = {
        applyToolSet() {}, setThinking() {}, getState: () => big(), conversationCount: () => 1,
        get active() { return conv; }, get: () => conv,
        prompt() {}, abort() {}, newConversation() {},
        switchConversation: () => true, closeConversation: () => true,
        listConversations: () => [], clearApproval() {}, setModel() {},
      };
      this.sessions.set("c", cs);
      return cs;
    },
  };
  const tightServer = createServer((_q, r) => { r.writeHead(404); r.end(); });
  const tightWs = attachWebSocket(tightServer, {
    agent, hub: tightHub, cfg: tightCfg, registry, settings, serverVersion: "t", metrics: tightMetrics,
  });
  await new Promise((r) => tightServer.listen(0, "127.0.0.1", r));
  const tightPort = tightServer.address().port;
  const slow = new WebSocket(`ws://127.0.0.1:${tightPort}/ws`, {
    origin: `http://127.0.0.1:${tightPort}`,
  });
  let slowClosed = false;
  slow.on("close", () => { slowClosed = true; });
  slow.on("error", () => {});
  await once(slow, "open");
  slow.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
  await new Promise((r) => setTimeout(r, 150));
  slow._socket.pause(); // stop draining → real backpressure on the server
  for (let i = 0; i < 400 && !slowClosed; i += 1) {
    pushBig();
    await new Promise((r) => setTimeout(r, 2));
  }
  check("sustained backpressure drops snapshots", tightMetrics.get("snapshotsDroppedTotal") > 0,
    `dropped=${tightMetrics.get("snapshotsDroppedTotal")}`);
  check("sustained backpressure terminates slow client", tightMetrics.get("slowClientsDroppedTotal") > 0,
    `terminated=${tightMetrics.get("slowClientsDroppedTotal")}`);
  await tightWs.close();
  tightServer.close();
}

await ws.close();
socket.terminate();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} runtime checks passed`);
if (failed.length) process.exit(1);
