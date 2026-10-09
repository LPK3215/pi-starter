/**
 * 前端链路探针：从 Vite dev server 的 /ws 代理进后端，验证
 * hello → ready → conversations → snapshot 首帧顺序，以及 message_delta 流式增量。
 * 用途是"改完立刻能看出对接断了没"，不依赖浏览器。
 */
// Vite dev 默认只绑 localhost（::1），用 127.0.0.1 连会被拒；直连后端再传 PI_WS。
const URL = process.env.PI_WS ?? "ws://localhost:5173/ws";
const seen = [];
const sock = new WebSocket(URL);
const timer = setTimeout(() => finish("超时未完成一轮"), 60000);

function finish(reason) {
  clearTimeout(timer);
  const types = seen.map((m) => m.type);
  console.log("帧序列:", types.join(" → "));
  const ready = seen.find((m) => m.type === "ready");
  const first = seen.find((m) => m.type === "snapshot");
  const snap = seen.filter((m) => m.type === "snapshot").at(-1);
  console.log("ready:", ready ? { clientId: ready.clientId?.slice(0, 8), protocolVersion: ready.protocolVersion, serverVersion: ready.serverVersion, tools: ready.capabilities.tools.length } : "缺失");
  console.log("snapshot(首帧):", first ? { conversationId: first.state.conversationId?.slice(0, 8), messages: first.state.messages.length, model: `${first.state.model.provider}/${first.state.model.id}`, isStreaming: first.state.isStreaming } : "缺失");
  console.log("流式增量帧:", types.filter((t) => t === "message_delta").length, "段");
  // 后端权威的逐条消息摘要：用来分辨"空 assistant 气泡"是前端渲染问题还是快照本来就没文本。
  console.log(
    "消息列表:",
    (snap?.state.messages ?? []).map((m, i) => `#${i} ${m.role} len=${m.text.length}${m.entryId ? " " + m.entryId.slice(0, 8) : ""}`).join(" | ") || "（空）",
  );
  const lastAssistant = snap?.state.messages.filter((m) => m.role === "assistant").pop();
  console.log("最终回复:", lastAssistant ? lastAssistant.text.slice(0, 120) : "（无 assistant 消息）");
  // 后端算出来的计量：前端「费用」直接显示 0 时，先看这里的原始值再定是不是前端的锅。
  console.log("stats:", snap ? { input: snap.state.stats.input, output: snap.state.stats.output, cost: snap.state.stats.cost, contextTokens: snap.state.stats.contextTokens } : "缺失");
  console.log("结论:", ready && snap && types.indexOf("ready") === 0 ? "OK · 握手与快照链路通" : `FAIL · ${reason}`);
  sock.close();
  process.exit(ready && snap && types.indexOf("ready") === 0 ? 0 : 1);
}

sock.addEventListener("open", () => {
  sock.send(JSON.stringify({ type: "hello", protocolVersion: 1 }));
});
sock.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  seen.push(msg);
  if (msg.type === "ready") {
    sock.send(JSON.stringify({ type: "prompt", text: process.env.PI_PROMPT ?? "只回复四个字：对接成功" }));
  }
  if (msg.type === "run_end" && msg.willRetry !== true) finish("run_end");
  if (msg.type === "error") console.log("后端报错帧:", msg.message);
});
sock.addEventListener("error", (e) => {
  console.log("WS 错误:", e.message ?? e);
  finish("连接错误");
});
