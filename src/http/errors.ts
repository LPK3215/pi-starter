/**
 * pi-starter · HTTP 错误中间件
 *
 * 本模块只保留 **Express 专属**的那一层：把任意抛出值翻译成响应。
 * 错误原语（`AppError` / `badRequest` / `toAppError` / `clientErrorMessage` …）已下沉到
 * `src/errors.ts` —— 它们与传输层无关，`sessions/`、`files/`、`approval/` 这些内层模块
 * 以前反向依赖 `http/` 取它们，方向是反的。
 *
 * 消费方按需要选路径：
 *   - 要构造/判定错误    → `../errors.js`（或同目录的 `../errors.js`）
 *   - 要挂 Express 中间件 → 本模块的 `errorHandler`
 */

import { toAppError } from "../errors.js";

/** Express error-handling middleware. Mount LAST, after all routes. */
export function errorHandler(
  logError: (fields: Record<string, unknown>, req: import("express").Request) => void,
) {
  return (err: unknown, req: import("express").Request, res: import("express").Response, next: import("express").NextFunction): void => {
    // Headers already sent → the response is committed; hand off to Express to close it.
    if (res.headersSent) {
      next(err);
      return;
    }
    const appErr = toAppError(err);
    // req is passed so the caller can bind the request's request_id to this error line.
    logError(appErr.toLogFields(), req);
    res.status(appErr.httpStatus).json({ error: appErr.clientMessage() });
  };
}
