/**
 * pi-starter · 把 ModelScope 写进 Pi 原生配置目录
 *
 * 运行：npm run setup
 * 覆盖已有密钥：npm run setup -- --force
 *
 * 读项目 .env，merge 写入 ~/.pi/agent/models.json 和 auth.json。
 * 运行时仍由 ModelRuntime.create() 读这两个文件，不加兼容层。
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadEnvFile, resolveCatalog, resolveDefaultModel, SETUP_HINT } from "./config.js";
import { modelDisplayName, type ModelCatalog, type ModelCatalogEntry } from "./models.js";

export const DEFAULT_PROVIDER = "modelscope";
export const DEFAULT_MODEL_ID = "Qwen/Qwen3-Next-80B-A3B-Instruct";
export const DEFAULT_MODEL_NAME = "Qwen3-Next-80B";
export const DEFAULT_BASE_URL = "https://api-inference.modelscope.cn/v1";
export const DEFAULT_API = "openai-completions";

export interface ModelEntry {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  models?: ModelEntry[];
  [key: string]: unknown;
}

export interface ModelsFile {
  providers?: Record<string, ProviderEntry>;
  [key: string]: unknown;
}

export interface AuthFile {
  [provider: string]: unknown;
}

export interface MergeAuthResult {
  next: AuthFile;
  wroteKey: boolean;
  keptExisting: boolean;
}

export interface SetupOptions {
  agentDir?: string;
  cwd?: string;
  env?: NodeJS.Dict<string>;
  force?: boolean;
}

export interface SetupResult {
  agentDir: string;
  modelsPath: string;
  authPath: string;
  copiedEnvExample: boolean;
  /** 这次新写入密钥的 provider */
  authKeyWritten: string[];
  /** 已有密钥、本次保留的 provider */
  authKeyKept: string[];
  /** 目录里有、但没找到密钥的 provider */
  authKeyMissing: string[];
  provider: string;
  modelId: string;
}

export function mergeModelsJson(existing: unknown, catalog: ModelCatalog): ModelsFile {
  const file: ModelsFile =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as ModelsFile) }
      : {};
  const providers: Record<string, ProviderEntry> = { ...(file.providers ?? {}) };

  for (const [provider, patch] of Object.entries(catalog)) {
    const current: ProviderEntry = { ...(providers[provider] ?? {}) };
    // 已有 baseUrl / api 视为用户手改过，不覆盖
    if (!current.baseUrl) current.baseUrl = patch.baseUrl;
    if (!current.api) current.api = patch.api;
    current.models = mergeModels(current.models ?? [], patch.models);
    providers[provider] = current;
  }

  return { ...file, providers };
}

/** 同 id 保留原条目（含用户改过的显示名），只追加没有的 */
function mergeModels(
  existing: readonly ModelEntry[],
  incoming: readonly ModelCatalogEntry[],
): ModelEntry[] {
  const models = existing.map((model) => ({ ...model }));
  for (const entry of incoming) {
    if (models.some((model) => model.id === entry.id)) continue;
    models.push({ id: entry.id, name: modelDisplayName(entry) });
  }
  return models;
}

function credentialPresent(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const rec = entry as { type?: string; key?: string };
  if (rec.type === "oauth") return true;
  return rec.type === "api_key" && typeof rec.key === "string" && rec.key.trim().length > 0;
}

export function mergeAuthJson(
  existing: unknown,
  provider: string,
  key: string | undefined,
  options: { force?: boolean } = {},
): MergeAuthResult {
  const file: AuthFile =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as AuthFile) }
      : {};
  const hadExisting = credentialPresent(file[provider]);
  const trimmed = key?.trim() || undefined;

  if (hadExisting && !options.force) {
    return { next: file, wroteKey: false, keptExisting: true };
  }
  if (!trimmed) {
    throw new Error(
      `缺少 ${provider} 的 API Key。${SETUP_HINT}`,
    );
  }
  file[provider] = { type: "api_key", key: trimmed };
  return { next: file, wroteKey: true, keptExisting: hadExisting };
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf-8").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`无法解析 ${path}，请先修好 JSON 再跑 npm run setup。`);
  }
}

function writeJsonFile(path: string, value: unknown, mode?: number): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (mode === undefined) {
    writeFileSync(path, body, "utf-8");
    return;
  }
  writeFileSync(path, body, { encoding: "utf-8", mode });
  try {
    chmodSync(path, mode);
  } catch {
    /* Windows NTFS 对 mode 是尽力而为，与 Pi SDK 一致 */
  }
}

function ensureEnvFile(cwd: string): boolean {
  const envPath = join(cwd, ".env");
  if (existsSync(envPath)) return false;
  const examplePath = join(cwd, ".env.example");
  if (!existsSync(examplePath)) {
    throw new Error(`缺少 ${envPath}，也没有 .env.example 可复制。`);
  }
  copyFileSync(examplePath, envPath);
  return true;
}

function resolveAgentDir(explicit?: string): string {
  if (explicit) return explicit;
  try {
    return getAgentDir();
  } catch {
    return join(homedir(), ".pi", "agent");
  }
}

/** provider 的密钥：PI_API_KEY_<PROVIDER> 优先，默认 provider 才回落到 PI_API_KEY */
export function apiKeyForProvider(
  env: NodeJS.Dict<string>,
  provider: string,
  defaultProvider: string,
): string | undefined {
  const specific = env[`PI_API_KEY_${provider.toUpperCase().replace(/-/g, "_")}`];
  if (specific?.trim()) return specific.trim();
  if (provider === defaultProvider) return env.PI_API_KEY?.trim() || undefined;
  return undefined;
}

export function setupPiAgentDir(options: SetupOptions = {}): SetupResult {
  const cwd = options.cwd ?? process.cwd();
  let copiedEnvExample = false;
  if (!options.env) {
    copiedEnvExample = ensureEnvFile(cwd);
    loadEnvFile(cwd);
  }
  const env = options.env ?? process.env;
  const force = options.force === true;

  const catalog = resolveCatalog(
    {
      models: env.PI_MODELS,
      provider: env.PI_PROVIDER,
      model: env.PI_MODEL,
      baseUrl: env.PI_BASE_URL,
      api: env.PI_API,
    },
    { baseUrl: DEFAULT_BASE_URL, api: DEFAULT_API },
  );
  const selected = resolveDefaultModel(
    {},
    { provider: env.PI_PROVIDER, model: env.PI_MODEL },
  ) ?? { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL_ID };

  // 默认模型所在的 provider 至少要有一条，否则写出来的目录对不上启动时要用的模型
  if (!catalog[selected.provider]) {
    catalog[selected.provider] = { baseUrl: DEFAULT_BASE_URL, api: DEFAULT_API, models: [] };
  }
  if (!catalog[selected.provider]!.models.some((model) => model.id === selected.modelId)) {
    catalog[selected.provider]!.models.push({ id: selected.modelId, name: DEFAULT_MODEL_NAME });
  }

  const agentDir = resolveAgentDir(options.agentDir);
  const modelsPath = join(agentDir, "models.json");
  const authPath = join(agentDir, "auth.json");

  const modelsNext = mergeModelsJson(readJsonFile(modelsPath), catalog);

  const authKeyWritten: string[] = [];
  const authKeyKept: string[] = [];
  const authKeyMissing: string[] = [];
  let authNext = readJsonFile(authPath);
  const defaultProvider = (env.PI_PROVIDER || DEFAULT_PROVIDER).trim();
  for (const provider of Object.keys(catalog)) {
    const key = apiKeyForProvider(env, provider, defaultProvider);
    try {
      const merged = mergeAuthJson(authNext, provider, key, { force });
      authNext = merged.next;
      if (merged.wroteKey) authKeyWritten.push(provider);
      else if (merged.keptExisting) authKeyKept.push(provider);
    } catch (err) {
      if (provider === selected.provider) throw err;
      authKeyMissing.push(provider);
    }
  }

  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeJsonFile(modelsPath, modelsNext);
  writeJsonFile(authPath, authNext, 0o600);

  return {
    agentDir,
    modelsPath,
    authPath,
    copiedEnvExample,
    authKeyWritten,
    authKeyKept,
    authKeyMissing,
    provider: selected.provider,
    modelId: selected.modelId,
  };
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(resolve(entry)).href === metaUrl;
}

function printResult(result: SetupResult): void {
  console.log("✅ 已写入 Pi 原生配置（未打印密钥）");
  console.log(`   目录：${result.agentDir}`);
  console.log(`   模型：${result.provider}/${result.modelId}`);
  console.log(`   models.json：${result.modelsPath}`);
  if (result.authKeyKept.length > 0) {
    console.log(`   auth.json：已有密钥，未覆盖：${result.authKeyKept.join("、")}（覆盖请加 --force）`);
  }
  if (result.authKeyWritten.length > 0) {
    console.log(`   auth.json：已写入密钥：${result.authKeyWritten.join("、")} → ${result.authPath}`);
  }
  if (result.authKeyMissing.length > 0) {
    console.log(
      `   跳过（没找到密钥）：${result.authKeyMissing.join("、")}。` +
        "给它们配 PI_API_KEY_<PROVIDER>，或把默认 provider 的密钥放 PI_API_KEY",
    );
  }
  if (result.copiedEnvExample) {
    console.log("   已从 .env.example 复制 .env，请填 PI_API_KEY 后重新运行 npm run setup");
  }
}

if (isMainModule(import.meta.url)) {
  try {
    printResult(setupPiAgentDir({ force: process.argv.slice(2).includes("--force") }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ ${message}`);
    process.exitCode = 1;
  }
}
