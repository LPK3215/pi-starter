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
 *   3. 持久化通过注入的 SettingsPort 完成，默认内存实现 → 零 IO，测试无需落盘。
 */

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

  /** 用 schema 校验并填充默认值。非法字段直接抛错（不静默丢弃）。 */
  private normalize(raw: Record<string, unknown> | undefined): Settings {
    const result: Record<string, unknown> = { ...this.defaults };
    if (raw) {
      for (const [key, value] of Object.entries(raw)) {
        const validator = this.schema[key];
        if (!validator) throw new Error(`Unknown settings field: ${key}`);
        result[key] = validator(value);
      }
    }
    return result as Settings;
  }

  /** 当前设置（浅拷贝，防止外部改动内部状态）。 */
  get(): Settings {
    return { ...this.current, disabledTools: [...this.current.disabledTools] };
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
      next[key] = validator(value);
    }
    this.current = next as Settings;
    this.port.save(this.get());
    return this.get();
  }

  /** 重置为默认值。 */
  reset(): Settings {
    this.current = { ...this.defaults, disabledTools: [...this.defaults.disabledTools] };
    this.port.save(this.get());
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
