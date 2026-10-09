/**
 * pi-starter · 结构化日志
 *
 * 改造前全项目散落 `console.log` / `console.warn`，存在三个问题：
 *   1. **无级别**：安全警告与普通信息混在一起，无法按级别过滤；
 *   2. **无结构**：纯字符串拼接，机器无法解析，聚合与告警无从谈起；
 *   3. **不可注入**：测试无法捕获输出，库嵌入方无法接管。
 *
 * 本模块提供零依赖的结构化 logger：
 *   - 级别（debug/info/warn/error）+ 结构化字段，输出 JSON 行；
 *   - **自动脱敏**：密钥类字段（apiKey / token / password / authorization…）一律打码；
 *   - 可注入 sink（测试/嵌入方接管），默认写 stderr 之外的 stdout 便于管道消费；
 *   - 子 logger 携带固定字段（如 conversationId），避免到处传参。
 *
 * 保留 console 兼容：默认 sink 就是 console，因此行为向后兼容。
 */

/** 日志级别，数值越大越严重。 */
export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** 需要脱敏的字段名（小写包含即命中）。 */
const SECRET_KEYS = [
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "credential",
  "privatekey",
  "session_key",
  "cookie",
];

/** 单条日志允许的最大字符串长度，防止把整段提示词/响应写进日志。 */
const MAX_VALUE_LENGTH = 2000;
/** 提示词类字段：只留摘要与长度（红线：完整正文不落盘），比通用截断更严。 */
const PROMPT_KEYS = ["prompt", "promptbody", "prompttext", "promptsummary", "systemprompt", "userprompt"];
const PROMPT_MAX = 200;

/** 判断字段名是否敏感。 */
export function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEYS.some((needle) => lower.includes(needle));
}

/** 是否为提示词类字段（应只留摘要与长度）。 */
export function isPromptKey(key: string): boolean {
  const lower = key.toLowerCase();
  return PROMPT_KEYS.some((needle) => lower.includes(needle));
}

/* 值级密钥特征：密钥名常常不是字段名，而是内联在自由文本/异常消息/URL 里。 */
const SECRET_INLINE =
  /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|authorization)\b([\s]*[:=][\s]*)([^\s,;'"`&]+)/gi;
const SK_KEY = /\bsk-[A-Za-z0-9_\-]{6,}/g;
const BEARER = /\bbearer\s+[A-Za-z0-9._\-]{6,}/gi;
const EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const CN_ID = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const CN_MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

/**
 * 对任意字符串值做密钥/联系方式脱敏：命中内联 key=value、sk- 前缀、Bearer、邮箱、
 * 18 位身份证、11 位手机号则打码。安全优先，宁可多打码；普通模板文本不受影响。
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(SECRET_INLINE, (_m, name) => `${name}=[redacted]`)
    .replace(SK_KEY, "sk-[redacted]")
    .replace(BEARER, "bearer [redacted]")
    .replace(EMAIL, "[redacted:email]")
    .replace(CN_ID, "[redacted:id]")
    .replace(CN_MOBILE, "[redacted:phone]");
}

/** 脱敏单个值：命中敏感名整体打码；提示词类字段只留摘要与长度；其余字符串值级脱敏 + 超长截断。 */
function sanitizeValue(key: string, value: unknown): unknown {
  if (isSecretKey(key)) return "[redacted]";
  if (typeof value !== "string") return value;
  if (isPromptKey(key)) {
    const len = value.length;
    const head = redactSecrets(value.slice(0, PROMPT_MAX));
    return len > PROMPT_MAX ? `${head}…[prompt omitted: ${len} chars]` : head;
  }
  const redacted = redactSecrets(value);
  if (redacted.length > MAX_VALUE_LENGTH) {
    return `${redacted.slice(0, MAX_VALUE_LENGTH)}…[truncated ${redacted.length - MAX_VALUE_LENGTH}]`;
  }
  return redacted;
}

/** 递归脱敏对象（深度受限，防止循环引用打爆栈）。 */
export function sanitizeFields(fields: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 4) return { "[deep]": true };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null || typeof value !== "object") {
      out[key] = sanitizeValue(key, value);
      continue;
    }
    // Error must be handled before the generic object branch: Error's name/message/stack
    // are non-enumerable, so a plain spread would serialize it to `{}` and lose the cause.
    if (value instanceof Error) {
      out[key] = serializeError(value);
      continue;
    }
    if (Array.isArray(value)) {
      // 数组本身不带敏感名，逐项按索引脱敏，字符串元素统一截断。
      out[key] = value.slice(0, 50).map((item) =>
        typeof item === "string" ? sanitizeValue(key, item) : sanitizeValue(key, JSON.stringify(item)),
      );
      continue;
    }
    out[key] = sanitizeFields(value as Record<string, unknown>, depth + 1);
  }
  return out;
}

/** 保留 Error 的可诊断信息，并限制 stack 长度。 */
function serializeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  // `cause` is where wrapped errors hide the real reason; keep one level, defensively.
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) out.cause = { name: cause.name, message: cause.message };
  else if (typeof cause === "string") out.cause = cause;
  if (typeof err.stack === "string") {
    out.stack =
      err.stack.length > MAX_VALUE_LENGTH ? `${err.stack.slice(0, MAX_VALUE_LENGTH)}…` : err.stack;
  }
  return out;
}

/** 日志输出目的地。 */
export type LogSink = (line: string) => void;

/** 默认 stdout sink（保持向后兼容：库嵌入方未接管时行为不变）。 */
export const stdoutSink: LogSink = (line) => console.log(line);

/**
 * 组合多个 sink（如 stdout + 文件），返回一个把同一行分发到各目标的 sink。
 * 任一子 sink 抛错都不影响其它 sink——落盘失败绝不能拖垮标准输出或主流程。
 */
export function createCompositeSink(sinks: readonly LogSink[]): LogSink {
  return (line) => {
    for (const sink of sinks) {
      try {
        sink(line);
      } catch {
        /* one sink failing must not break the others or the caller */
      }
    }
  };
}

export interface LoggerOptions {
  /** 最小级别，低于此级别不输出。默认 info。 */
  level?: LogLevel;
  /** 输出目的地。默认 console（保持向后兼容）。 */
  sink?: LogSink;
  /** 附加到每条日志的固定字段（如 service / version）。 */
  base?: Record<string, unknown>;
  /** 是否输出结构化 JSON。默认 true；设 false 退回人类可读格式。 */
  json?: boolean;
}

export class Logger {
  private level: LogLevel;
  private readonly sink: LogSink;
  private readonly base: Record<string, unknown>;
  private readonly json: boolean;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.sink = options.sink ?? ((line) => console.log(line));
    this.base = options.base ?? {};
    this.json = options.json !== false;
  }

  /** 派生带固定字段的子 logger（如绑定 conversationId）。 */
  child(fields: Record<string, unknown>): Logger {
    return new Logger({
      level: this.level,
      sink: this.sink,
      base: { ...this.base, ...fields },
      json: this.json,
    });
  }

  /** 运行时调整级别（配置热更新用）。 */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  isEnabled(level: Exclude<LogLevel, "silent">): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.level];
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }

  private write(level: Exclude<LogLevel, "silent">, message: string, fields?: Record<string, unknown>): void {
    if (!this.isEnabled(level)) return;
    const merged = sanitizeFields({ ...this.base, ...(fields ?? {}) });
    // msg 也过一遗脱敏：异常正文常把密钥/提示词内嵌在 message 文本里。
    const safeMsg = redactSecrets(message);
    const ts = new Date().toISOString();
    if (this.json) {
      this.sink(JSON.stringify({ ts, level, msg: safeMsg, ...merged }));
      return;
    }
    const extra = Object.keys(merged).length > 0 ? ` ${JSON.stringify(merged)}` : "";
    this.sink(`${ts} ${level.toUpperCase().padEnd(5)} ${safeMsg}${extra}`);
  }
}

/** 从环境变量解析级别，非法值回落 info。 */
export function resolveLogLevel(env: Record<string, string | undefined> = process.env): LogLevel {
  const raw = env.PI_LOG_LEVEL?.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(raw ?? "") ? (raw as LogLevel) : "info";
}

/** 全局默认 logger。库嵌入方可调用 configureLog 接管。 */
let defaultLogger = new Logger({ level: resolveLogLevel() });

export function getLogger(): Logger {
  return defaultLogger;
}

export function configureLog(options: LoggerOptions): void {
  defaultLogger = new Logger(options);
}

/** 直接落一条日志到全局 logger（模块内不想持有实例时用）。 */
export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => defaultLogger.debug(msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => defaultLogger.info(msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => defaultLogger.warn(msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => defaultLogger.error(msg, fields),
  child: (fields: Record<string, unknown>) => defaultLogger.child(fields),
};
