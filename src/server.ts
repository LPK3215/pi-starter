/**
 * pi-starter · Web 入口
 *
 * 运行：npm run web
 * 解析命令行、组装 Agent、起 HTTP + WebSocket、listen。
 *
 *   npm run web -- --port 8080 --model zhipu/glm-4.5-air
 *   npm run web -- --builtin-tools coding
 *
 * 装配顺序（审批闸门需要「先建、后绑定」的引用，故用可变 holder 传递）：
 *   settings → rules → gate → buildAgent(带审批扩展) → registry → hub → app/http → ws
 */

import { createServer } from "node:http";
import { buildAgent } from "./agent.js";
import { createApp } from "./app.js";
import { parseCliFlags } from "./cli-args.js";
import {
  CODING_BUILTIN_TOOLS,
  READONLY_BUILTIN_TOOLS,
  describeBuiltinToolMode,
  resolveRuntimeConfig,
} from "./config.js";
import { createSessionHub } from "./session-hub.js";
import { BUILTIN_TOOL_NAMES, createToolRegistry, defineToolSpec, type ToolRegistry } from "./tools/registry.js";
import { allTools } from "./tools/index.js";
import { SettingsService, fileSettingsPort, defaultSettingsFile } from "./settings.js";
import {
  ApprovalRulesStore,
  loadApprovalRulesFromFile,
  saveApprovalRulesToFile,
} from "./approval/rules.js";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { FileService } from "./files/service.js";
import { ApprovalGate, approvalExtension } from "./approval/gate.js";
import { attachWebSocket, type WsServer } from "./transport/ws.js";
import { applyServerTimeouts } from "./http/hardening.js";
import { getLogger } from "./log.js";
import type { UiApproval } from "./protocol.js";

const SERVER_VERSION = "0.1.0";

const flags = parseCliFlags(process.argv.slice(2));
const PORT = flags.port ?? 3000;
const runtime = resolveRuntimeConfig();
const logger = getLogger();

// No authentication is built in (by design, for a local scaffold). Binding anywhere but
// loopback therefore exposes the agent and its tools to the network — warn loudly.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
if (!LOOPBACK.has(runtime.host)) {
  logger.warn("PI_HOST 绑定了非 loopback 地址，而本服务没有任何鉴权", {
    host: runtime.host,
    hint: "请放在自己的鉴权代理之后，或改回 127.0.0.1",
  });
}

logger.info("正在组装 agent...");

// 1. Settings + approval rules + gate (needed before the agent is built).
// Both persist to the agent dir so a restart keeps the user's configuration; corrupt or
// unreadable files fall back to defaults rather than taking the whole service down.
const settings = new SettingsService(
  fileSettingsPort(defaultSettingsFile(), {
    logger: (msg, err) => logger.warn(msg, { detail: err instanceof Error ? err.message : String(err) }),
  }),
);
const rulesFile = join(getAgentDir(), "pi-starter-approval-rules.json");
const rulesStore = loadApprovalRulesFromFile(rulesFile, {
  logger: (msg, err) => logger.warn(msg, { detail: err instanceof Error ? err.message : String(err) }),
});

// The WS server does not exist yet; route approval requests through a mutable holder.
// The holder receives the owning conversation key (= the SDK sessionId, which is also the
// Conversation id) so the request can be surfaced on the *right* conversation snapshot.
const approvalSink: { handler: (key: string, request: UiApproval) => void } = {
  handler: () => {
    /* replaced once the WS server is attached */
  },
};
const gate = new ApprovalGate({
  rules: () => rulesStore.rules(),
  enabled: () => settings.get().toolApprovalEnabled,
  // New conversations inherit the configured mode instead of a hardcoded "off".
  defaultPolicy: () => ({
    mode: settings.get().approvalMode,
    categories: [],
  }),
  onRequest: (key, request) => approvalSink.handler(key, request),
});

// The registry is built after the agent; expose it to the approval extension via a holder.
let registryRef: ToolRegistry | undefined;

// 2. Build the agent, wiring the approval gate as an extension.
const agent = await buildAgent({
  provider: flags.provider,
  modelId: flags.model,
  builtinTools: flags.builtinTools,
  inMemory: true,
  // Honour settings.promptTemplate (empty → default order, identical to before).
  promptTemplate: settings.get().promptTemplate,
  extraExtensions: [
    approvalExtension(gate, {
      // Each conversation wraps exactly one session, and Conversation.id === session.sessionId.
      // Keying by the SDK session id scopes "remember this choice" to the conversation that raised
      // it instead of leaking it to every conversation. NOTE: the SDK's ExtensionContext exposes
      // the id via `sessionManager.getSessionId()` — there is no `ctx.sessionId` field, so the
      // default key resolver in approvalExtension() reads it from there.
      capabilitiesOf: (toolName) => registryRef?.capabilitiesOf(toolName) ?? [],
    }),
  ],
});

// 3. Tool registry: builtin (per active policy) + custom + dynamic.
const activeBuiltin: readonly string[] =
  agent.builtinTools === "coding"
    ? CODING_BUILTIN_TOOLS
    : agent.builtinTools === "readonly"
      ? READONLY_BUILTIN_TOOLS
      : ["read"];
const registry = createToolRegistry({
  builtinTools: BUILTIN_TOOL_NAMES,
  customTools: allTools,
  // Disabled = tools excluded by the active policy + any persisted per-tool opt-outs.
  disabled: [
    ...BUILTIN_TOOL_NAMES.filter((name) => !activeBuiltin.includes(name)),
    ...settings.get().disabledTools,
  ],
});
for (const name of [
  ...(agent.knowledge.length > 0 ? ["search_knowledge", "read_knowledge"] : []),
  "db_status",
  "db_query",
]) {
  registry.register(
    defineToolSpec({ name, description: `dynamic tool ${name}`, source: "dynamic" }),
  );
}
registryRef = registry;

logger.info("agent 就绪", {
  model: `${agent.model.provider}/${agent.model.id}`,
  builtinTools: agent.builtinTools,
  builtinToolDetail: describeBuiltinToolMode(agent.builtinTools),
  skills: agent.skills.map((s) => s.name),
  knowledge: agent.knowledge.map((d) => d.name),
  database: { driver: agent.database.driver, path: agent.database.path },
});

// 4. Session hub + HTTP app. keepRecent / toolTimeout read lazily so settings apply live.
const hub = createSessionHub(
  agent,
  runtime,
  process.cwd(),
  () => settings.get().contextKeepRecent,
  undefined,
  () => settings.get().toolTimeoutSeconds * 1000,
);
// Gauges are derived from live state at scrape time (see /metrics) so they cannot drift.
let wsRef: WsServer | undefined;
const { app, dispose } = createApp({
  agent,
  registry,
  settings,
  // Route REST model switches through the hub so REST and WS never disagree on the model.
  hub,
  // Rate limits on by default here: `npm run web` is a long-running process, unlike a
  // one-shot CLI. Probes and static reads stay unthrottled.
  rateLimit: true,
  connectionCount: () => wsRef?.connectionCount ?? 0,
  sessionStats: () => hub.stats(),
  approvalStats: () => gate.pendingCount,
  // File service scoped to the process cwd: an Agent needs hands, and every path is
  // validated (no traversal, no symlink escape) inside FileService itself.
  files: new FileService({ root: process.cwd() }),
});
const server = createServer(app);
// 显式超时：Node 默认值对长轮次 LLM 请求偏紧，对慢速头部又偏松。
applyServerTimeouts(server);

// 5. Attach the WebSocket transport and bind the approval sink.
const ws: WsServer = attachWebSocket(server, {
  agent,
  hub,
  cfg: runtime,
  registry,
  settings,
  gate,
  serverVersion: SERVER_VERSION,
});
wsRef = ws;
approvalSink.handler = (key, request) => {
  // Surface the request on the owning conversation so the authoritative snapshot carries it
  // (a reconnecting client must be able to recover the card from `pendingApproval`), then
  // broadcast for immediate delivery to already-connected clients.
  for (const session of hub.all()) session.requestApproval(key, request);
  ws.notifyApproval(request);
};

server.listen(PORT, runtime.host, () => {
  logger.info("pi-starter web 已启动", {
    http: `http://${runtime.host}:${PORT}`,
    ws: `ws://${runtime.host}:${PORT}${runtime.wsPath}`,
    model: `${agent.model.provider}/${agent.model.id}`,
  });
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("开始优雅停机");
  // Ordered teardown: stop accepting new approvals first (gate.dispose denies in-flight
  // requests so no tool call is left hanging), then close sockets, then drop sessions.
  gate.dispose();
  // Flush rule edits before teardown so they survive the restart.
  try {
    saveApprovalRulesToFile(rulesFile, rulesStore);
  } catch (err) {
    logger.warn("审批规则保存失败", { error: err instanceof Error ? err.message : String(err) });
  }
  await ws.close();
  hub.dispose();
  dispose();
  // Hard exit fallback: if a socket refuses to close, do not hang the process forever.
  const bail = setTimeout(() => {
    logger.warn("优雅停机超时，强制退出");
    process.exit(0);
  }, 1000);
  bail.unref();
  server.close(() => {
    clearTimeout(bail);
    logger.info("已停机");
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
