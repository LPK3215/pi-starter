/**
 * pi-starter · HTTP 应用（Express）
 *
 * 把 Agent 封成语言无关的接口。入口 src/server.ts 只负责解析命令行并 listen。
 * 嵌进已有服务时：buildAgent() → createApp() → 挂到自己的 Express / 自己的静态页。
 *
 * 两条通道并存（渐进升级，不破坏既有集成）：
 *   1. REST + SSE（本文件）—— 语言无关、易于 curl，保留 `/chat` 单向流式；
 *   2. WebSocket（transport/ws.ts）—— 双向、快照驱动、多对话，产品化前端走这条。
 *
 * 不内置登录。本地工具不需要；接到现有模块时用现有鉴权包一层。
 *
 * 资源接口（不调模型，可用虚拟数据测技能 / 知识库 / 数据库）：
 *   GET  /health
 *   GET  /skills  GET /skills/:name
 *   GET  /knowledge  GET /knowledge/search  GET /knowledge/:name
 *   GET  /db  GET /db/notes  GET /db/notes/:id  POST /db/query
 *   GET  /capabilities   POST /tools/:name/enabled
 *   GET  /settings       PATCH /settings
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { Model } from "@earendil-works/pi-ai";
import type { BuiltAgent } from "./agent.js";
import { sse, translateEvent } from "./sse.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { SettingsService } from "./settings.js";
import { hardenApp, type TimeoutOptions } from "./http/hardening.js";
import {
  registerControlRoutes,
  registerDbRoutes,
  registerErrorHandler,
  registerProbeRoutes,
  registerResourceRoutes,
} from "./http/routes.js";
import { AppError, badRequest, busy as busyError } from "./http/errors.js";
import { registerFileRoutes } from "./http/file-routes.js";
import { registerApprovalRoutes } from "./http/approval-routes.js";
import type { ApprovalRulesStore } from "./approval/rules.js";
import type { FileService } from "./files/service.js";
import { createRateLimiter, DEFAULT_RATE_RULES, type RateLimitRule } from "./http/rate-limit.js";
import { getLogger } from "./log.js";
import { Metrics, metrics as defaultMetrics } from "./metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CreateAppOptions {
  agent: BuiltAgent;
  /** 静态页目录。默认仓库 public/。嵌进别人服务时传 false，自己挂前端。 */
  staticDir?: string | false;
  /** 工具注册表（可选）：提供后开放 /capabilities 与工具开关。 */
  registry?: ToolRegistry;
  /** 设置服务（可选）：提供后开放 /settings。 */
  settings?: SettingsService;
  /** JSON body 上限，默认 1mb。 */
  bodyLimit?: string | number;
  /** 覆盖默认安全响应头；传 false 关闭（仅在自行代理加固时）。 */
  securityHeaders?: Readonly<Record<string, string>> | false;
  /** HTTP 服务器超时配置（由入口应用到 node http.Server）。 */
  timeouts?: TimeoutOptions;
  /** 实时连接数（供 /metrics 派生 gauge，避免指标与实际漂移）。 */
  connectionCount?: () => number;
  /** 实时会话/对话数（供 /metrics）。 */
  sessionStats?: () => { sessions: number; conversations: number };
  /** 实时待审批数（供 /metrics）。 */
  approvalStats?: () => number;
  /** 指标注册表，缺省用全局单例。 */
  metrics?: Metrics;
  /**
   * 会话中枢（可选）。提供后 `POST /model` 会经它切换，使 REST 与 WS 的模型保持一致；
   * 缺省则只切换共享 session（适合只嵌 REST 的库调用方）。
   */
  hub?: { setModel(ref: string): Promise<Model<any>> };
  /**
   * Rate limits for expensive routes. `true` uses DEFAULT_RATE_RULES; pass a rule map to
   * override. Omit (default) to disable — local single-user usage should not be throttled.
   */
  /**
   * 注入业务方自己的路由，**必须挂在本函数返回之前**。
   *
   * 为什么不能靠「先createApp 拿到 app 再加路由」：错误处理器在内核内部挂载，之后加的
   * 路由排在它**后面**，永远走不到——实测业务方 `throw new AppError("internal", "密码…")`
   * 会把密码、绝对路径和源码行号原样返回给客户端。脚手架提供的「internal 默认隐藏」
   * 保护只对内核自己的路由生效，业务方一接入就失效，这种静默陷阱必须在结构上消除。
   */
  configure?: (app: Express) => void;
  /**
   * 文件服务。提供后开放 `/files/*`（浏览 / 读 / 写 / 新建 / 重命名 / 复制 / 删除 /
   * 原始内容含Range / base64 上传），全部限制在 root 内。
   *
   * 省略则不注册这些路由——把内核暴露到文件系统是嵌入方的决定，不该默认开启。
   */
  files?: FileService;
  /**
   * 审批规则库。提供后开放 `/approval/rules`（查看 / 替换 / 新增 / 删除）。
   *
   * 省略则不注册——修改审批策略是敏感能力，不该默认开启。
   */
  approvalRules?: ApprovalRulesStore;
  rateLimit?: boolean | Record<string, RateLimitRule>;
  /**
   * Proxies whose X-Forwarded-For may be trusted (e.g. ["loopback"] behind a local nginx).
   * Anything else has the header ignored, because it is client-controlled and would
   * otherwise let any caller bypass the limit by forging the header.
   */
  trustedProxies?: readonly string[];
}

export interface CreateAppResult {
  app: Express;
  /**
   * 重新在**末尾**挂一个错误处理器。
   *
   * 首选是 `configure` 钩子（在错误处理器之前注入）。这个方法是给另一种用法兜底的：
   * 已经拿到 `app` 并加完路由后再调用 `seal()`，同样能让这些路由的异常被统一翻译。
   * 不调用就会退回 Express 默认处理器——那会把错误消息与堆栈返回给客户端。
   */
  seal(): void;
  /**
   * 注册一个在 `dispose()` 时运行的清理函数。
   *
   * 脚手架自己管理agent / 数据库 / 会话，但业务方注册的扩展（定时器、长连接、临时文件）
   * 不在其中。扩展点若没有回收契约，嵌入方每次热重载或优雅停机都会泄漏一份。
   */
  addDisposer(fn: () => void): void;
  /** 当前会话正在跑一轮 prompt */
  isBusy(): boolean;
  dispose(): void;
}

export function createApp(options: CreateAppOptions): CreateAppResult {
  const { session, builtinTools, switchModel, listModels, skills, knowledge, database } =
    options.agent;
  const registry = options.registry;
  const settings = options.settings;
  /**
   * Single source of truth for "which model is active" — read live, never cached.
   *
   * This used to be a `let currentModel = options.agent.model` snapshot updated only inside
   * `POST /model`. That silently lied after a **WebSocket** `set_model`, which switches through
   * `hub.setModel()` and never touches this closure: `/info` and `/health/ready` kept
   * advertising the old model while every conversation was already running the new one.
   * Reading the getter per request makes that class of drift impossible.
   */
  const currentModel = (): Model<any> => options.agent.model;
  let busy = false;
  const disposers: Array<() => void> = [];
  const metricsReg = options.metrics ?? defaultMetrics;

  const app = express();
  // 加固三件套：body 上限 + 安全响应头 + 关闭 X-Powered-By。
  // 原先 express.json() 无上限，单个超大请求即可打满进程内存。
  hardenApp(app, { bodyLimit: options.bodyLimit, headers: options.securityHeaders });
  if (options.staticDir !== false) {
    app.use(express.static(options.staticDir ?? join(__dirname, "..", "public")));
  }

  // Rate limits for the expensive routes. Opt-in via `rateLimit: true` (or a custom rule
  // set) so local single-user usage is never surprised by a quota.
  if (options.rateLimit) {
    const rules = options.rateLimit === true ? DEFAULT_RATE_RULES : options.rateLimit;
    app.use(
      createRateLimiter({
        rules,
        trustedProxies: options.trustedProxies ?? [],
        onLimit: (info) => {
          metricsReg.inc("rateLimitedTotal");
          getLogger().child({ component: "http" }).warn("触发速率限制", info);
        },
      }),
    );
  }

  // Probes / resources / db / control routes live in src/http/routes.ts.
  registerProbeRoutes(app, options.agent, {
    currentModel,
    isBusy: () => busy,
    sessionStats: options.sessionStats,
    approvalStats: options.approvalStats,
    metrics: metricsReg,
    connectionCount: options.connectionCount,
  });
  registerResourceRoutes(app, options.agent);
  registerDbRoutes(app, options.agent);
  registerControlRoutes(app, options.agent, { registry, settings });
  if (options.files) registerFileRoutes(app, { service: options.files });
  if (options.approvalRules) registerApprovalRoutes(app, { store: options.approvalRules });

  // Rich capability/inventory snapshot (superset of the old /health body).
  app.get("/info", async (_req, res) => {
    const active = currentModel();
    const models = await listModels();
    let db: { ok: boolean; driver?: string; path?: string; error?: string };
    try {
      db = database.ping();
    } catch (err: unknown) {
      db = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    res.json({
      ok: true,
      model: `${active.provider}/${active.id}`,
      provider: active.provider,
      modelId: active.id,
      models: models.map((item) => ({
        provider: item.provider,
        id: item.id,
        name: item.name,
        current: item.provider === active.provider && item.id === active.id,
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

  app.post("/model", async (req, res) => {
    if (busy) throw busyError();
    const body = req.body ?? {};
    const ref = [body.provider, body.model].filter(Boolean).join("/");
    if (!ref) throw badRequest("model is required, format provider/modelId");
    try {
      // Prefer the hub so WS conversations switch too; without it (library embedders that
      // only pass `agent`) fall back to switching the shared session alone. Use the returned
      // model rather than a cached field — `currentModel()` now reads live state.
      const next = options.hub ? await options.hub.setModel(ref) : await switchModel(ref);
      res.json({ ok: true, model: `${next.provider}/${next.id}` });
    } catch (err: unknown) {
      // The SDK's "unknown model" error lists the available choices — that IS the useful
      // message for the caller, so expose it deliberately instead of 500-ing.
      throw new AppError("bad_request", err instanceof Error ? err.message : String(err), {
        expose: true,
        cause: err,
      });
    }
  });

  app.post("/chat", async (req, res) => {
    // Validate BEFORE writing SSE headers: once the stream starts we can no longer change
    // the status code, so a 400 must be raised first.
    const message = req.body?.message;
    if (typeof message !== "string" || !message) throw badRequest("message is required");
    if (busy) throw busyError();
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
          /* response already broken (client left); ignore */
        }
      }
    });

    // Must listen on res, not req: req 'close' fires when the request body is read,
    // which is far too early and would abort a freshly started run.
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
      const messageText = err instanceof Error ? err.message : "agent error";
      try {
        res.write(sse("error", { message: messageText }));
      } catch {
        /* response already broken */
      }
    } finally {
      settled = true;
      off();
      try {
        res.write(sse("done", {}));
      } catch {
        /* response already broken */
      }
      res.end();
      busy = false;
    }
  });

  // Embedder routes go in before the error handler, so their thrown AppError is translated
  // exactly like a built-in one (typed codes exposed, internal detail hidden).
  options.configure?.(app);

  // Must be registered AFTER every route: it is the single place that turns a thrown
  // AppError into a response, and it hides internal detail unless explicitly marked safe.
  registerErrorHandler(app);

  return {
    app,
    seal: () => registerErrorHandler(app),
    addDisposer: (fn) => disposers.push(fn),
    isBusy: () => busy,
    dispose: () => {
      // Embedder cleanup first: it may still depend on the agent being alive.
      for (const fn of disposers.splice(0, disposers.length)) {
        try {
          fn();
        } catch (err) {
          getLogger().warn("扩展清理失败，已跳过", { error: err instanceof Error ? err.message : String(err) });
        }
      }
      options.agent.dispose();
    },
  };
}
