/**
 * pi-starter · 设置服务（settings）
 *
 * pi-web-ui 的 settings-service 有 1000+ 行，核心是「显式枚举字段 + 逐字段校验」，
 * 避免 `set_settings` 变成任意 JSON 注入。本方案保留该原则，但用**声明式 schema**实现：
 *
 *   const schema = { toolApprovalEnabled: bool(), ... }
 *
 * 好处：
 *   1. 新增字段 = 在 schema 加一行，校验、默认值、持久化、UI 列表自动跟上；
 *   2. 校验是纯函数，可单测；未知字段被显式拒绝（不静默吞掉）；
 *   3. 持久化通过注入的 SettingsPort 完成，默认内存实现 → 零IO，测试无需落盘；
 *      生产用 `fileSettingsPort()` 落盘（原子写，重启不丢配置）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 字段校验器：返回规范化后的值，非法则抛错。 */
export type FieldValidator<T> = (raw: unknown) => T;

export interface SettingsSchema {
  [key: string]: FieldValidator<unknown>;
}

/** 校验器工厂：布尔。 */
export function bool(): FieldValidator<boolean> {
  return (raw) => {
    if (typeof raw === "boolean") return raw;
    throw new Error(`Expected boolean, got ${typeof raw}`);
  };
}

/** 校验器工厂：枚举字符串。 */
export function enumOf<T extends string>(allowed: readonly T[]): FieldValidator<T> {
  return (raw) => {
    if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) return raw as T;
    throw new Error(`Expected ${allowed.join(" | ")}, got ${String(raw)}`);
  };
}

/** 校验器工厂：字符串。 */
export function str(options: { maxLength?: number } = {}): FieldValidator<string> {
  return (raw) => {
    if (typeof raw !== "string") throw new Error(`Expected string, got ${typeof raw}`);
    if (options.maxLength !== undefined && raw.length > options.maxLength) {
      throw new Error(`Length exceeds limit ${options.maxLength}`);
    }
    return raw;
  };
}

/** 校验器工厂：非负整数。 */
export function int(options: { min?: number; max?: number } = {}): FieldValidator<number> {
  return (raw) => {
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      throw new Error(`Expected integer, got ${String(raw)}`);
    }
    if (options.min !== undefined && raw < options.min) throw new Error(`Must be >= ${options.min}`);
    if (options.max !== undefined && raw > options.max) throw new Error(`Must be <= ${options.max}`);
    return raw;
  };
}

/** 校验器工厂：字符串数组。 */
export function strList(options: { maxItems?: number } = {}): FieldValidator<string[]> {
  return (raw) => {
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
      throw new Error("Expected array of strings");
    }
    if (options.maxItems !== undefined && raw.length > options.maxItems) {
      throw new Error(`Too many items (max ${options.maxItems})`);
    }
    // Copy: never alias the caller's array, otherwise later external mutation would
    // silently rewrite the stored settings.
    return [...(raw as string[])];
  };
}

/**
 * 一个外部 stdio MCP 服务器的声明式配置。
 *
 * 只收「启动它需要什么」，不收任何回调：工具的实际调用由 mcp/bridge.ts 负责，
 * 这样设置文件始终是纯数据，`PATCH /settings` 才不会被退化成任意 JSON 注入。
 */
export interface McpServerConfig {
  /** 服务器名（工具名前缀 `mcp__<name>__<tool>` 的一部分）。 */
  name: string;
  command: string;
  args: string[];
  /** 追加给子进程的环境变量。 */
  env?: Record<string, string>;
  /** 子进程工作目录。缺省继承本进程。 */
  cwd?: string;
}

/** 服务器数量上限。桥会为每个 server 拉一个子进程，无上限等于无界开进程。 */
export const MAX_MCP_SERVERS = 16;

/** 服务器名：工具名前缀必须是合法标识符，所以名字也必须收敛到这个字符集。 */
const MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * MCP 服务器列表校验器。
 *
 * 严格逐条校验：一条非法就整条抛错，由调用方决定是拒绝（API）还是剔除（落盘）。
 * 错误信息带下标，否则用户只能看到「mcpServers: Expected array of objects」，
 * 根本不知道是哪一条服务器配错了。
 */
export function mcpServerList(): FieldValidator<McpServerConfig[]> {
  return (raw) => {
    if (!Array.isArray(raw)) throw new Error("Expected array of MCP server configs");
    if (raw.length > MAX_MCP_SERVERS) throw new Error(`Too many MCP servers (max ${MAX_MCP_SERVERS})`);
    const seen = new Set<string>();
    return raw.map((entry, index) => {
      const at = `mcpServers[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`${at}: expected an object`);
      }
      const item = entry as Record<string, unknown>;
      const name = item.name;
      if (typeof name !== "string" || !MCP_NAME_RE.test(name)) {
        throw new Error(`${at}.name must match ${MCP_NAME_RE.source}`);
      }
      if (seen.has(name)) throw new Error(`${at}.name duplicated: ${name}`);
      seen.add(name);
      const command = item.command;
      if (typeof command !== "string" || !command.trim()) {
        throw new Error(`${at}.command must be a non-empty string`);
      }
      const args = item.args ?? [];
      if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
        throw new Error(`${at}.args must be an array of strings`);
      }
      const out: McpServerConfig = { name, command, args: [...(args as string[])] };
      if (item.env !== undefined) {
        if (!item.env || typeof item.env !== "object" || Array.isArray(item.env)) {
          throw new Error(`${at}.env must be an object of string values`);
        }
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(item.env as Record<string, unknown>)) {
          if (typeof value !== "string") throw new Error(`${at}.env.${key} must be a string`);
          env[key] = value;
        }
        out.env = env;
      }
      if (item.cwd !== undefined) {
        if (typeof item.cwd !== "string" || !item.cwd.trim()) {
          throw new Error(`${at}.cwd must be a non-empty string`);
        }
        out.cwd = item.cwd;
      }
      return out;
    });
  };
}

/** 持久化端口（默认内存；接文件 / 数据库由调用方注入）。 */
export interface SettingsPort {
  load(): Record<string, unknown> | undefined;
  save(settings: Record<string, unknown>): void;
}

/** 内存端口：零 IO，测试默认。 */
export function memorySettingsPort(initial?: Record<string, unknown>): SettingsPort {
  let data = initial;
  return {
    load: () => data,
    save: (settings) => {
      data = settings;
    },
  };
}

/**
 * 文件端口：落盘 JSON，重启后设置不丢。
 *
 * 两个必须做对的细节：
 *   1. **原子写**——先写同目录临时文件再`rename`。直接覆盖的话，进程在写到一半时被杀
 *      会留下截断的 JSON，下次启动就再也读不出来了（这是配置文件最经典的损坏方式）。
 *   2. **读失败不致命**——文件不存在返回 undefined（走默认值）；文件损坏则**告警并回落默认**，
 *      而不是让整个服务起不来。配置坏了应该能被用户改回来，而不是变成死局。
 */
export function fileSettingsPort(
  filePath: string,
  options: {
    logger?: (msg: string, err: unknown) => void;
    /**
     * 可选的清洗函数。提供时，返回内容先经它过滤再交给 SettingsService，
     * 于是「文件里有非法字段」也只会被剔除+告警，而不会让服务起不来。
     */
    sanitize?: (raw: Record<string, unknown>) => Record<string, unknown>;
  } = {},
): SettingsPort {
  const log = options.logger;
  const clean = options.sanitize ?? ((raw: Record<string, unknown>) => raw);
  return {
    load: () => {
      if (!existsSync(filePath)) return undefined;
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          log?.("设置文件不是对象，已回落默认值", parsed);
          return undefined;
        }
        return clean(parsed as Record<string, unknown>);
      } catch (err) {
        log?.("设置文件无法解析，已回落默认值", err);
        return undefined;
      }
    },
    save: (settings) => {
      const dir = dirname(filePath);
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${basename(filePath)}.${process.pid}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      // rename 在同目录内是原子的：要么旧文件，要么新文件，不会出现中间态。
      renameSync(tmp, filePath);
    },
  };
}

/**
 * 把落盘内容里不合法的字段剔除，返回可安全加载的部分。
 *
 * 为什么 API 路径严格拒绝、落盘路径却要容错：
 *   - `PATCH /settings` 来自客户端，**必须**拒绝未知字段（否则 `set_settings` 退化成
 *     任意 JSON 注入）；
 *   - 配置文件是**用户自己早先**写下的，里面可能有旧版本遗留字段或手改错的内容。
 *     让它把整个服务卡在起不来的状态是最差结果——用户改不回来，只能手工删文件。
 *   所以这里剔除并报告，而不是抛错；`dropped` 让调用方可以明确告知用户。
 */
export function sanitizeSettings(
  raw: Record<string, unknown> | undefined,
  schema: SettingsSchema = SETTINGS_SCHEMA,
): { clean: Record<string, unknown>; dropped: string[] } {
  const clean: Record<string, unknown> = {};
  const dropped: string[] = [];
  if (!raw) return { clean, dropped };
  for (const [key, value] of Object.entries(raw)) {
    const validator = schema[key];
    if (!validator) {
      dropped.push(key);
      continue;
    }
    try {
      clean[key] = validator(value);
    } catch {
      // 值非法：同样剔除，而不是让构造抛错。
      dropped.push(key);
    }
  }
  return { clean, dropped };
}

/** 默认设置文件路径：`~/.pi/agent/pi-starter-settings.json`（与SDK 配置同处）。 */
export function defaultSettingsFile(): string {
  return join(getAgentDir(), "pi-starter-settings.json");
}

/** 已知设置的默认值 + schema（单一事实源）。 */
export const SETTINGS_DEFAULTS = {
  toolApprovalEnabled: false,
  approvalMode: "off" as "off" | "all" | "category",
  disabledTools: [] as string[],
  thinkingLevel: "default",
  locale: "zh-CN",
  promptTemplate: "",
  contextKeepRecent: 6,
  /** 单个工具执行超时（秒）。0 = 关闭看门狗。默认 1200s（20 分钟）。 */
  toolTimeoutSeconds: 1200,
  /** 新会话是否默认进入计划模式（会话内可单独开关）。 */
  planMode: false,
  /** 外部 stdio MCP 服务器清单。空 = 不接任何外部工具。 */
  mcpServers: [] as McpServerConfig[],
  /**
   * 是否加载脚手架自带的示例知识库（`about.md`）。
   * 业务方接自己的知识库时通常要关掉——它会被写进系统提示词。
   */
  builtinKnowledge: true,
  /** 是否加载脚手架自带的示例技能（`summarize`）。同上。 */
  builtinSkills: true,
};

export const SETTINGS_SCHEMA: SettingsSchema = {
  toolApprovalEnabled: bool(),
  approvalMode: enumOf(["off", "all", "category"] as const),
  disabledTools: strList({ maxItems: 256 }),
  thinkingLevel: str({ maxLength: 32 }),
  locale: str({ maxLength: 32 }),
  promptTemplate: str({ maxLength: 20000 }),
  contextKeepRecent: int({ min: 1, max: 200 }),
  toolTimeoutSeconds: int({ min: 0, max: 86400 }),
  planMode: bool(),
  mcpServers: mcpServerList(),
  builtinKnowledge: bool(),
  builtinSkills: bool(),
};

export type Settings = typeof SETTINGS_DEFAULTS;

/**
 * 设置服务：显式枚举字段，未知字段拒绝。
 */
export class SettingsService {
  private current: Settings;

  constructor(
    private readonly port: SettingsPort = memorySettingsPort(),
    schema: SettingsSchema = SETTINGS_SCHEMA,
    defaults: Settings = SETTINGS_DEFAULTS,
  ) {
    this.schema = schema;
    this.defaults = defaults;
    this.current = this.normalize(port.load());
  }

  private readonly schema: SettingsSchema;
  private readonly defaults: Settings;

  /**
   * 跑一个字段的校验器，把**字段名**补进报错。
   *
   * 校验器只知道「我期望 boolean」，不知道「我在校验 builtinKnowledge」。缺了字段名
   * 之后，一次改多个字段时用户只能看到「Expected boolean, got string」，无从定位。
   */
  private runValidator(
    key: string,
    validator: FieldValidator<unknown>,
    value: unknown,
  ): unknown {
    try {
      return validator(value);
    } catch (err) {
      throw new Error(`${key}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  /** 用 schema 校验并填充默认值。非法字段直接抛错（不静默丢弃）。 */
  private normalize(raw: Record<string, unknown> | undefined): Settings {
    const result: Record<string, unknown> = { ...this.defaults };
    if (raw) {
      for (const [key, value] of Object.entries(raw)) {
        const validator = this.schema[key];
        if (!validator) throw new Error(`Unknown settings field: ${key}`);
        result[key] = this.runValidator(key, validator, value);
      }
    }
    return result as Settings;
  }

  /** 当前设置（深拷贝可变字段，防止外部改动内部状态）。 */
  get(): Settings {
    return {
      ...this.current,
      disabledTools: [...this.current.disabledTools],
      // Copy the servers too: `mcpServers` holds a nested env record, and the bridge
      // holds on to what it is handed. A shared reference would let a later caller
      // rewrite our live config without going through patch() (and without persisting).
      mcpServers: this.current.mcpServers.map((server) => ({
        ...server,
        args: [...server.args],
        ...(server.env ? { env: { ...server.env } } : {}),
      })),
    };
  }

  /**
   * 注册一个「设置变了」的回调（WS `set_settings` 与 REST `PATCH /settings` 都会触发）。
   *
   * MCP 桥靠它做到改配置即生效：谁都不必记得在每个写入点手动调一次 `sync()`——
   * 漏一次的表现是「配置改了但工具没变」，而那从代码上看不出来。
   *
   * 回调抛错**不**回滚设置：设置已经落盘，回滚会让文件与内存不一致。
   */
  setOnChange(listener: (settings: Settings) => void): void {
    this.onChange = listener;
  }

  private onChange: ((settings: Settings) => void) | undefined;

  private notifyChange(): void {
    if (!this.onChange) return;
    try {
      this.onChange(this.get());
    } catch {
      /* listener failures must not corrupt the applied settings */
    }
  }

  /** 读取单个字段。 */
  getField<K extends keyof Settings>(key: K): Settings[K] {
    return this.current[key];
  }

  /**
   * 局部更新：只校验传入字段，其余保持不变；成功则持久化。
   * 校验失败抛错且**不改变任何状态**（原子性）。
   */
  patch(partial: Record<string, unknown>): Settings {
    const next: Record<string, unknown> = { ...this.current };
    for (const [key, value] of Object.entries(partial)) {
      const validator = this.schema[key];
      if (!validator) throw new Error(`Unknown settings field: ${key}`);
      next[key] = this.runValidator(key, validator, value);
    }
    this.current = next as Settings;
    this.port.save(this.get());
    this.notifyChange();
    return this.get();
  }

  /** 重置为默认值。 */
  reset(): Settings {
    this.current = {
      ...this.defaults,
      disabledTools: [...this.defaults.disabledTools],
      mcpServers: [],
    };
    this.port.save(this.get());
    this.notifyChange();
    return this.get();
  }
}

/** 校验一组设置字段（不落地），返回第一个错误的可读信息；全部合法返回 null。 */
export function validateSettings(
  partial: Record<string, unknown>,
  schema: SettingsSchema = SETTINGS_SCHEMA,
): string | null {
  for (const [key, value] of Object.entries(partial)) {
    const validator = schema[key];
    if (!validator) return `Unknown settings field: ${key}`;
    try {
      validator(value);
    } catch (err) {
      return `${key}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return null;
}
