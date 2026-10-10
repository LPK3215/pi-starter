/**
 * pi-starter · 配置层
 *
 * 解决两个问题：
 *   1. SDK 内置了大量 huggingface 模型，「取第一个可用模型」可能选中没配 Key 的那个。
 *   2. createAgentSession() 不传 tools 时，默认打开 read / bash / edit / write。
 *      脚手架默认关 bash/edit/write；read 仍开，因为 SDK 用它加载技能。
 *
 * 优先级：命令行参数  >  .env  >  脚手架默认（off）
 *
 * 用法：复制 .env.example 为 .env，填好即可。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "./log.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import {
  modelDisplayName,
  resolveModelRef,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelRef,
  type ProviderCatalogEntry,
  type ScopedModelRef,
} from "./models.js";
import type { SdkSettings } from "./agent.js";

/** 内置工具三档：只开自定义 / 只读 / 完整编码 */
export const BUILTIN_TOOL_MODES = ["off", "readonly", "coding"] as const;
export type BuiltinToolMode = (typeof BUILTIN_TOOL_MODES)[number];

/** 只读档：不能改文件、不能跑 shell */
export const READONLY_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;

/** 编码档：SDK 全部内置工具（比 SDK 默认多 grep/find/ls） */
export const CODING_BUILTIN_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/**
 * Transport / snapshot runtime knobs (WebSocket bidirectional channel).
 * All values are environment-overridable and carry safe loopback defaults.
 */
export interface RuntimeConfig {
  /** Bind host for the HTTP + WS server. Defaults to loopback for safety. */
  host: string;
  /** WebSocket endpoint path. */
  wsPath: string;
  /** Wire protocol version advertised in `ready` and negotiated from `hello`. */
  protocolVersion: number;
  /** Throttle window for full/incremental snapshots (ms). */
  snapshotIntervalMs: number;
  /** Checkpoint window while message deltas are active (ms). */
  streamingSnapshotIntervalMs: number;
  /** WebSocket heartbeat ping interval (ms). */
  heartbeatIntervalMs: number;
  /** Coalesced retry delay after a dropped snapshot (ms). */
  snapshotRetryMs: number;
  /** Buffered-bytes threshold above which snapshots may be dropped (deltas bypass). */
  backpressureBytes: number;
  /**
   * Consecutive snapshot drops before the connection is terminated.
   *
   * Dropping alone never frees memory: a client too slow to drain keeps its receive buffer
   * alive while the server keeps rebuilding snapshots for it. After this many consecutive
   * drops we give up on it. Set high (or high enough) to be conservative; 0 disables.
   */
  maxConsecutiveSnapshotDrops: number;
}

/** Defaults for RuntimeConfig. Overridable via .env / process.env. */
export const RUNTIME_DEFAULTS: RuntimeConfig = {
  host: "127.0.0.1",
  wsPath: "/ws",
  // Derived from the protocol single source of truth so the advertised version can never
  // drift from PROTOCOL_VERSION. Overridable only to run a deliberately mismatched build.
  protocolVersion: PROTOCOL_VERSION,
  snapshotIntervalMs: 60,
  streamingSnapshotIntervalMs: 2000,
  heartbeatIntervalMs: 30000,
  snapshotRetryMs: 500,
  backpressureBytes: 262144,
  // ~3 retries at 500ms apart. Generous enough that a brief stall is forgiven.
  maxConsecutiveSnapshotDrops: 8,
};

function intFromEnv(raw: string | undefined, fallback: number): number {
  const value = clean(raw);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/** Resolve the runtime config from an env-like source, falling back to defaults. */
export function resolveRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const host = clean(env.PI_HOST) ?? RUNTIME_DEFAULTS.host;
  const wsPathRaw = clean(env.PI_WS_PATH) ?? RUNTIME_DEFAULTS.wsPath;
  const wsPath = wsPathRaw.startsWith("/") ? wsPathRaw : `/${wsPathRaw}`;
  return {
    host,
    wsPath,
    protocolVersion: intFromEnv(env.PI_PROTOCOL_VERSION, RUNTIME_DEFAULTS.protocolVersion),
    snapshotIntervalMs: intFromEnv(env.PI_SNAPSHOT_INTERVAL_MS, RUNTIME_DEFAULTS.snapshotIntervalMs),
    streamingSnapshotIntervalMs:
      intFromEnv(env.PI_STREAMING_SNAPSHOT_INTERVAL_MS, RUNTIME_DEFAULTS.streamingSnapshotIntervalMs),
    heartbeatIntervalMs: intFromEnv(env.PI_WS_HEARTBEAT_MS, RUNTIME_DEFAULTS.heartbeatIntervalMs),
    snapshotRetryMs: intFromEnv(env.PI_SNAPSHOT_RETRY_MS, RUNTIME_DEFAULTS.snapshotRetryMs),
    backpressureBytes: intFromEnv(env.PI_WS_BACKPRESSURE_BYTES, RUNTIME_DEFAULTS.backpressureBytes),
    maxConsecutiveSnapshotDrops: intFromEnv(
      env.PI_WS_MAX_CONSECUTIVE_DROPS,
      RUNTIME_DEFAULTS.maxConsecutiveSnapshotDrops,
    ),
  };
}

/** 可选布尔：认 1/true/yes/on 与 0/false/no/off，其它/未设 → undefined（= 不覆盖）。 */
function boolFromEnv(raw: string | undefined): boolean | undefined {
  const value = clean(raw)?.toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

/** 可选非负整数：未设或非法 → undefined（= 不覆盖 SDK 默认）。 */
function intOptFromEnv(raw: string | undefined): number | undefined {
  const value = clean(raw);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

/**
 * 文件日志落盘配置（补齐 log.ts 缺失的落盘环节，级别仍走 PI_LOG_LEVEL）。
 * 全部可配、不硬编码：开发可关文件只留 stdout，生产默认开并限大小/留存。
 */
export interface LogConfig {
  /** 是否把日志落盘到文件（默认 true；关则只 stdout）。 */
  toFile: boolean;
  /** 落盘目录（相对路径按进程 cwd 解析，默认 ./logs）。 */
  dir: string;
  /** 单文件轮转上限 MB（0 = 不按大小轮转）。 */
  maxSizeMb: number;
  /** 归档保留天数（0 = 不清理）。 */
  retentionDays: number;
}

export const LOG_DEFAULTS: LogConfig = {
  toFile: true,
  dir: "./logs",
  // 50 MB 单日足够容纳一次事故排障，又不至于吃满磁盘。
  maxSizeMb: 50,
  retentionDays: 14,
};

/** 从 env 解析日志配置，非法值回落默认。 */
export function resolveLogConfig(
  env: Record<string, string | undefined> = process.env,
): LogConfig {
  return {
    // 只显式关闭（PI_LOG_TO_FILE=false/0/off）才落盘关闭；未设 = 默认开。
    toFile: boolFromEnv(env.PI_LOG_TO_FILE) ?? LOG_DEFAULTS.toFile,
    dir: clean(env.PI_LOG_DIR) ?? LOG_DEFAULTS.dir,
    maxSizeMb: intOptFromEnv(env.PI_LOG_MAX_SIZE_MB) ?? LOG_DEFAULTS.maxSizeMb,
    retentionDays: intOptFromEnv(env.PI_LOG_RETENTION_DAYS) ?? LOG_DEFAULTS.retentionDays,
  };
}

/** 逗号分隔列表：未设或空 → undefined。 */
function listFromEnv(raw: string | undefined): string[] | undefined {
  const value = clean(raw);
  if (!value) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** 只接受白名单内的枚举值（小写），其它丢弃→ undefined。 */
function enumFromEnv(raw: string | undefined, allowed: readonly string[]): string | undefined {
  const value = clean(raw)?.toLowerCase();
  return value && allowed.includes(value) ? value : undefined;
}

/**
 * 把环境变量解析为 SDK 设置（compaction/retry/images/enabledModels）。全无则返回 `{}`，
 * 此时 `buildAgent` 不建 SettingsManager → 行为与以往一致（不静默改现有语义）。
 */
export function resolveSdkSettings(
  env: Record<string, string | undefined> = process.env,
): SdkSettings {
  const settings: SdkSettings = {};

  const compactionEnabled = boolFromEnv(env.PI_COMPACTION_ENABLED);
  const reserveTokens = intOptFromEnv(env.PI_COMPACTION_RESERVE_TOKENS);
  const keepRecentTokens = intOptFromEnv(env.PI_COMPACTION_KEEP_RECENT_TOKENS);
  if (compactionEnabled !== undefined || reserveTokens !== undefined || keepRecentTokens !== undefined) {
    settings.compaction = {
      ...(compactionEnabled !== undefined ? { enabled: compactionEnabled } : {}),
      ...(reserveTokens !== undefined ? { reserveTokens } : {}),
      ...(keepRecentTokens !== undefined ? { keepRecentTokens } : {}),
    };
  }

  const retryEnabled = boolFromEnv(env.PI_RETRY_ENABLED);
  const maxRetries = intOptFromEnv(env.PI_RETRY_MAX_RETRIES);
  const baseDelayMs = intOptFromEnv(env.PI_RETRY_BASE_DELAY_MS);
  if (retryEnabled !== undefined || maxRetries !== undefined || baseDelayMs !== undefined) {
    settings.retry = {
      ...(retryEnabled !== undefined ? { enabled: retryEnabled } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(baseDelayMs !== undefined ? { baseDelayMs } : {}),
    };
  }

  const autoResize = boolFromEnv(env.PI_IMAGES_AUTO_RESIZE);
  const blockImages = boolFromEnv(env.PI_IMAGES_BLOCK);
  if (autoResize !== undefined || blockImages !== undefined) {
    settings.images = {
      ...(autoResize !== undefined ? { autoResize } : {}),
      ...(blockImages !== undefined ? { blockImages } : {}),
    };
  }

  const enabledModels = listFromEnv(env.PI_ENABLED_MODELS);
  if (enabledModels) settings.enabledModels = enabledModels;

  // 出站超时（与入站服务器超时不同）。
  const httpIdleTimeoutMs = intOptFromEnv(env.PI_HTTP_IDLE_TIMEOUT_MS);
  if (httpIdleTimeoutMs !== undefined) settings.httpIdleTimeoutMs = httpIdleTimeoutMs;
  const websocketConnectTimeoutMs = intOptFromEnv(env.PI_WS_CONNECT_TIMEOUT_MS);
  if (websocketConnectTimeoutMs !== undefined) settings.websocketConnectTimeoutMs = websocketConnectTimeoutMs;

  // 队列消费策略：只接受官方枚举值，其它值丢弃（不静默传给 SDK）。
  const steeringMode = enumFromEnv(env.PI_STEERING_MODE, ["all", "one-at-a-time"]);
  if (steeringMode) settings.steeringMode = steeringMode as "all" | "one-at-a-time";
  const followUpMode = enumFromEnv(env.PI_FOLLOW_UP_MODE, ["all", "one-at-a-time"]);
  if (followUpMode) settings.followUpMode = followUpMode as "all" | "one-at-a-time";

  // 各思考档 token 预算。
  const minimal = intOptFromEnv(env.PI_THINKING_BUDGET_MINIMAL);
  const low = intOptFromEnv(env.PI_THINKING_BUDGET_LOW);
  const medium = intOptFromEnv(env.PI_THINKING_BUDGET_MEDIUM);
  const high = intOptFromEnv(env.PI_THINKING_BUDGET_HIGH);
  if (minimal !== undefined || low !== undefined || medium !== undefined || high !== undefined) {
    settings.thinkingBudgets = {
      ...(minimal !== undefined ? { minimal } : {}),
      ...(low !== undefined ? { low } : {}),
      ...(medium !== undefined ? { medium } : {}),
      ...(high !== undefined ? { high } : {}),
    };
  }

  // 分支摘要预算。
  const branchReserve = intOptFromEnv(env.PI_BRANCH_SUMMARY_RESERVE_TOKENS);
  const branchSkip = boolFromEnv(env.PI_BRANCH_SUMMARY_SKIP);
  if (branchReserve !== undefined || branchSkip !== undefined) {
    settings.branchSummary = {
      ...(branchReserve !== undefined ? { reserveTokens: branchReserve } : {}),
      ...(branchSkip !== undefined ? { skipPrompt: branchSkip } : {}),
    };
  }

  return settings;
}

/** PI_EXTENSION_PATHS → 官方扩展文件路径数组（逗号分隔）。 */
export function resolveExtensionPaths(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return listFromEnv(env.PI_EXTENSION_PATHS) ?? [];
}

/** .env / 命令行合并后的配置 */
export interface ResolvedConfig {
  provider?: string;
  modelId?: string;
  /** 默认 off：自定义工具 + read（技能加载需要 read；bash/edit/write 仍关） */
  builtinTools: BuiltinToolMode;
  /**
   * 模型目录：provider → baseUrl / api / 模型列表。
   * 来自 PI_MODELS，缺省时退回 PI_PROVIDER + PI_MODEL + PI_BASE_URL 这一条。
   */
  catalog: ModelCatalog;
  /** Transport / snapshot runtime knobs (WebSocket bidirectional channel). */
  runtime: RuntimeConfig;
}

export interface ConfigOverride {
  provider?: string;
  modelId?: string;
  builtinTools?: BuiltinToolMode | string;
}

/** 传给 createAgentSession 的工具开关 */
export interface SessionToolPolicy {
  noTools?: "builtin";
  tools?: string[];
}

const loadedEnvPaths = new Set<string>();

/** 缺模型 / 缺 Key 时指向 setup，避免再让人去手写 ~/.pi/agent */
export const SETUP_HINT =
  "先填 .env 里的 PI_API_KEY，再运行 npm run setup（写入 ~/.pi/agent/models.json 和 auth.json）。已有密钥加 --force 才覆盖。";

/**
 * 加载项目根目录的 .env（Node 22 内置，零依赖）。
 *
 * 不存在 → 静默跳过（.env 是可选的，用命令行参数照样能跑）。
 * 存在但加载失败 → **必须出声**：一个笔误（引号没配对、变量名非法）会让整份 .env
 * 静默失效，表现为「Key 明明填了却说没配」，比直接报错难查得多。
 */
export function loadEnvFile(cwd = process.cwd()): void {
  const envPath = join(cwd, ".env");
  if (loadedEnvPaths.has(envPath)) return;
  loadedEnvPaths.add(envPath);
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile?.(envPath);
  } catch (err) {
    getLogger().warn("加载 .env 失败，已忽略该文件（回落到命令行参数与环境变量）", {
      envPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 禁止落到 SDK 第一个 huggingface：provider + model 都必须明确 */
export function requireConfiguredModel<T extends { provider?: string; modelId?: string }>(
  cfg: T,
): asserts cfg is T & { provider: string; modelId: string } {
  if (!cfg.provider || !cfg.modelId) {
    throw new Error(
      `未指定模型。${SETUP_HINT}\n` +
        "  .env：PI_MODEL=<provider>/<modelId>（或 PI_PROVIDER + PI_MODEL）\n" +
        "  命令行：npm run dev -- --model <provider>/<modelId>",
    );
  }
}

const PROVIDER_KEY = /^[a-z0-9][a-z0-9_-]*$/i;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 解析 PI_MODELS。
 * 每条用分号隔开：provider|baseUrl|api|modelId[:显示名],modelId[:显示名]
 * 例：modelscope|https://api-inference.modelscope.cn/v1|openai-completions|Qwen/Qwen3-Next-80B-A3B-Instruct:Qwen3-Next-80B
 */
export function parseModelCatalog(raw: string | undefined): ModelCatalog {
  const text = clean(raw);
  if (!text) return {};

  const catalog: ModelCatalog = {};
  for (const segment of text.split(";")) {
    const piece = segment.trim();
    if (!piece) continue;
    const parts = piece.split("|").map((part) => part.trim());
    if (parts.length !== 4 || parts.some((part) => !part)) {
      throw new Error(
        `PI_MODELS 格式不对：「${piece}」\n` +
          "  每条必须是 provider|baseUrl|api|modelId[:显示名],modelId[:显示名]，多条用分号隔开。",
      );
    }
    const [provider, baseUrl, api, modelsRaw] = parts as [string, string, string, string];
    if (!PROVIDER_KEY.test(provider)) {
      throw new Error(`PI_MODELS 的 provider 只能是字母数字和 - _，收到：${provider}`);
    }
    catalog[provider] = {
      baseUrl,
      api,
      models: mergeModelEntries(catalog[provider]?.models ?? [], parseModelList(modelsRaw, provider)),
    };
  }
  return catalog;
}

function parseModelList(raw: string, provider: string): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const item of raw.split(",")) {
    const piece = item.trim();
    if (!piece) continue;
    const colon = piece.lastIndexOf(":");
    const id = (colon > 0 ? piece.slice(0, colon) : piece).trim();
    const name = colon > 0 ? piece.slice(colon + 1).trim() : undefined;
    if (!id) {
      throw new Error(`PI_MODELS 的 ${provider} 有一条空的模型 id`);
    }
    entries.push(name ? { id, name } : { id });
  }
  if (entries.length === 0) {
    throw new Error(`PI_MODELS 的 ${provider} 至少要有一个模型 id`);
  }
  return entries;
}

function mergeModelEntries(
  existing: readonly ModelCatalogEntry[],
  incoming: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const merged = existing.map((entry) => ({ ...entry }));
  for (const entry of incoming) {
    const found = merged.find((item) => item.id === entry.id);
    if (found) {
      if (entry.name) found.name = entry.name;
    } else {
      merged.push({ ...entry });
    }
  }
  return merged;
}

/**
 * 没写 PI_MODELS 时，用 PI_PROVIDER / PI_MODEL / PI_BASE_URL 合成一条。
 * PI_MODEL 写成 provider/modelId 时，provider 以它为准。
 */
export function catalogFromSingle(
  env: {
    provider?: string;
    model?: string;
    baseUrl?: string;
    api?: string;
  },
  fallback: { baseUrl: string; api: string },
): ModelCatalog {
  const baseUrl = clean(env.baseUrl) ?? fallback.baseUrl;
  const api = clean(env.api) ?? fallback.api;
  const ref = resolveModelRef({ provider: env.provider, model: env.model });
  if (!ref) return {};
  return { [ref.provider]: { baseUrl, api, models: [{ id: ref.modelId }] } };
}

/** PI_MODELS 优先；没有时退回单模型变量。同 provider 的模型合并，不覆盖已有 baseUrl。 */
export function resolveCatalog(
  env: {
    models?: string;
    provider?: string;
    model?: string;
    baseUrl?: string;
    api?: string;
  },
  fallback: { baseUrl: string; api: string },
): ModelCatalog {
  const declared = parseModelCatalog(env.models);
  const single = catalogFromSingle(env, fallback);
  const catalog: ModelCatalog = {};
  for (const [provider, entry] of Object.entries(declared)) {
    catalog[provider] = { ...entry, models: entry.models.map((model) => ({ ...model })) };
  }
  for (const [provider, entry] of Object.entries(single)) {
    const current: ProviderCatalogEntry = catalog[provider] ?? {
      baseUrl: entry.baseUrl,
      api: entry.api,
      models: [],
    };
    current.models = mergeModelEntries(current.models, entry.models);
    catalog[provider] = current;
  }
  return catalog;
}

/**
 * 默认模型：命令行 > .env。
 * .env 里 PI_MODEL 可以是 modelId，也可以是 provider/modelId。
 */
export function resolveDefaultModel(
  override: { provider?: string; model?: string },
  env: { provider?: string; model?: string },
): ModelRef | undefined {
  return (
    resolveModelRef({ provider: override.provider, model: override.model }) ??
    resolveModelRef({ provider: env.provider, model: env.model })
  );
}

export { modelDisplayName };

/**
 * 知识检索配置（默认 keyword，行为不变）。`PI_KNOWLEDGE_RETRIEVAL=vector` 才开向量检索。
 * embedding 源：`PI_EMBEDDINGS_PROVIDER` = openai（默认，需 base+model）| ollama（同 openai）
 * | transformers（进程内，直接下载权重，可留空 model 用默认小模，`PI_EMBEDDINGS_CACHE_DIR` 指定缓存目录）。
 * 向量库：`PI_KNOWLEDGE_VECTOR_STORE` = memory（默认）| sqlite（`PI_KNOWLEDGE_VECTOR_DB_PATH` 持久化）。
 */
export type EmbeddingsProvider = "openai" | "ollama" | "transformers";

export interface RetrievalEmbeddings {
  provider: EmbeddingsProvider;
  baseUrl?: string;
  model: string;
  apiKey?: string;
  cacheDir?: string;
  remoteHost?: string;
}

export interface RetrievalConfig {
  mode: "keyword" | "vector";
  embeddings?: RetrievalEmbeddings;
  vectorStore?: { backend: "memory" | "sqlite"; path?: string };
}

function parseEmbeddings(env: Record<string, string | undefined>): RetrievalEmbeddings | undefined {
  const provider = (clean(env.PI_EMBEDDINGS_PROVIDER)?.toLowerCase() ?? "openai") as EmbeddingsProvider;
  const model = clean(env.PI_EMBEDDINGS_MODEL);
  const baseUrl = clean(env.PI_EMBEDDINGS_BASE_URL);
  const apiKey = clean(env.PI_EMBEDDINGS_KEY);
  const cacheDir = clean(env.PI_EMBEDDINGS_CACHE_DIR);
  if (provider === "transformers") {
    // 进程内推理：不要求 base/model，model 缺省时用类里的默认小模型。
    const remoteHost = clean(env.PI_EMBEDDINGS_HF_ENDPOINT);
    return {
      provider,
      ...(model ? { model } : { model: "" }),
      ...(apiKey ? { apiKey } : {}),
      ...(cacheDir ? { cacheDir } : {}),
      ...(remoteHost ? { remoteHost } : {}),
    };
  }
  // openai / ollama 都需要 base + model
  if (!baseUrl || !model) return undefined;
  return { provider, baseUrl, model, ...(apiKey ? { apiKey } : {}) };
}

export function resolveRetrievalConfig(
  env: Record<string, string | undefined> = process.env,
): RetrievalConfig {
  const mode = clean(env.PI_KNOWLEDGE_RETRIEVAL)?.toLowerCase() === "vector" ? "vector" : "keyword";
  if (mode !== "vector") return { mode: "keyword" };
  const cfg: RetrievalConfig = { mode: "vector" };
  const embeddings = parseEmbeddings(env);
  if (embeddings) cfg.embeddings = embeddings;
  const storeBackend = clean(env.PI_KNOWLEDGE_VECTOR_STORE)?.toLowerCase();
  if (storeBackend === "sqlite") {
    cfg.vectorStore = { backend: "sqlite", ...(clean(env.PI_KNOWLEDGE_VECTOR_DB_PATH) ? { path: clean(env.PI_KNOWLEDGE_VECTOR_DB_PATH) } : {}) };
  } else if (storeBackend === "memory") {
    cfg.vectorStore = { backend: "memory" };
  }
  return cfg;
}

/** 联网工具配置（`PI_WEB`）。默认关闭——出站网络是数据外泄通道，用的时候再开。 */
export interface WebConfig {
  enabled: boolean;
  /** 单次抓取的默认字节上限；工具入参可覆盖，但都会被 `MAX_FETCH_MAX_BYTES` 夹住。 */
  maxBytes?: number;
  /** 单次抓取的默认超时（毫秒）。 */
  timeoutMs?: number;
}

/**
 * 解析 `PI_WEB`。
 *
 * 只有明确的 `on` / `true` / `1` 才算开——拼错（`PI_WEB=yes`）**不等于偷偷打开**，
 * 与 `PI_BUILTIN_TOOLS` 的取值风格保持一致：宁可多打一次，不要静默放权。
 */
export function resolveWebConfig(env: Record<string, string | undefined> = process.env): WebConfig {
  const raw = clean(env.PI_WEB)?.toLowerCase();
  if (raw !== "on" && raw !== "true" && raw !== "1") return { enabled: false };
  const maxBytes = Number(clean(env.PI_WEB_MAX_BYTES));
  const timeoutMs = Number(clean(env.PI_WEB_TIMEOUT_MS));
  return {
    enabled: true,
    ...(Number.isFinite(maxBytes) && maxBytes > 0 ? { maxBytes: Math.trunc(maxBytes) } : {}),
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs: Math.trunc(timeoutMs) } : {}),
  };
}

/**
 * 解析 PI_SCOPED_MODELS（模型轮换列表）：逗号分隔，每项 `provider/modelId[:thinkingLevel]`。
 * 例：modelscope/Qwen/Qwen3-Next:high,zhipu/glm-4.5-air:off
 * 返回的是未解析的原始引用；由 agent 层用 resolveScopedModels 对可用模型逐个解析。
 */
export function parseScopedModelRefs(raw: string | undefined): ScopedModelRef[] {
  const text = clean(raw);
  if (!text) return [];
  const refs: ScopedModelRef[] = [];
  for (const item of text.split(",")) {
    const piece = item.trim();
    if (!piece) continue;
    const colon = piece.lastIndexOf(":");
    // 只有当冒号在末尾一段且前面有内容时才当思考档（模型 id 里的斜杠不受影响）
    const ref = colon > 0 ? piece.slice(0, colon).trim() : piece;
    const thinkingLevel = colon > 0 ? piece.slice(colon + 1).trim() : undefined;
    if (ref) refs.push(thinkingLevel ? { ref, thinkingLevel } : { ref });
  }
  return refs;
}

/** 解析 off | readonly | coding；非法值直接抛，避免静默落到 SDK 默认 */
export function parseBuiltinToolMode(raw: string | undefined): BuiltinToolMode | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if ((BUILTIN_TOOL_MODES as readonly string[]).includes(value)) {
    return value as BuiltinToolMode;
  }
  throw new Error(
    `内置工具模式只能是 off | readonly | coding，收到：${raw}\n` +
      `  命令行：--builtin-tools off\n` +
      `  .env：  PI_BUILTIN_TOOLS=off`,
  );
}

function uniqueNames(names: readonly string[]): string[] {
  return [...new Set(names.filter(Boolean))];
}

/**
 * 把三档模式翻译成 SDK 的 tools / noTools。
 * extraToolNames：脚手架自己登记的自定义工具名。
 *   off       → allowlist = read + 自定义名
 *               SDK 只有在 selectedTools 含 read 时才把技能目录写进系统提示词，
 *               模型用内置 read 加载 SKILL.md。bash/edit/write 仍关。
 *   readonly  → allowlist = 只读内置 + 自定义名
 *   coding    → allowlist = 全部内置 + 自定义名
 *
 * 注意：三档都走 allowlist。只在扩展里 pi.registerTool、没进 allTools
 * 的名字不会自动放行，请把工具登记到 src/tools/index.ts。
 */
export function sessionToolPolicy(
  mode: BuiltinToolMode,
  extraToolNames: readonly string[] = [],
): SessionToolPolicy {
  const extra = uniqueNames(extraToolNames);
  switch (mode) {
    case "off":
      return { tools: uniqueNames(["read", ...extra]) };
    case "readonly":
      return { tools: uniqueNames([...READONLY_BUILTIN_TOOLS, ...extra]) };
    case "coding":
      return { tools: uniqueNames([...CODING_BUILTIN_TOOLS, ...extra]) };
  }
}

export function describeBuiltinToolMode(mode: BuiltinToolMode): string {
  switch (mode) {
    case "off":
      return "自定义工具 + read（技能用 SDK read 加载；已关 bash/edit/write）";
    case "readonly":
      return "只读：read/grep/find/ls + 自定义工具";
    case "coding":
      return "编码：read/bash/edit/write/grep/find/ls + exec/exec_jobs/exec_stop + 自定义工具";
  }
}

/**
 * 合并「命令行参数」和「.env」，得到最终生效的配置。
 * @param override 命令行传进来的值，优先级最高
 * @param fallback 单模型变量缺 baseUrl / api 时的默认值（setup 传入 ModelScope 默认）
 */
export function loadConfig(
  override: ConfigOverride = {},
  fallback: { baseUrl: string; api: string } = {
    baseUrl: "https://api-inference.modelscope.cn/v1",
    api: "openai-completions",
  },
): ResolvedConfig {
  loadEnvFile();
  const envProvider = process.env.PI_PROVIDER || undefined;
  const envModel = process.env.PI_MODEL || undefined;
  const selected = resolveDefaultModel(
    { provider: override.provider, model: override.modelId },
    { provider: envProvider, model: envModel },
  );
  return {
    provider: selected?.provider,
    modelId: selected?.modelId,
    builtinTools:
      parseBuiltinToolMode(override.builtinTools) ??
      parseBuiltinToolMode(process.env.PI_BUILTIN_TOOLS) ??
      "off",
    catalog: resolveCatalog(
      {
        models: process.env.PI_MODELS,
        provider: envProvider,
        model: envModel,
        baseUrl: process.env.PI_BASE_URL,
        api: process.env.PI_API,
      },
      fallback,
    ),
    runtime: resolveRuntimeConfig(),
  };
}
