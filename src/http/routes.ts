/**
 * pi-starter · 路由装配
 *
 * 从 `app.ts` 拆出。`createApp` 现在只做「建 app → 装加固 → 装路由 → 装错误处理」，
 * 具体端点各自成文件，新增能力不必再动主装配文件。
 *
 * 顺带落地两件事：
 *   1. **类型化错误**：路由 `throw`，由 `errorHandler` 统一翻译成响应，
 *      不再有 9 处重复的 `catch (err) → res.status(400).json({error: err.message})`；
 *   2. **不再泄漏内部细节**：未标注 `expose` 的错误一律返回通用文案，
 *      真实原因只进日志（数据库路径、SQL 驱动报错、SDK 内部信息不再外泄）。
 */

import type { Express, Request, Response } from "express";
import { readFile } from "node:fs/promises";
import { searchKnowledge } from "../knowledge/index.js";
import { scanReadOnlySql } from "../db/index.js";
import { AppError, badRequest, errorHandler, notFound, validationFailed } from "./errors.js";
import { getLogger } from "../log.js";
import { Metrics } from "../metrics.js";
import type { BuiltAgent } from "../agent.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SettingsService } from "../settings.js";
// Type-only: routes.ts is imported by app.ts, which also imports session-hub.ts. A value
// import would create a runtime cycle for no benefit — the hub is only used as a type here.
import type { CompactionOutcome } from "../session-hub.js";

/** Narrow a request body field, throwing a typed error instead of hand-writing 400s. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw validationFailed(`${field} is required`);
  }
  return value;
}

/** Wrap an async route so rejected promises reach the error middleware. */
export function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: import("express").NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/* ────────────────────────── 探针与指标 ────────────────────────── */

export function registerProbeRoutes(
  app: Express,
  agent: BuiltAgent,
  options: {
    currentModel: () => { provider: string; id: string; name?: string };
    isBusy: () => boolean;
    sessionStats?: () => { sessions: number; conversations: number };
    approvalStats?: () => number;
    metrics: Metrics;
    connectionCount?: () => number;
  },
): void {
  const database = agent.database;
  const knowledge = agent.knowledge;

  // Liveness: must NOT touch the model runtime. A provider outage would otherwise make
  // orchestrators restart-loop a process that is actually fine.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, ...Metrics.runtimeInfo() });
  });

  // Readiness: every hard dependency, so "alive" and "able to serve" are distinguishable.
  app.get("/health/ready", (_req, res) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    let ok = true;

    try {
      const model = options.currentModel();
      if (!model?.id) throw new Error("no model selected");
      checks.model = { ok: true, detail: `${model.provider}/${model.id}` };
    } catch (err: unknown) {
      ok = false;
      checks.model = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    try {
      const ping = database.ping();
      checks.database = { ok: true, detail: `${ping.driver} ${ping.path}` };
    } catch (err: unknown) {
      ok = false;
      checks.database = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    try {
      checks.knowledge = { ok: true, detail: `${knowledge.length} docs` };
    } catch (err: unknown) {
      ok = false;
      checks.knowledge = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    res.status(ok ? 200 : 503).json({ ok, checks, ...Metrics.runtimeInfo() });
  });

  app.get("/metrics", (req, res) => {
    // Derive gauges from live state at scrape time so they cannot drift from reality.
    options.metrics.setGauge("wsConnections", options.connectionCount?.() ?? 0);
    if (options.sessionStats) {
      const stats = options.sessionStats();
      options.metrics.setGauge("clientSessions", stats.sessions);
      options.metrics.setGauge("conversations", stats.conversations);
    }
    if (options.approvalStats) options.metrics.setGauge("approvalsPending", options.approvalStats());

    if (req.query.format === "prometheus") {
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.send(options.metrics.toPrometheus());
      return;
    }
    res.json({
      ok: true,
      metrics: options.metrics.snapshot(),
      runtime: Metrics.runtimeInfo(),
    });
  });
}

/* ────────────────────────── 资源目录 ────────────────────────── */

export function registerResourceRoutes(app: Express, agent: BuiltAgent): void {
  const { skills, knowledge, promptTemplates } = agent;

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

  app.get("/skills/:name", async (req: Request, res: Response) => {
    const skill = skills.find((item) => item.name === req.params.name);
    if (!skill) throw notFound(`no such skill: ${req.params.name}`);
    // A missing/unreadable SKILL.md is an internal filesystem problem, not a client error —
    // letting it throw keeps the path detail in the log instead of the response.
    const body = await readFile(skill.filePath, "utf-8");
    res.json({
      ok: true,
      skill: { name: skill.name, description: skill.description, location: skill.filePath, body },
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
    if (!query.trim()) throw badRequest("q is required");
    res.json({ ok: true, query, hits: searchKnowledge(knowledge, query) });
  });

  app.get("/knowledge/:name", (req, res) => {
    const doc = knowledge.find((item) => item.name === req.params.name);
    if (!doc) throw notFound(`no such document: ${req.params.name}`);
    res.json({
      ok: true,
      doc: { name: doc.name, title: doc.title, description: doc.description, body: doc.body },
    });
  });

  // Prompt templates are the SDK's slash-command expansion. Body comes from the already
  // loaded catalog (no re-reading disk), mirroring how /skills serves the SKILL.md text.
  app.get("/prompt-templates", (_req, res) => {
    res.json({
      ok: true,
      promptTemplates: promptTemplates.map((item) => ({
        name: item.name,
        description: item.description,
        ...(item.argumentHint ? { argumentHint: item.argumentHint } : {}),
      })),
    });
  });

  app.get("/prompt-templates/:name", (req, res) => {
    const template = promptTemplates.find((item) => item.name === req.params.name);
    if (!template) throw notFound(`no such prompt template: ${req.params.name}`);
    res.json({
      ok: true,
      promptTemplate: {
        name: template.name,
        description: template.description,
        ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
        body: template.content,
      },
    });
  });
}

/* ────────────────────────── 数据库 ────────────────────────── */

export function registerDbRoutes(app: Express, agent: BuiltAgent): void {
  const database = agent.database;

  app.get("/db", (_req, res) => {
    const ping = database.ping();
    res.json({ ok: true, driver: ping.driver, path: ping.path });
  });

  app.get("/db/notes", (_req, res) => {
    res.json({ ok: true, notes: database.listNotes() });
  });

  app.get("/db/notes/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw badRequest("id must be an integer");
    const note = database.getNote(id);
    if (!note) throw notFound(`no such note: ${id}`);
    res.json({ ok: true, note });
  });

  app.post("/db/query", (req, res) => {
    const sql = requireString(req.body?.sql, "sql");
    // Validate before touching the DB so the client gets a precise, actionable reason
    // (e.g. "检测到非只读关键字：DELETE") instead of a generic driver error.
    const scan = scanReadOnlySql(sql);
    if (!scan.ok) {
      // Exposed on purpose: this text is written by us, names the offending keyword, and is
      // what lets a model correct its own query instead of retrying blindly.
      throw new AppError("read_only_sql", scan.reason ?? "只允许只读查询");
    }
    const rows = database.query(sql);
    res.json({
      ok: true,
      columns: rows.columns,
      rows: rows.rows,
      truncated: rows.truncated,
      totalRows: rows.totalRows,
    });
  });
}

/* ────────────────────────── 能力与设置 ────────────────────────── */

export function registerControlRoutes(
  app: Express,
  agent: BuiltAgent,
  options: {
    registry?: ToolRegistry;
    settings?: SettingsService;
    hub?: { compactAcrossClients(instructions?: string): Promise<CompactionOutcome & { compacted: number }> };
  },
): void {
  const { registry, settings, hub } = options;

  /**
   * 主动压缩上下文（REST 侧）。
   *
   * 压缩是**对话级**操作，所以作用到所有连接的当前对话；没有 hub 时端点不挂载——
   * 悄悄作用在错误的会话上比不提供这个端点更糟。
   *
   * 失败也返回 200 + `ok:false` + 中文原因：「上下文还很小，压不划算」是给用户看的
   * 判断依据，不是协议错误——用 4xx 会让前端把它当异常弹窗。
   */
  if (hub) {
    app.post("/context/compact", asyncRoute(async (req, res) => {
      const instructions = req.body?.instructions;
      if (instructions !== undefined && typeof instructions !== "string") {
        throw validationFailed("instructions must be a string");
      }
      res.json(await hub.compactAcrossClients(instructions));
    }));
  }

  if (registry) {
    app.get("/capabilities", (_req, res) => {
      res.json({
        ok: true,
        builtinTools: agent.builtinTools,
        tools: registry.catalog(),
        skills: agent.skills.map((item) => ({ name: item.name, description: item.description })),
        knowledge: agent.knowledge.map((item) => ({
          name: item.name,
          title: item.title,
          description: item.description,
        })),
      });
    });

    app.post("/tools/:name/enabled", (req, res) => {
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") throw validationFailed("enabled must be a boolean");
      if (!registry.setEnabled(req.params.name, enabled)) throw notFound(`no such tool: ${req.params.name}`);
      res.json({ ok: true, tool: { name: req.params.name, enabled } });
    });
  }

  if (settings) {
    app.get("/settings", (_req, res) => {
      res.json({ ok: true, settings: settings.get() });
    });

    app.patch("/settings", (req, res) => {
      const partial = req.body;
      if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
        throw validationFailed("settings must be an object");
      }
      // SettingsService.patch throws on unknown/invalid fields; those messages are written
      // for the client (field-level validation), so surface them rather than 500-ing.
      try {
        res.json({ ok: true, settings: settings.patch(partial as Record<string, unknown>) });
      } catch (err: unknown) {
        throw new AppError("validation_failed", err instanceof Error ? err.message : String(err), {
          cause: err,
        });
      }
    });
  }
}

/** Mount the typed error handler. Must be registered after every route. */
export function registerErrorHandler(app: Express): void {
  const log = getLogger().child({ component: "http" });
  app.use(errorHandler((fields) => {
    // Severity by class: a 4xx is the caller's mistake and is expected traffic, so logging
    // it at `error` would make real 5xx incidents invisible in the noise. 5xx means we failed.
    const status = typeof fields.httpStatus === "number" ? fields.httpStatus : 500;
    if (status >= 500) log.error("请求处理失败", fields);
    else log.warn("请求被拒绝", fields);
  }));
}
