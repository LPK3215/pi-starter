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

import { join } from "node:path";
import {
  modelDisplayName,
  resolveModelRef,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelRef,
  type ProviderCatalogEntry,
} from "./models.js";

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
 * .env 是可选的——不存在就静默跳过，用命令行参数照样能跑。
 */
export function loadEnvFile(cwd = process.cwd()): void {
  const envPath = join(cwd, ".env");
  if (loadedEnvPaths.has(envPath)) return;
  loadedEnvPaths.add(envPath);
  try {
    process.loadEnvFile?.(envPath);
  } catch {
    /* .env 不存在或格式有误 → 忽略，回落到命令行参数 */
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
        "  命令行：npm run dev -- --model modelscope/Qwen/Qwen3-Next-80B-A3B-Instruct",
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
      return "编码：read/bash/edit/write/grep/find/ls + 自定义工具";
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
  };
}
