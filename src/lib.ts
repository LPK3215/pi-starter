/**
 * pi-starter 库入口：给二次开发 import，不含 CLI / Web 的 top-level await。
 */

export {
  buildAgent,
  listModels,
  type BuildAgentOptions,
  type BuiltAgent,
} from "./agent.js";
export { createApp, type CreateAppOptions, type CreateAppResult } from "./app.js";
export { parseCliFlags, type CliFlags } from "./cli-args.js";
export {
  BUILTIN_TOOL_MODES,
  CODING_BUILTIN_TOOLS,
  catalogFromSingle,
  describeBuiltinToolMode,
  loadConfig,
  loadEnvFile,
  parseBuiltinToolMode,
  parseModelCatalog,
  parseScopedModelRefs,
  READONLY_BUILTIN_TOOLS,
  RUNTIME_DEFAULTS,
  requireConfiguredModel,
  resolveCatalog,
  resolveDefaultModel,
  resolveRuntimeConfig,
  sessionToolPolicy,
  SETUP_HINT,
  type BuiltinToolMode,
  type ConfigOverride,
  type ResolvedConfig,
  type RuntimeConfig,
  type SessionToolPolicy,
} from "./config.js";
export {
  DEFAULT_MAX_ROWS,
  MAX_SQL_LENGTH,
  isReadOnlySql,
  openDatabase,
  openScaffoldDatabase,
  scanReadOnlySql,
  type DatabaseStore,
  type DbPing,
  type NoteRow,
  type OpenDatabaseOptions,
  type QueryResult,
  type SqlScanResult,
} from "./db/index.js";
export { allExtensions, type ExtensionFactory } from "./extensions/index.js";
export { startRpcMode } from "./rpc.js";
export {
  formatKnowledgeCatalog,
  loadKnowledgeFromDirs,
  loadScaffoldKnowledge,
  resolveKnowledgeDir,
  searchKnowledge,
  type KnowledgeDoc,
  type KnowledgeHit,
} from "./knowledge/index.js";
export {
  loadScaffoldSkills,
  loadSkillsFromDirs,
  resolveSkillPaths,
  resolveSkillsDir,
  type LoadedSkill,
} from "./skills/index.js";
export {
  loadScaffoldPromptTemplates,
  resolvePromptTemplatePaths,
  resolvePromptTemplatesDir,
  type LoadedPromptTemplate,
  type LoadPromptTemplateOptions,
} from "./prompt-templates/index.js";
export {
  formatModelChoices,
  modelDisplayName,
  resolveModelRef,
  resolveScopedModels,
  unknownModelError,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelRef,
  type ProviderCatalogEntry,
  type ResolvedModelRef,
  type ResolvedScopedModel,
  type ScopedModelRef,
} from "./models.js";
export {
  DEFAULT_API,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_NAME,
  DEFAULT_PROVIDER,
  mergeAuthJson,
  mergeModelsJson,
  setupPiAgentDir,
  apiKeyForProvider,
  type SetupOptions,
  type SetupResult,
} from "./setup.js";
export { sse, toolResultPreview, translateEvent } from "./sse.js";
export { allTools } from "./tools/index.js";
export { createReadKnowledgeTool, createSearchKnowledgeTool } from "./tools/knowledge.js";
export { createDbQueryTool, createDbStatusTool } from "./tools/database.js";
export {
  EXEC_TOOL_NAMES,
  createExecTools,
  execRegistrySpecs,
  execToolsForMode,
} from "./tools/exec.js";
export {
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  ExecEnvironment,
  ExecError,
  MAX_COMMAND_CHARS,
  MAX_FINISHED,
  MAX_JOBS,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  killProcessTree,
  type ExecEnvironmentOptions,
  type ExecJobStatus,
  type ExecJobView,
  type ExecRequest,
} from "./exec/runner.js";

/* ─────────────── 后端功能体系（协议 / 会话 / 能力 / 上下文 / 传输） ─────────────── */

export {
  CLIENT_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  isClientMessage,
  type ApprovalDecision,
  type ApprovalScope,
  type ClientMessage,
  type ServerMessage,
  type UiApproval,
  type UiCapabilities,
  type UiConversation,
  type UiContext,
  type UiKnowledgeHit,
  type UiMessage,
  type UiModel,
  type UiQueue,
  type UiState,
  type UiStateLight,
  type UiStats,
  type UiTool,
} from "./protocol.js";

export { SnapshotEmitter, type SnapshotEmitterOptions } from "./snapshot.js";

export {
  ClientSession,
  Conversation,
  SessionHub,
  createSessionHub,
  type ClientSessionOptions,
  type ConversationOptions,
} from "./session-hub.js";
export {
  MAX_TITLE_CHARS,
  TREE_MARKER_TYPE,
  editUserMessage,
  forkSessionFile,
  forkedConversationTitle,
  normalizeConversationTitle,
  rollbackSession,
  type EditResult,
  type ForkResult,
  type TreeMarker,
} from "./sessions/edit.js";

export {
  BUILTIN_TOOL_NAMES,
  ToolRegistry,
  createToolRegistry,
  defineToolSpec,
  inferCapabilities,
  inferRisk,
  type ToolRegistryOptions,
  type ToolRisk,
  type ToolSource,
  type ToolSpec,
} from "./tools/registry.js";

export {
  ApprovalRulesStore,
  builtinApprovalRules,
  evaluateRules,
  extractTargetPath,
  ruleMatches,
  ruleMatchesTool,
  loadApprovalRulesFromFile,
  saveApprovalRulesToFile,
  type ApprovalAction,
  type ApprovalField,
  type ApprovalInput,
  type ApprovalMatch,
  type ApprovalRule,
  type ApprovalRulesStoreOptions,
  type ApprovalVerdict,
} from "./approval/rules.js";

export {
  applyApprovalResponse,
  categoryIdFor,
  decideApproval,
  defaultApprovalPolicy,
  type ApprovalContext,
  type ApprovalDecisionResult,
  type ApprovalMode,
  type ApprovalPolicy,
} from "./approval/policy.js";

export {
  ApprovalGate,
  approvalExtension,
  type ApprovalContextInput,
  type ApprovalGateOptions,
} from "./approval/gate.js";

export {
  applyTrim,
  computeSoftCap,
  contextUsageRatio,
  estimateConversationTokens,
  estimateTokens,
  planContextTrim,
  type BudgetMessage,
  type TrimPlan,
  type TrimPlanInput,
} from "./context/budget.js";

export {
  DEFAULT_PROMPT_ORDER,
  PROMPT_LAYER_KEYS,
  composeFromLayers,
  composePrompt,
  defaultPromptTemplate,
  renderToken,
  unknownTokens,
  type PromptLayers,
} from "./prompts/composer.js";

export {
  SETTINGS_DEFAULTS,
  SETTINGS_SCHEMA,
  SettingsService,
  bool,
  enumOf,
  int,
  MAX_MCP_SERVERS,
  memorySettingsPort,
  mcpServerList,
  str,
  strList,
  validateSettings,
  type FieldValidator,
  type McpServerConfig,
  type Settings,
  type SettingsPort,
  type SettingsSchema,
  defaultSettingsFile,
  fileSettingsPort,
  sanitizeSettings,
} from "./settings.js";

export {
  attachWebSocket,
  customCommandNames,
  defineCommand,
  originAllowed,
  serializeShared,
  type WsCommandContext,
  type WsCommandRegistry,
  type WsCommandSpec,
  type WsRuntime,
  type WsServer,
} from "./transport/ws.js";

/* ─────────────── 生产化：日志 / 指标 / HTTP 加固 ─────────────── */

export {
  Logger,
  configureLog,
  getLogger,
  isSecretKey,
  log,
  LOG_LEVELS,
  resolveLogLevel,
  sanitizeFields,
  type LogLevel,
  type LogSink,
  type LoggerOptions,
} from "./log.js";

export {
  METRICS,
  Metrics,
  metrics,
  type MetricDefinition,
  type MetricKind,
  type MetricName,
} from "./metrics.js";

export {
  applyServerTimeouts,
  DEFAULT_BODY_LIMIT,
  DEFAULT_SECURITY_HEADERS,
  DEFAULT_TIMEOUTS,
  hardenApp,
  jsonBodyLimit,
  securityHeaders,
  type TimeoutOptions,
} from "./http/hardening.js";

export {
  APP_ERROR_CODES,
  AppError,
  badRequest,
  busy,
  errorHandler,
  notFound,
  toAppError,
  validationFailed,
  type AppErrorCode,
  type AppErrorOptions,
} from "./http/errors.js";

export {
  asyncRoute,
  registerControlRoutes,
  registerDbRoutes,
  registerErrorHandler,
  registerProbeRoutes,
  registerResourceRoutes,
} from "./http/routes.js";

export {
  registerFileRoutes,
  type FileRoutesOptions,
} from "./http/file-routes.js";

export {
  FileService,
  isBinaryExtension,
  looksBinary,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_PREVIEW_BYTES,
  DEFAULT_MAX_WRITE_BYTES,
  type FileEntry,
  type FileContent,
  type FileServiceOptions,
} from "./files/service.js";

export {
  clientIp,
  createRateLimiter,
  DEFAULT_RATE_RULES,
  FixedWindowLimiter,
  type RateLimiterOptions,
  type RateLimitRule,
} from "./http/rate-limit.js";

export {
  ToolWatchdog,
  DEFAULT_TOOL_TIMEOUT_MS,
  type ToolWatchdogOptions,
} from "./approval/watchdog.js";

export {
  MAX_DOCS,
  MAX_DOC_BYTES,
  type LoadKnowledgeOptions,
} from "./knowledge/index.js";

export {
  MAX_SKILLS,
  MAX_SKILL_PATHS,
  type LoadSkillsOptions,
} from "./skills/index.js";

export {
  MAX_PROMPT_TEMPLATES,
  MAX_PROMPT_TEMPLATE_BYTES,
} from "./prompt-templates/index.js";

/* ─────────────── MCP / 计划模式 / 子代理 / 多密钥 ─────────────── */

export {
  McpClient,
  flattenContent,
  type McpClientOptions,
  type McpProcessHandle,
  type McpToolCallResult,
  type McpToolDescriptor,
  type SpawnFn,
} from "./mcp/client.js";

export {
  McpBridge,
  type McpBridgeOptions,
  type McpServerStatus,
} from "./mcp/bridge.js";

export {
  MAX_PLAN_MODE_ENTRIES,
  PLAN_MODE_PROMPT_SECTION,
  PlanModeController,
  planModeDenyReason,
  planModeExtension,
  type PlanModeControllerOptions,
} from "./modes/plan-mode.js";

export {
  DELEGATE_TOOL_NAME,
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  MAX_SUBAGENT_OUTPUT_CHARS,
  SUBAGENT_CAPABILITY,
  buildSubagentPrompt,
  createDelegateTool,
  lastAssistantText,
  truncateSubagentOutput,
  type SubagentRunnerOptions,
  type SubagentSession,
} from "./subagents/index.js";

export {
  MAX_PROVIDER_KEYS,
  createProviderKeyStore,
  defaultProviderKeysFile,
  type ProviderKeyInfo,
  type ProviderKeyStore,
} from "./provider-keys.js";

export {
  registerProviderKeyRoutes,
  type ProviderKeyRoutesOptions,
} from "./http/provider-key-routes.js";
