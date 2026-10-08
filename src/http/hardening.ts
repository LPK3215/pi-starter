/**
 * pi-starter · HTTP 加固
 *
 * Express 默认配置对「本地开发」友好，对「长期运行的服务」过于宽松：
 *   1. `express.json()` **无 body 上限** → 单个请求即可打满内存（DoS）；
 *   2. 无安全响应头 → 缺 CSP / nosniff / frame-ancestors，浏览器端易被嵌入或嗅探；
 *   3. 无请求体日志与超时 → 慢连接长期占用连接。
 *
 * 本模块提供零依赖的加固件：
 *   - `jsonBodyLimit` 带可读报错的 JSON 解析器（超限返回 413 而不是抛栈）；
 *   - `securityHeaders` 纯函数中间件（默认安全，可关）；
 *   - `requestTimeout` 给 socket 设超时，避免 Slowloris 类占用。
 *
 * 设计取舍：不引 helmet（保持「零重依赖」原则），需要的头部手写，行为完全可控。
 */

import express, { type Express, type NextFunction, type Request, type Response } from "express";

/** 默认 JSON body 上限。1 MiB 足够 /chat 与 /db/query，且远低于内存击穿阈值。 */
export const DEFAULT_BODY_LIMIT = "1mb";

/**
 * 安全响应头。
 *
 * 默认值面向「本地工具 + 可能被浏览器访问」的场景，取保守值：
 *   - `X-Content-Type-Options: nosniff`  禁止 MIME 嗅探
 *   - `X-Frame-Options: DENY`           禁止被 iframe 嵌入（点击劫持）
 *   - `Referrer-Policy: no-referrer`    不泄露带路径的 Referer
 *   - `Content-Security-Policy`         默认 `default-src 'self'`，禁止外部资源与内联脚本
 *   - 关闭 `X-Powered-By`               不暴露框架与版本
 *
 * 注：`frame-ancestors` 已取代 X-Frame-Options，但保留后者兼容老浏览器。
 */
export const DEFAULT_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/**
 * 带 body 上限的 JSON 解析器。
 *
 * 为什么不用 `express.json({ limit })`：超限时它抛出的错误体是 HTML，且默认错误处理会把
 * 内部信息带给客户端。这里自己实现，把「超限」翻译成结构化 413 JSON。
 */
export function jsonBodyLimit(limit: string | number = DEFAULT_BODY_LIMIT): express.RequestHandler {
  const parser = express.json({ limit });
  return (req: Request, res: Response, next: NextFunction) => {
    parser(req, res, (err: unknown) => {
      if (!err) return next();
      const status = isPayloadTooLarge(err) ? 413 : 400;
      const message =
        status === 413
          ? `请求体超过上限（${String(limit)}）`
          : "请求体不是合法 JSON";
      res.status(status).json({ ok: false, error: message });
    });
  };
}

/** 识别 body-parser 的 "entity.too.large"（不同版本 message 略有差异）。 */
function isPayloadTooLarge(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { type?: unknown; status?: unknown; statusCode?: unknown };
  if (candidate.type === "entity.too.large") return true;
  const status = candidate.status ?? candidate.statusCode;
  return status === 413;
}

/**
 * 安全响应头中间件。
 * @param headers 覆盖默认值；传 `false` 可整体关闭（仅在自行代理加固时）。
 */
export function securityHeaders(
  headers: Readonly<Record<string, string>> | false = DEFAULT_SECURITY_HEADERS,
): express.RequestHandler {
  return (_req, res, next) => {
    // 恒关闭：暴露框架名等于给攻击者省一次指纹识别。
    res.removeHeader("X-Powered-By");
    if (headers) {
      for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    }
    next();
  };
}

/**
 * socket 超时：防止 Slowloris（慢速发包的连接）长期占用。
 * 必须挂在 server 上而非 app 上，所以这里返回配置对象，由入口应用到 http.Server。
 */
export interface TimeoutOptions {
  /** 收到请求到响应结束的上限（ms）。默认 120s——要给 LLM 长轮次留足时间。 */
  requestTimeoutMs?: number;
  /** 两个 keep-alive 请求之间的空闲上限（ms）。默认 75s。 */
  keepAliveTimeoutMs?: number;
  /** 请求头接收上限（ms）。默认 20s，挡掉慢速头部。 */
  headersTimeoutMs?: number;
}

/** Node 的默认值偏宽松（5s keep-alive / 60s headers），这里给出适合本项目的显式值。 */
export const DEFAULT_TIMEOUTS: Required<TimeoutOptions> = {
  requestTimeoutMs: 120_000,
  keepAliveTimeoutMs: 75_000,
  headersTimeoutMs: 20_000,
};

/**
 * 把超时配置应用到 http.Server。
 * headersTimeout 必须 <= keepAliveTimeout，否则 Node 会直接销毁连接。
 */
export function applyServerTimeouts(
  server: { requestTimeout?: number; keepAliveTimeout?: number; headersTimeout?: number },
  options: TimeoutOptions = {},
): void {
  const merged = { ...DEFAULT_TIMEOUTS, ...options };
  server.requestTimeout = merged.requestTimeoutMs;
  server.keepAliveTimeout = merged.keepAliveTimeoutMs;
  server.headersTimeout = merged.headersTimeoutMs;
}

/** 把加固件一次性装到 app 上。 */
export function hardenApp(
  app: Express,
  options: {
    bodyLimit?: string | number;
    headers?: Readonly<Record<string, string>> | false;
  } = {},
): void {
  app.disable("x-powered-by");
  app.use(securityHeaders(options.headers));
  app.use(jsonBodyLimit(options.bodyLimit ?? DEFAULT_BODY_LIMIT));
}
