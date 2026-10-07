/**
 * pi-starter · HTTP 应用（Express + SSE）
 *
 * 把 Agent 封成语言无关的接口。入口 src/server.ts 只负责解析命令行并 listen。
 * 嵌进已有服务时：buildAgent() → createApp() → 挂到自己的 Express / 自己的静态页。
 *
 * 不内置登录。本地工具不需要；接到现有模块时用现有鉴权包一层。
 *
 * 资源接口（不调模型，可用虚拟数据测技能 / 知识库 / 数据库）：
 *   GET  /health
 *   GET  /skills  GET /skills/:name
 *   GET  /knowledge  GET /knowledge/search  GET /knowledge/:name
 *   GET  /db  GET /db/notes  GET /db/notes/:id  POST /db/query
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import express, { type Express } from "express";
import type { BuiltAgent } from "./agent.js";
import { searchKnowledge } from "./knowledge/index.js";
import { sse, translateEvent } from "./sse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CreateAppOptions {
  agent: BuiltAgent;
  /** 静态页目录。默认仓库 public/。嵌进别人服务时传 false，自己挂前端。 */
  staticDir?: string | false;
}

export interface CreateAppResult {
  app: Express;
  /** 当前会话正在跑一轮 prompt */
  isBusy(): boolean;
  dispose(): void;
}

export function createApp(options: CreateAppOptions): CreateAppResult {
  const { session, builtinTools, switchModel, listModels, skills, knowledge, database } =
    options.agent;
  let currentModel = options.agent.model;
  let busy = false;

  const app = express();
  app.use(express.json());
  if (options.staticDir !== false) {
    app.use(express.static(options.staticDir ?? join(__dirname, "..", "public")));
  }

  app.get("/health", async (_req, res) => {
    const models = await listModels();
    let db: { ok: boolean; driver?: string; path?: string; error?: string };
    try {
      db = database.ping();
    } catch (err: unknown) {
      db = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    res.json({
      ok: true,
      model: `${currentModel.provider}/${currentModel.id}`,
      provider: currentModel.provider,
      modelId: currentModel.id,
      models: models.map((item) => ({
        provider: item.provider,
        id: item.id,
        name: item.name,
        current: item.provider === currentModel.provider && item.id === currentModel.id,
      })),
      builtinTools,
      busy,
      skills: skills.map((item) => ({
        name: item.name,
        description: item.description,
        location: item.filePath,
      })),
      knowledge: knowledge.map((item) => ({
        name: item.name,
        title: item.title,
        description: item.description,
      })),
      db,
    });
  });

  app.get("/skills", (_req, res) => {
    res.json({
      ok: true,
      skills: skills.map((item) => ({
        name: item.name,
        description: item.description,
        location: item.filePath,
      })),
    });
  });

  app.get("/skills/:name", async (req, res) => {
    const skill = skills.find((item) => item.name === req.params.name);
    if (!skill) {
      res.status(404).json({ error: `没有技能 ${req.params.name}` });
      return;
    }
    const body = await readFile(skill.filePath, "utf-8");
    res.json({
      ok: true,
      skill: {
        name: skill.name,
        description: skill.description,
        location: skill.filePath,
        body,
      },
    });
  });

  app.get("/knowledge", (_req, res) => {
    res.json({
      ok: true,
      knowledge: knowledge.map((item) => ({
        name: item.name,
        title: item.title,
        description: item.description,
      })),
    });
  });

  app.get("/knowledge/search", (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q : "";
    if (!query.trim()) {
      res.status(400).json({ error: "q 必填" });
      return;
    }
    const hits = searchKnowledge(knowledge, query);
    res.json({ ok: true, query, hits });
  });

  app.get("/knowledge/:name", (req, res) => {
    const doc = knowledge.find((item) => item.name === req.params.name);
    if (!doc) {
      res.status(404).json({ error: `没有文档 ${req.params.name}` });
      return;
    }
    res.json({
      ok: true,
      doc: {
        name: doc.name,
        title: doc.title,
        description: doc.description,
        body: doc.body,
      },
    });
  });

  app.get("/db", (_req, res) => {
    try {
      const ping = database.ping();
      res.json({ ok: true, driver: ping.driver, path: ping.path });
    } catch (err: unknown) {
      res.status(503).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/db/notes", (_req, res) => {
    res.json({ ok: true, notes: database.listNotes() });
  });

  app.get("/db/notes/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id 必须是整数" });
      return;
    }
    const note = database.getNote(id);
    if (!note) {
      res.status(404).json({ error: `没有笔记 ${id}` });
      return;
    }
    res.json({ ok: true, note });
  });

  app.post("/db/query", (req, res) => {
    const sql = typeof req.body?.sql === "string" ? req.body.sql : "";
    if (!sql.trim()) {
      res.status(400).json({ error: "sql 必填" });
      return;
    }
    try {
      const rows = database.query(sql);
      res.json({
        ok: true,
        columns: rows.columns,
        rows: rows.rows.map((row) => ({ ...row })),
      });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/model", async (req, res) => {
    if (busy) return res.status(429).json({ error: "Agent 正忙，稍等" });
    const body = req.body ?? {};
    const ref = [body.provider, body.model].filter(Boolean).join("/");
    if (!ref) return res.status(400).json({ error: "model 必填，格式 provider/modelId" });
    try {
      currentModel = await switchModel(ref);
      res.json({ ok: true, model: `${currentModel.provider}/${currentModel.id}` });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/chat", async (req, res) => {
    const { message } = req.body ?? {};
    if (!message) return res.status(400).json({ error: "message 必填" });
    if (busy) return res.status(429).json({ error: "Agent 正忙，稍等" });
    busy = true;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const off = session.subscribe((event) => {
      const payload = translateEvent(event);
      if (payload) {
        try {
          res.write(payload);
        } catch {
          /* res 已坏（客户端走了），忽略 */
        }
      }
    });

    // 必须监听 res 而不是 req：req 的 close 在「请求体读完」时就触发，
    // 那时 Agent 才刚起步，会被误判成客户端断开而 abort。
    let settled = false;
    res.on("close", () => {
      off();
      if (!settled) {
        try {
          session.abort();
        } catch {
          /* noop */
        }
      }
    });

    try {
      await session.prompt(message);
    } catch (err: unknown) {
      const messageText = err instanceof Error ? err.message : "Agent 出错";
      try {
        res.write(sse("error", { message: messageText }));
      } catch {
        /* res 已坏 */
      }
    } finally {
      settled = true;
      off();
      try {
        res.write(sse("done", {}));
      } catch {
        /* res 已坏 */
      }
      res.end();
      busy = false;
    }
  });

  return {
    app,
    isBusy: () => busy,
    dispose: () => options.agent.dispose(),
  };
}
