/**
 * pi-starter · 多把 API 密钥（按名字寻址）
 *
 * 同一个 provider 持多把 key，运行时切「当前用哪把」。存储在
 * `<agentDir>/provider-keys.json`：
 *
 *   { "modelscope": { "activeKeyName": "work", "keys": [{ "name": "work", "apiKey": "sk-…" }] } }
 *
 * ── 铁律：原始 key 值（以及它的任何派生形式，掩码、片段、长度）**永不出服务端**。
 * 对外只有 `name` 与 `active` 两个布尔信息。
 * 为什么不给「掩码」：掩码会把长度与前后缀泄露出去，而 key 的寻址依据本来就是**名字**，
 * 给不给掩码对使用没有任何影响，却能把猜测空间缩小一截。所以 `describe()` 是唯一的出口，
 * 它在类型层面就不可能返回 apiKey 字段。
 *
 * ── 不做：OAuth 流程、provider 配置增删改 UI、连接测试。
 * 那是 provider 管理台（对方约 1900 行），不是脚手架该背的。
 *
 * 落盘语义与 `fileSettingsPort` 一致：原子写（临时文件 + 同目录 rename）、
 * 损坏回落空库而不是让服务起不来。额外把文件权限收到 0600——里面是明文密钥。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { validationFailed } from "./errors.js";

/** 单个 provider 的密钥条数上限。 */
export const MAX_PROVIDER_KEYS = 20;

/** provider 名：与 `PI_MODELS` 里的 provider 同一套字符集。 */
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/** 密钥名：非空、不含路径分隔符、长度受限（它会进 URL 路径）。 */
const KEY_NAME_RE = /^[^\s/\\]{1,64}$/;

/** 对外可见的密钥条目。**注意这里没有 apiKey 字段，是刻意的。** */
export interface ProviderKeyInfo {
  name: string;
  active: boolean;
}

export interface ProviderKeyStore {
  /** 已配置密钥的 provider 名（按字典序）。 */
  providers(): string[];
  /** 某个 provider 的密钥清单（不含密钥值）。 */
  list(provider: string): ProviderKeyInfo[];
  /** 某个 provider 当前激活的密钥名。 */
  activeName(provider: string): string | undefined;
  /**
   * 取原始密钥值。**只供服务端内部使用**（换 key / 日志之外的注入），
   * 任何返回体都不得经过它。
   */
  resolve(provider: string, name?: string): string | undefined;
  /** 新增或覆盖一把密钥；第一把自动成为激活项。 */
  set(provider: string, name: string, apiKey: string): ProviderKeyInfo[];
  /** 删除一把。删掉的是激活项时，落到剩下的第一把；一把都不剩则清空激活项。 */
  remove(provider: string, name: string): void;
  /** 切换激活项。 */
  activate(provider: string, name: string): void;
}

interface StoredKey {
  name: string;
  apiKey: string;
}

interface StoredProvider {
  activeKeyName?: string;
  keys: StoredKey[];
}

type StoredFile = Record<string, StoredProvider>;

/** 默认落盘位置：与其它 pi-starter 配置同处。 */
export function defaultProviderKeysFile(): string {
  return join(getAgentDir(), "provider-keys.json");
}

function assertProvider(provider: string): void {
  if (!PROVIDER_RE.test(provider)) {
    throw validationFailed(`provider 只能是字母数字与 - _，收到：${provider}`);
  }
}

function assertKeyName(name: string): void {
  if (!KEY_NAME_RE.test(name)) {
    throw validationFailed("密钥名不能为空、不能含空白或路径分隔符，且不超过 64 字符");
  }
}

/**
 * 读盘时逐条过滤：文件是外部输入（可能被手改、被截断、被塞进奇怪内容）。
 * 只留下「provider 名合法 + 密钥名合法 + apiKey 是非空字符串」的条目。
 */
function sanitize(raw: unknown): StoredFile {
  const out: StoredFile = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!PROVIDER_RE.test(provider)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as { activeKeyName?: unknown; keys?: unknown };
    if (!Array.isArray(entry.keys)) continue;
    const keys: StoredKey[] = [];
    const seen = new Set<string>();
    for (const item of entry.keys) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const key = item as { name?: unknown; apiKey?: unknown };
      if (typeof key.name !== "string" || !KEY_NAME_RE.test(key.name)) continue;
      if (typeof key.apiKey !== "string" || !key.apiKey.trim()) continue;
      if (seen.has(key.name)) continue;
      seen.add(key.name);
      if (keys.length >= MAX_PROVIDER_KEYS) break;
      keys.push({ name: key.name, apiKey: key.apiKey });
    }
    if (keys.length === 0) continue;
    const active =
      typeof entry.activeKeyName === "string" && seen.has(entry.activeKeyName)
        ? entry.activeKeyName
        : keys[0]!.name;
    out[provider] = { activeKeyName: active, keys };
  }
  return out;
}

export function createProviderKeyStore(
  filePath: string,
  options: { logger?: (msg: string, err: unknown) => void } = {},
): ProviderKeyStore {
  const log = options.logger;
  let data: StoredFile = load();

  function load(): StoredFile {
    if (!existsSync(filePath)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      const clean = sanitize(parsed);
      const dropped = Object.keys((parsed ?? {}) as Record<string, unknown>).length - Object.keys(clean).length;
      if (dropped > 0) log?.("provider-keys.json 中有不可信条目被丢弃", dropped);
      return clean;
    } catch (err) {
      // 密钥文件损坏不该让服务起不来：回落成空库，用户重新加一把即可。
      log?.("provider-keys.json 无法解析，已回落为空库", err);
      return {};
    }
  }

  function persist(): void {
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      const tmp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      // 临时文件也要收紧：它同样含明文密钥，且窗口期更短更隐蔽。
      try {
        chmodSync(tmp, 0o600);
      } catch {
        /* Windows 上是尽力而为 */
      }
      renameSync(tmp, filePath);
      try {
        chmodSync(filePath, 0o600);
      } catch {
        /* Windows 上是尽力而为 */
      }
    } catch (err) {
      // 落盘失败不撤销内存改动（否则「加一把」看起来成功却重启就没），
      // 但必须让调用方知道没存上。
      log?.("provider-keys.json 落盘失败（改动已在内存生效）", err);
      throw err;
    }
  }

  function describe(provider: string): ProviderKeyInfo[] {
    const entry = data[provider];
    if (!entry) return [];
    return entry.keys.map((key) => ({ name: key.name, active: key.name === entry.activeKeyName }));
  }

  return {
    providers: () => Object.keys(data).sort(),
    list: (provider) => describe(provider),
    activeName: (provider) => data[provider]?.activeKeyName,
    resolve: (provider, name) => {
      const entry = data[provider];
      if (!entry) return undefined;
      const target = name ?? entry.activeKeyName;
      if (!target) return undefined;
      return entry.keys.find((key) => key.name === target)?.apiKey;
    },
    set: (provider, name, apiKey) => {
      assertProvider(provider);
      assertKeyName(name);
      if (typeof apiKey !== "string" || !apiKey.trim()) {
        throw validationFailed("apiKey 不能为空");
      }
      const entry = data[provider] ?? { keys: [] };
      const index = entry.keys.findIndex((key) => key.name === name);
      if (index >= 0) entry.keys[index] = { name, apiKey };
      else {
        if (entry.keys.length >= MAX_PROVIDER_KEYS) {
          throw validationFailed(`每个 provider 最多 ${MAX_PROVIDER_KEYS} 把密钥`);
        }
        entry.keys.push({ name, apiKey });
      }
      // 第一把自动成为激活项：加完就能用，不需要再手动切一次。
      if (!entry.activeKeyName || !entry.keys.some((key) => key.name === entry.activeKeyName)) {
        entry.activeKeyName = name;
      }
      data[provider] = entry;
      persist();
      return describe(provider);
    },
    remove: (provider, name) => {
      assertProvider(provider);
      const entry = data[provider];
      if (!entry) throw validationFailed(`没有 ${provider} 的密钥`);
      const before = entry.keys.length;
      entry.keys = entry.keys.filter((key) => key.name !== name);
      if (entry.keys.length === before) throw validationFailed(`没有名为 ${name} 的密钥`);
      if (entry.activeKeyName === name) {
        // 激活项被删：落到剩下的第一把，而不是留下一个指向已删名字的悬空激活项。
        entry.activeKeyName = entry.keys[0]?.name;
      }
      if (entry.keys.length === 0) delete data[provider];
      else data[provider] = entry;
      persist();
    },
    activate: (provider, name) => {
      assertProvider(provider);
      assertKeyName(name);
      const entry = data[provider];
      if (!entry || !entry.keys.some((key) => key.name === name)) {
        throw validationFailed(`没有名为 ${name} 的密钥`);
      }
      entry.activeKeyName = name;
      data[provider] = entry;
      persist();
    },
  };
}