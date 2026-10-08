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
import { buildAgent, type BuiltAgent } from "./agent.js";
import { createApp } from "./app.js";
import { parseCliFlags } from "./cli-args.js";
import {
  CODING_BUILTIN_TOOLS,
  READONLY_BUILTIN_TOOLS,
  describeBuiltinToolMode,
  resolveRuntimeConfig,
} from "./config.js";
import { createSessionHub, type SessionHub } from "./session-hub.js";
import { defaultSessionIndexFile, scaffoldSessionDir, sessionCatalog } from "./sessions/store.js";
import { BUILTIN_TOOL_NAMES, createToolRegistry, defineToolSpec, type ToolRegistry } from "./tools/registry.js";
import { allTools } from "./tools/index.js";
import { execRegistrySpecs } from "./tools/exec.js";
import { SettingsService, fileSettingsPort, defaultSettingsFile, sanitizeSettings } from "./settings.js";
import { createPersistentRulesStore } from "./approval/rules.js";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { FileService } from "./files/service.js";
import { ApprovalGate, approvalExtension } from "./approval/gate.js";
import { attachWebSocket, type WsServer } from "./transport/ws.js";
import { applyServerTimeouts } from "./http/hardening.js";
import { getLogger } from "./log.js";
import { createGracefulShutdown } from "./graceful.js";
import type { UiApproval } from "./protocol.js";
import { McpBridge } from "./mcp/bridge.js";
import { PlanModeController, planModeExtension } from "./modes/plan-mode.js";
import { createProviderKeyStore, defaultProviderKeysFile } from "./provider-keys.js";
import { DELEGATE_TOOL_NAME, SUBAGENT_CAPABILITY, createDelegateTool } from "./subagents/index.js";

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
    // 配置文件里的非法字段（旧版本遗留 / 手改错）只剔除并告警，不让服务起不来。
    sanitize: (raw) => {
      const { clean, dropped } = sanitizeSettings(raw);
      if (dropped.length > 0) {
        logger.warn("设置文件中的非法字段已忽略", { dropped });
      }
      return clean;
    },
  }),
);
// 装配「读盘 + 改动即落盘」的唯一入口：原先把这两步散落在装配代码里，漏掉任一步
// 就会变成「能改但重启丢」，而这种半成品从代码上完全看不出来。
const rulesStore = createPersistentRulesStore(join(getAgentDir(), "pi-starter-approval-rules.json"), {
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
// 同理：子代理工具要往每个连接推失败通知，MCP 工具要现取现用。
let hubRef: SessionHub | undefined;
let mcpRef: McpBridge | undefined;

// Web 对话落在本脚手架自己的目录，不和 pi CLI 的会话文件混放。
// inMemory 必须关掉，否则 resumeFrom 会被拒绝，恢复接不上。
const sessionDir = scaffoldSessionDir(process.cwd());
const allowedSessionRoots = [sessionDir];
const sessionIndex = sessionCatalog(
  defaultSessionIndexFile(sessionDir),
  allowedSessionRoots,
  process.cwd(),
  {
    logger: (msg, err) => logger.warn(msg, { detail: err instanceof Error ? err.message : String(err) }),
  },
);

/**
 * 计划模式状态。
 *
 * 状态按会话存，并与会话索引同目录（`plan-mode.json`）——重启后接回同一条对话时模式仍在。
 * 落盘失败只告警不阻断：模式是运行时开关，配置写不进去不该让服务起不来。
 */
const planMode = new PlanModeController({
  filePath: join(sessionDir, "plan-mode.json"),
  defaultEnabled: () => settings.get().planMode,
  logger: (msg, err) => logger.warn(msg, { detail: err instanceof Error ? err.message : String(err) }),
});

/** 多把 API 密钥：原文只在服务端的 provider-keys.json 里，任何响应都不含它。 */
const providerKeys = createProviderKeyStore(defaultProviderKeysFile(), {
  logger: (msg, err) => logger.warn(msg, { detail: err instanceof Error ? err.message : String(err) }),
});

/**
 * 派发工具的会话工厂。
 *
 * `buildAgent()` 一定提供 `createSession`，但这一步在它**返回之前**求值，
 * 所以只能延迟取：这里返回的函数会在第一次真正派发时才读到已建好的 agent。
 */
const subagentFactory = (): NonNullable<BuiltAgent["createSession"]> => {
  const factory = agent.createSession;
  if (!factory) throw new Error("当前装配没有独立会话工厂，无法派发子代理");
  return factory;
};

// 2. Build the agent, wiring the approval gate as an extension.
const agent = await buildAgent({
  provider: flags.provider,
  modelId: flags.model,
  builtinTools: flags.builtinTools,
  inMemory: false,
  // 内置示例内容可关：接自己知识库/技能时，关掉才不会被写进系统提示词。
  // 这两个设置改动需要重启（见 ws.ts 的 set_settings 提示）。
  builtinKnowledge: settings.get().builtinKnowledge,
  builtinSkills: settings.get().builtinSkills,
  sessionDir,
  allowedSessionRoots,
  // Honour settings.promptTemplate (empty → default order, identical to before).
  promptTemplate: settings.get().promptTemplate,
  // MCP 工具在建会话的那一刻求值（见 agent.ts 的 resolveToolList）：SDK 的工具白名单在
  // 构造时固定，传静态数组会把开机那一刻连上的服务器 forever 冻住，之后改配置一律无效。
  dynamicTools: () => mcpRef?.toolDefinitions() ?? [],
  extraTools: [
    createDelegateTool({
      createSession: async () => subagentFactory()(),
      notify: (level, text) => {
        for (const session of hubRef?.all() ?? []) session.notify(level, text);
      },
    }),
  ],
  extraExtensions: [
    approvalExtension(gate, {
      // Each conversation wraps exactly one session, and Conversation.id === session.sessionId.
      // Keying by the SDK session id scopes "remember this choice" to the conversation that raised
      // it instead of leaking it to every conversation. NOTE: the SDK's ExtensionContext exposes
      // the id via `sessionManager.getSessionId()` — there is no `ctx.sessionId` field, so the
      // default key resolver in approvalExtension() reads it from there.
      capabilitiesOf: (toolName) => registryRef?.capabilitiesOf(toolName) ?? [],
    }),
    planModeExtension(planMode, {
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
registry.register(
  defineToolSpec({
    name: DELEGATE_TOOL_NAME,
    description: "派发子代理执行一个自包含的子任务并取回结论",
    source: "dynamic",
    // `shell` 是有意的：子代理能在自己的会话里跑 shell / 写文件，所以计划模式也必须
    // 拦住派发本身，否则「只规划不实施」会被一次 delegate 绕过。风险等级随之取 high。
    capabilities: [SUBAGENT_CAPABILITY, "shell"],
    risk: "high",
    origin: "subagent",
  }),
);
// coding 档的 exec 不在 allTools 里（否则 off 也会放行）。注册表必须有它们：
// 客户端 hello 时会用 enabledNames() 覆盖会话的激活集，漏登记等于工具被当场关掉。
if (agent.builtinTools === "coding") {
  registry.registerAll(execRegistrySpecs());
}
registryRef = registry;

/** MCP 桥：配置改动即生效（新增连接 / 断开移除 / 命令变更重连），无需重启。 */
const mcp = new McpBridge({
  servers: () => settings.get().mcpServers,
  registry,
  onChange: (status) => {
    const ready = status.filter((item) => item.ready);
    for (const session of hubRef?.all() ?? []) {
      session.notify(
        "info",
        `外部工具已更新：${ready.length}/${status.length} 个 MCP 服务器就绪（${ready
          .map((item) => `${item.name}:${item.toolCount}`)
          .join("，") || "无"}）`,
      );
    }
  },
});
mcpRef = mcp;
// 改设置就重算 MCP 集合。挂在 SettingsService 的变更回调上，而不是在每个写入点手写：
// 漏一处（只改了 REST 或只改了 WS）的表现是「配置生效了但工具没变」，从代码上看不出来。
settings.setOnChange(() => {
  void mcp.sync().catch((err: unknown) => {
    logger.warn("MCP 同步失败", { error: err instanceof Error ? err.message : String(err) });
  });
});

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
  allowedSessionRoots,
  sessionIndex,
  // 计划模式状态挂在 hub 上，由每个 Conversation 按会话 id 查；
  // 不传则该装配没有计划模式（Conversation.planMode 恒为 false）。
  { planMode },
);
hubRef = hub;
// Gauges are derived from live state at scrape time (see /metrics) so they cannot drift.
let wsRef: WsServer | undefined;
const { app, dispose, addDisposer } = createApp({
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
  // 规则编辑接口：改完立刻落盘（见 rulesStore.setOnChange 的说明）。
  approvalRules: rulesStore,
  providerKeys,
  /**
   * 换激活密钥后必须经 hub 重新应用模型：直接改运行时凭据的话，REST 会说「已激活 B」，
   * 而每个对话仍在用A 跑，而且不会有任何报错。
   */
  applyActiveKey: async (provider) => {
    const apiKey = providerKeys.resolve(provider);
    if (!apiKey) return;
    if (!agent.applyApiKey) {
      throw new Error("当前装配不支持运行期换 key，请重启后再试");
    }
    await agent.applyApiKey(provider, apiKey);
    await hub.setModel(`${agent.model.provider}/${agent.model.id}`);
  },
});
// 子进程回收必须挂到停机链上：漏掉就是每次重启泄漏一批 stdio 子进程。
addDisposer(() => mcp.dispose());
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
  // Log the **actual** bound port, not the requested one. They differ whenever `--port 0`
  // is used (let the OS pick), and the requested value is then literally 0 — a log line
  // that tells you "ws://127.0.0.1:0/ws" is worse than useless, and callers that pass 0
  // (the E2E harness, container schedulers) have no other way to learn the real port.
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : PORT;
  logger.info("pi-starter web 已启动", {
    http: `http://${runtime.host}:${boundPort}`,
    ws: `ws://${runtime.host}:${boundPort}${runtime.wsPath}`,
    model: `${agent.model.provider}/${agent.model.id}`,
  });
  // Connect configured MCP servers after listen, so a slow or broken third-party server
  // delays neither startup nor the first prompt. Failures are reported per-server and the
  // rest still load — one bad command must not take the whole bridge down.
  void mcp.sync().catch((err: unknown) => {
    logger.warn("MCP 初始同步失败", { error: err instanceof Error ? err.message : String(err) });
  });
});

// Ordered teardown: stop accepting new approvals first (gate.dispose denies in-flight
// requests so no tool call is left hanging), then close sockets, then drop sessions.
// The ordering and the bail-timer placement live in `graceful.ts` (unit-tested there);
// a step that throws must not prevent the remaining cleanup or the exit.
const shutdown = createGracefulShutdown({
  steps: [
    { name: "approval-gate", run: () => gate.dispose() },
    { name: "websocket", run: () => ws.close() },
    { name: "session-hub", run: () => hub.dispose() },
    { name: "app", run: () => dispose() },
  ],
  closeServer: () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Keep-alive connections from pooled HTTP clients would otherwise hold the listener
      // open. Idle ones are safe to drop now; the request in flight (if any) still finishes.
      server.closeIdleConnections?.();
    }),
  logger,
});

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
