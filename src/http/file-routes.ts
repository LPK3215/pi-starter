/**
 * pi-starter · 文件服务 HTTP 路由
 *
 * 把 `FileService` 的纯文件操作翻译成 HTTP 语义。所有异常都是 AppError，
 * 由统一错误处理决定状态码与「internal 不外泄」。
 *
 * 两个设计要点：
 *   - **预览与原始内容分离**：`/files/read` 只回文本预览（受上限保护），
 *     二进制/大文件走 `/files/raw`，且支持 Range —— 否则预览接口会把大文件
 *     整个塞进响应体，既慢又占内存。
 *   - 原始内容用**流**返回而非读进内存：Range 响应按段推，大文件不进堆。
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Express, Request, Response } from "express";
import { badRequest } from "./errors.js";
import { asyncRoute } from "./routes.js";
import {
  FileService,
  isBinaryExtension,
  DEFAULT_MAX_PREVIEW_BYTES,
} from "../files/service.js";

/** 上传体积上限，与写入上限一致。 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** 取必填的相对路径；缺失即 400，而不是悄悄当成根目录。 */
function requirePath(value: unknown, field = "path"): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${field} 是必填的相对路径`);
  }
  return value;
}

export interface FileRoutesOptions {
  /** 提供后才注册文件路由；省略则不开放任何 `/files/*`。 */
  service?: FileService;
}

export function registerFileRoutes(app: Express, options: FileRoutesOptions = {}): void {
  const service = options.service;
  if (!service) return;

  /** 目录浏览。 */
  app.get("/files/list", (req: Request, res: Response) => {
    res.json(service.list((req.query.path as string | undefined) ?? ""));
  });

  /** 文本预览读。 */
  app.get("/files/read", (req: Request, res: Response) => {
    res.json(service.read(requirePath(req.query.path)));
  });

  /** 覆盖写入。 */
  app.post(
    "/files/write",
    asyncRoute(async (req: Request, res: Response) => {
      const { path, content } = (req.body ?? {}) as { path?: unknown; content?: unknown };
      if (typeof content !== "string") throw badRequest("content 必须是字符串");
      res.json(service.write(requirePath(path), content));
    }),
  );

  /** 新建（要求目标不存在，避免误覆盖）。 */
  app.post(
    "/files/create",
    asyncRoute(async (req: Request, res: Response) => {
      const { path, content } = (req.body ?? {}) as { path?: unknown; content?: unknown };
      res.json(service.create(requirePath(path), typeof content === "string" ? content : ""));
    }),
  );

  /** 重命名 / 移动。 */
  app.post(
    "/files/rename",
    asyncRoute(async (req: Request, res: Response) => {
      const { from, to } = (req.body ?? {}) as { from?: unknown; to?: unknown };
      res.json(service.rename(requirePath(from, "from"), requirePath(to, "to")));
    }),
  );

  /** 复制。目录必须显式 recursive。 */
  app.post(
    "/files/copy",
    asyncRoute(async (req: Request, res: Response) => {
      const { from, to, recursive } = (req.body ?? {}) as {
        from?: unknown;
        to?: unknown;
        recursive?: unknown;
      };
      res.json(service.copy(requirePath(from, "from"), requirePath(to, "to"), recursive === true));
    }),
  );

  /** 删除。目录必须显式 recursive。 */
  app.post(
    "/files/delete",
    asyncRoute(async (req: Request, res: Response) => {
      const { path, recursive } = (req.body ?? {}) as { path?: unknown; recursive?: unknown };
      res.json(service.remove(requirePath(path), recursive === true));
    }),
  );

  /** 原始内容 / 下载，支持 Range（媒体分段靠它）。 */
  app.get("/files/raw", (req: Request, res: Response) => {
    const abs = service.resolvePath(requirePath(req.query.path));
    if (!existsSync(abs)) throw badRequest("文件不存在");
    const st = statSync(abs);
    if (!st.isFile()) throw badRequest("不是文件");

    res.setHeader(
      "Content-Type",
      isBinaryExtension(abs) ? "application/octet-stream" : "text/plain; charset=utf-8",
    );
    res.setHeader("Accept-Ranges", "bytes");

    const range = typeof req.headers.range === "string" ? req.headers.range.trim() : "";
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] !== "" || match[2] !== "")) {
      // bytes=N- / bytes=N-M / bytes=-N（后缀区间：最后 N 字节）
      const hasStart = match[1] !== "";
      const hasEnd = match[2] !== "";
      const start = hasStart ? Number(match[1]) : Math.max(0, st.size - Number(match[2] || 0));
      const end = hasEnd ? Number(match[2]) : st.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
        res.status(416).setHeader("Content-Range", `bytes */${st.size}`);
        res.end();
        return;
      }
      const last = Math.min(end, st.size - 1);
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${last}/${st.size}`);
      res.setHeader("Content-Length", String(last - start + 1));
      createReadStream(abs, { start, end: last }).pipe(res);
      return;
    }

    // 无 Range：超过预览上限直接拒绝并指路 Range，避免无意的巨大响应。
    if (st.size > DEFAULT_MAX_PREVIEW_BYTES) {
      res.status(413).json({
        error: `文件超过 ${DEFAULT_MAX_PREVIEW_BYTES} 字节，请用 Range 请求分段获取`,
        size: st.size,
      });
      return;
    }
    res.setHeader("Content-Length", String(st.size));
    if (req.query.download === "true") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(basename(abs))}"`,
      );
    }
    createReadStream(abs).pipe(res);
  });

  /**
   * base64 上传。
   *
   * 用 JSON + base64 而非 multipart：脚手架不引额外依赖，且 Agent 产出的
   * 「文件内容」本身即可 base64 编码。
   */
  app.post(
    "/files/upload",
    asyncRoute(async (req: Request, res: Response) => {
      const { path, dataBase64, overwrite } = (req.body ?? {}) as {
        path?: unknown;
        dataBase64?: unknown;
        overwrite?: unknown;
      };
      if (typeof dataBase64 !== "string") throw badRequest("dataBase64 必须是 base64 字符串");
      const buf = Buffer.from(dataBase64, "base64");
      if (buf.byteLength > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: `上传内容超过 ${MAX_UPLOAD_BYTES} 字节上限` });
        return;
      }
      if (existsSync(service.resolvePath(requirePath(path))) && overwrite !== true) {
        res.status(409).json({ error: "目标已存在，需显式指定 overwrite" });
        return;
      }
      // 走二进制写入路径：`write` + `toString("utf8")` 会把非 UTF-8 字节替换成 U+FFFD。
      res.json(service.writeBinary(requirePath(path), buf));
    }),
  );
}