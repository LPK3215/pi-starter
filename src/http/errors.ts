/**
 * pi-starter · 类型化错误
 *
 * 改造前 `app.ts` 里有 9 处 `catch (err: unknown) { res.status(400).json({ error: err.message }) }`，
 * 带来两个问题：
 *   1. **样板重复**：每加一路由就要重写一遍 try/catch + 取 message；
 *   2. **内部细节泄漏**：数据库绝对路径、SQL 驱动报错、SDK 内部信息会原样回给客户端。
 *
 * 本模块提供 `AppError`：
 *   - `code`：机器可判别的稳定标识，便于客户端分支处理；
 *   - `httpStatus`：默认 HTTP 状态码；
 *   - `safeToExpose`：默认 **false** —— 未显式声明可暴露的错误一律返回通用文案，
 *     真实原因只进服务端日志。这是「默认安全」原则的落地。
 *
 * 用法：
 *   throw new AppError("not_found", `no such skill: ${name}`, { httpStatus: 404, expose: true });
 *   throw new AppError("invalid_input", "id must be an integer");
 */

/** 稳定的错误码。新增时保持向后兼容（只增不改）。 */
export const APP_ERROR_CODES = [
  "bad_request",
  "validation_failed",
  "not_found",
  "conflict",
  "rate_limited",
  "busy",
  "payload_too_large",
  "read_only_sql",
  "internal",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export interface AppErrorOptions {
  /** HTTP status. Defaults per code. */
  httpStatus?: number;
  /**
   * Whether `message` may be sent to the client verbatim.
   *
   * Defaults to true for the codes in ALWAYS_EXPOSED (their messages are written for the
   * caller) and **false** for everything else — notably `internal`, where the default
   * assumption is that the text carries paths, driver errors or SDK internals.
   */
  expose?: boolean;
  /** Structured context for logs. Never sent to the client. */
  details?: Record<string, unknown>;
  /** Underlying error, preserved for logs and `cause` chains. */
  cause?: unknown;
}

/** Default status per code — keeps status choices consistent across routes. */
const DEFAULT_STATUS: Record<AppErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  busy: 429,
  payload_too_large: 413,
  read_only_sql: 400,
  internal: 500,
};

/**
 * Codes whose messages are always safe to return.
 *
 * These are messages this project writes *for* the client (or a model) — a rejected field
 * name, the offending SQL keyword — so suppressing them would only make the caller guess.
 * Everything else defaults to hidden.
 */
const ALWAYS_EXPOSED: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  "bad_request",
  "validation_failed",
  "not_found",
  "conflict",
  "rate_limited",
  "busy",
  "payload_too_large",
  "read_only_sql",
]);

/** Generic text shown when an error is not explicitly safe to expose. */
const GENERIC_MESSAGE: Record<number, string> = {
  400: "请求无效",
  404: "资源不存在",
  409: "状态冲突",
  413: "请求体过大",
  429: "请求过于频繁，请稍后重试",
  500: "服务器内部错误",
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly httpStatus: number;
  readonly safeToExpose: boolean;
  readonly details: Record<string, unknown>;

  constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? DEFAULT_STATUS[code] ?? 500;
    this.safeToExpose = options.expose ?? ALWAYS_EXPOSED.has(code);
    this.details = options.details ?? {};
    // Keep the stack clean: the constructor frame adds nothing.
    Error.captureStackTrace?.(this, AppError);
  }

  /** What the client is allowed to see. */
  clientMessage(): string {
    if (this.safeToExpose) return this.message;
    return GENERIC_MESSAGE[this.httpStatus] ?? GENERIC_MESSAGE[500]!;
  }

  /** Everything for the server log: code, message, details, cause. */
  toLogFields(): Record<string, unknown> {
    const cause = this.cause;
    return {
      code: this.code,
      httpStatus: this.httpStatus,
      // The real message is logged even when the client sees a generic one.
      message: this.message,
      details: this.details,
      ...(cause instanceof Error ? { cause: { name: cause.name, message: cause.message } } : {}),
    };
  }
}

/** Convenience constructors for the common cases. */
export const badRequest = (msg: string, opts?: AppErrorOptions) =>
  new AppError("bad_request", msg, { expose: true, ...opts });
export const notFound = (msg: string, opts?: AppErrorOptions) =>
  new AppError("not_found", msg, { expose: true, ...opts });
export const validationFailed = (msg: string, opts?: AppErrorOptions) =>
  new AppError("validation_failed", msg, { expose: true, ...opts });
export const busy = (msg = "agent is busy, try again shortly", opts?: AppErrorOptions) =>
  new AppError("busy", msg, { expose: true, ...opts });

/** Wrap an unknown thrown value into an AppError without losing the original. */
export function toAppError(err: unknown, fallbackCode: AppErrorCode = "internal"): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // Unknown failures are internal by default: never leak their text to the client.
  return new AppError(fallbackCode, message, { cause: err });
}

/** Express error-handling middleware. Mount LAST, after all routes. */
export function errorHandler(logError: (fields: Record<string, unknown>) => void) {
  return (err: unknown, _req: unknown, res: import("express").Response, next: import("express").NextFunction): void => {
    // Headers already sent → the response is committed; hand off to Express to close it.
    if (res.headersSent) {
      next(err);
      return;
    }
    const appErr = toAppError(err);
    logError(appErr.toLogFields());
    res.status(appErr.httpStatus).json({ error: appErr.clientMessage() });
  };
}
