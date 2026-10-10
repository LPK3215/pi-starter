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
import { badRequest } from "../errors.js";
import { asyncRoute } from "./routes.js";
import { FileService, isBinaryExtension } from "../files/service.js";

/**
 * 上传体积上限，与 `FileService` 的写入上限一致。
 *
 * 注意这是**第二层**上限。JSON body 上限（`createApp({ bodyLimit })`，默认 `1mb`）先挡一道，
 * 而 base64 会放大约 4/3 —— 所以**默认配置下原始字节刚过 1MB 就已经被 body 解析器 413 掉，
 * 下面这个 5MB 检查是不可达的**。只有把 `bodyLimit` 提到约 7mb 以上它才会生效。
 *
 * 两层都保留是有意的：body 层防的是「单个超大请求打满内存」，路由层防的是「写入超过
 * FileService 允许的大小」。它们的关系由 `file-routes.test.ts` 的「两层叠加」用例锁定，
 * 免得以后有人把 5MB 当成「默认就能传 5MB」。
 */
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
      // 后缀区间要单独判：`bytes=-3` 里的 3 是**长度**，不是结束下标。原先把它当 end，
      // 于是 start(=size-3) > end(=3) 恒成立 → 后缀请求**永远 416**（播放器从尾部 seek 全废）。
      const suffix = !hasStart && hasEnd;
      const start = suffix ? Math.max(0, st.size - Number(match[2])) : Number(match[1]);
      const end = suffix || !hasEnd ? st.size - 1 : Number(match[2]);
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
    // 用 service 自己配置的上限（`maxPreviewBytes`），而不是模块常量——原先读常量，
    // 于是 `new FileService({ maxPreviewBytes })` 只影响 /files/read，对 /files/raw 无效。
    if (st.size > service.maxPreviewBytes) {
      res.status(413).json({
        error: `文件超过 ${service.maxPreviewBytes} 字节，请用 Range 请求分段获取`,
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