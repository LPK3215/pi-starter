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
  requireConfiguredModel,
  resolveCatalog,
  resolveDefaultModel,
  sessionToolPolicy,
  SETUP_HINT,
  type BuiltinToolMode,
  type ConfigOverride,
  type ResolvedConfig,
  type SessionToolPolicy,
} from "./config.js";
export {
  isReadOnlySql,
  openDatabase,
  openScaffoldDatabase,
  type DatabaseStore,
  type DbPing,
  type NoteRow,
  type OpenDatabaseOptions,
  type QueryResult,
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
