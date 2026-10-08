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
  formatModelChoices,
  modelDisplayName,
  resolveModelRef,
  unknownModelError,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelRef,
  type ProviderCatalogEntry,
  type ResolvedModelRef,
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
  memorySettingsPort,
  str,
  strList,
  validateSettings,
  type FieldValidator,
  type Settings,
  type SettingsPort,
  type SettingsSchema,
} from "./settings.js";

export {
  attachWebSocket,
  originAllowed,
  serializeShared,
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
