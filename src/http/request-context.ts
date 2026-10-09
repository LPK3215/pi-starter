/**
 * pi-starter · 请求上下文与访问日志
 *
 * 补齐既有日志缺失的「请求生命周期」环节，且完全旁路：
 *   - 给每个请求挂一个贯穿全链路的 `request_id`（入口生成/透传 `X-Request-Id`，出口回写头）；
 *   - 入口记 method / path / 脱敏后的 query，出口记 状态码 / 业务码 / 耗时 / 响应体大小；
 *   - 按状态码分级（5xx=error、4xx=warn、其余=info），探针降级为 debug 以免刷屏；
 *   - 通过 WeakMap 暴露 `request_id` 与子 logger，供 SSE 等处理器共享同一条链路，
 *     不改动任何既有返回结构与执行时序。
 *
 * 观测靠包装 res.write/end/json 累加与嗅探，全部原样透传，只做只读统计。
 */

import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getLogger, type Logger } from "../log.js";

const REQUEST_ID_HEADER = "x-request-id";
/** 入站 request_id 的安全字符集与长度上限（挡日志注入 / 超长头）。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** 探针类路径：仍分配 request_id，但访问日志降到 debug，避免健康检查刷爆 INFO。 */
const PROBE_PATHS = new Set(["/health", "/health/ready", "/metrics"]);

interface RequestContext {
  requestId: string;
  log: Logger;
}

const contexts = new WeakMap<Request, RequestContext>();

/** 取该请求的 request_id（中间件未挂时返回 undefined，调用方自行兜底）。 */
export function getRequestId(req: Request): string | undefined {
  return contexts.get(req)?.requestId;
}

/** 取携带 requestId 的子 logger，供处理器（如 SSE）复用同一链路。 */
export function getRequestLogger(req: Request): Logger {
  const ctx = contexts.get(req);
  if (ctx) return ctx.log;
  // 中间件没挂到时也不至于崩：退回一个 anonymous id 的子 logger。
  const id = "anonymous";
  const log = getLogger().child({ component: "http", requestId: id });
  contexts.set(req, { requestId: id, log });
  return log;
}

/** 采纳入站 request_id（仅安全字符集），否则新生成一个。 */
function resolveRequestId(req: Request): string {
  const inbound = req.headers[REQUEST_ID_HEADER];
  const raw = Array.isArray(inbound) ? inbound[0] : inbound;
  if (typeof raw === "string" && REQUEST_ID_PATTERN.test(raw)) return raw;
  return randomUUID();
}

/** 把 query 值收成可安全落盘的形态（超长字符串截断；脱敏交给 logger 按字段名兜底）。 */
function summarizeQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    out[key] = typeof value === "string" && value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  return out;
}

/**
 * 请求上下文中间件。挂在 body 解析之后、业务路由之前，使 `request_id`、`req.query`
 * 与响应统计对所有内核与嵌入方路由一致生效。
 */
export function requestContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = resolveRequestId(req);
    // 回写响应头，客户端与上游网关可据此对齐日志。
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const isProbe = PROBE_PATHS.has(req.path);
    const log = getLogger().child({ component: "http", requestId });
    contexts.set(req, { requestId, log });

    const startedAt = performance.now();
    let responseBytes = 0;
    let bizOk: boolean | undefined;
    let bizCode: string | undefined;

    // 只读观测：累加写出字节 + 嗅探业务码，全部原样透传给真实实现。
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      responseBytes += byteLength(chunk);
      return (write as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof res.write;
    res.end = ((chunk?: unknown, ...rest: unknown[]): Response => {
      responseBytes += byteLength(chunk);
      return (end as (c?: unknown, ...r: unknown[]) => Response)(chunk, ...rest);
    }) as typeof res.end;

    const json = res.json.bind(res);
    res.json = ((body: unknown): Response => {
      captureBusinessCode(body, (ok, code) => {
        bizOk = ok;
        bizCode = code;
      });
      return (json as (b: unknown) => Response)(body);
    }) as typeof res.json;

    // 入口：只记方法/路径/脱敏 query，绝不记请求体（提示词等正文由各自的摘要日志处理）。
    emitEntry(log, isProbe, "http request started", {
      method: req.method,
      path: req.path,
      query: summarizeQuery(req.query as Record<string, unknown>),
      remote: req.ip,
    });

    let finished = false;
    res.on("finish", () => {
      if (finished) return;
      finished = true;
      const status = res.statusCode;
      const fields = {
        method: req.method,
        path: req.path,
        statusCode: status,
        ...(bizOk !== undefined ? { bizOk } : {}),
        ...(bizCode !== undefined ? { bizCode } : {}),
        durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        responseBytes,
      };
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      if (level === "info" && isProbe) {
        emitEntry(log, true, "http request completed", fields);
      } else {
        log[level]("http request completed", fields);
      }
    });

    next();
  };
}

/** 入口/完成事件：探针请求把 info 降为 debug，其它照发。 */
function emitEntry(log: Logger, downgrade: boolean, msg: string, fields: Record<string, unknown>): void {
  if (downgrade) log.debug(msg, fields);
  else log.info(msg, fields);
}

function byteLength(chunk: unknown): number {
  if (chunk == null) return 0;
  if (typeof chunk === "string") return Buffer.byteLength(chunk);
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

/** 从响应体里嗅探业务码（内核统一 `{ ok, error? }` 形态）；仅用于观测，不改响应。 */
function captureBusinessCode(
  body: unknown,
  set: (ok: boolean | undefined, code: string | undefined) => void,
): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const record = body as Record<string, unknown>;
  if (typeof record.ok === "boolean") {
    const code =
      typeof record.code === "string"
        ? record.code
        : record.ok
          ? undefined
          : typeof record.error === "string"
            ? "error"
            : undefined;
    set(record.ok, code);
  }
}
