/**
 * 请求生命周期 + 日志检索的端到端测试。
 *
 * 直接对着【判据】来：
 *   1. 一次请求产生的全部日志能按 request_id 整条拉回（入口/出口/业务处理）；
 *   2. 落盘是文件而非内存，「停机」（dispose）后历史仍可查，且能按级别/关键字筛；
 *   3. 敏感字段在写入即被脱敏，检索回看到的也是打码值；
 *   4. 错误按模板聚合统计；出站 request_id 可透传（入站头被采纳）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { configureLog } from "../log.js";
import { createRotatingFileSink, LOG_BASE_NAME } from "../log-sink-file.js";
import { getRequestLogger, requestContext } from "./request-context.js";
import { registerLogRoutes } from "./log-routes.js";
import { asyncRoute, registerErrorHandler } from "./routes.js";
import { AppError } from "./errors.js";
import { listenTestServer } from "../test-server.js";

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 60));
}

function buildApp(dir: string): express.Express {
  const app = express();
  app.use(requestContext());
  app.get("/probe", (req, res) => {
    // Business node logging shares the same request_id via getRequestLogger.
    getRequestLogger(req).info("probe handled", { conversationId: "c1", apiKey: "sk-SECRET-123" });
    res.json({ ok: true });
  });
  app.get("/boom", (_req, res) => {
    res.status(500).json({ ok: false, error: "kaboom" });
  });
  registerLogRoutes(app, { dir });
  return app;
}

test("full request logs are retrievable by request_id; secrets redacted on write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-logq-"));
  const sink = createRotatingFileSink({ dir });
  configureLog({ level: "debug", sink: sink.sink });

  const { url, close } = await listenTestServer(buildApp(dir));
  const probe = await fetch(`${url}/probe`);
  const requestId = probe.headers.get("x-request-id");
  assert.ok(requestId, "response carries an X-Request-Id");

  await close();
  await settle();
  await sink.dispose();

  // Fresh reader (simulates a restart reading persisted files).
  const reader = express();
  registerLogRoutes(reader, { dir });
  const srv = await listenTestServer(reader);
  const page = (await (await fetch(`${srv.url}/logs?requestId=${requestId}&order=asc`)).json()) as {
    ok: boolean;
    entries: Array<Record<string, unknown>>;
  };
  await srv.close();

  const msgs = page.entries.map((e) => e.msg);
  assert.ok(msgs.includes("http request started"), "entry log present");
  assert.ok(msgs.includes("http request completed"), "exit log present");
  assert.ok(msgs.includes("probe handled"), "business log present under same request_id");
  assert.ok(page.entries.every((e) => e.requestId === requestId), "every line shares the request_id");

  const handled = page.entries.find((e) => e.msg === "probe handled")!;
  assert.equal(handled.apiKey, "[redacted]", "secret field redacted at write time");
});

test("level filter, error stats aggregation, and inbound request_id passthrough", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-logq-"));
  const sink = createRotatingFileSink({ dir });
  configureLog({ level: "debug", sink: sink.sink });

  const { url, close } = await listenTestServer(buildApp(dir));
  const boom = await fetch(`${url}/boom`);
  assert.equal(boom.status, 500);
  const inbound = await fetch(`${url}/probe`, { headers: { "x-request-id": "trace-fixed-1" } });
  assert.equal(inbound.headers.get("x-request-id"), "trace-fixed-1", "inbound request_id adopted");

  await close();
  await settle();
  await sink.dispose();

  const reader = express();
  registerLogRoutes(reader, { dir });
  const srv = await listenTestServer(reader);

  const errors = (await (await fetch(`${srv.url}/logs?level=error`)).json()) as {
    entries: Array<Record<string, unknown>>;
  };
  assert.ok(
    errors.entries.some((e) => e.msg === "http request completed" && e.statusCode === 500),
    "5xx exit line surfaces at error level",
  );

  const stats = (await (await fetch(`${srv.url}/logs/stats`)).json()) as {
    stats: Array<Record<string, unknown> & { template: string; count: number; firstSeen: string; lastSeen: string }>;
  };
  const completed = stats.stats.find((s) => s.template === "http request completed");
  assert.ok(completed, "error template aggregated with a count");
  assert.ok(completed!.count >= 1);
  assert.ok(completed!.firstSeen && completed!.lastSeen, "first/last seen timestamps present");

  // Time-window exclusion: a future `from` yields nothing (no full in-memory scan leak).
  const future = Date.parse("2099-01-01T00:00:00.000Z");
  const none = (await (await fetch(`${srv.url}/logs?from=${future}`)).json()) as { entries: unknown[] };
  assert.equal(none.entries.length, 0, "time-range pruning excludes out-of-window files");

  await srv.close();
});

test("error line carries full stack + request_id, and secrets inside the message are redacted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-errlog-"));
  const sink = createRotatingFileSink({ dir });
  configureLog({ level: "debug", sink: sink.sink });

  const app = express();
  app.use(requestContext());
  app.get(
    "/boom",
    asyncRoute(async (_req) => {
      throw new AppError("internal", "open /run/secrets/auth.json password=hunter2", {
        cause: new Error("root cause token=tok-SHOULD-NOT-LEAK"),
      });
    }),
  );
  registerErrorHandler(app);

  const { url, close } = await listenTestServer(app);
  const r = await fetch(`${url}/boom`);
  const rid = r.headers.get("x-request-id")!;
  assert.equal(r.status, 500);
  await close();
  await settle();
  await sink.dispose();

  const reader = express();
  registerLogRoutes(reader, { dir });
  const srv = await listenTestServer(reader);
  const page = (await (await fetch(`${srv.url}/logs?requestId=${rid}&order=asc`)).json()) as {
    entries: Array<Record<string, unknown>>;
  };
  await srv.close();

  const msgs = page.entries.map((e) => e.msg);
  // 错误详情行必须与入口/出口共享同一个 request_id（旧版是孤儿行）。
  assert.ok(msgs.includes("http request failed"), "error-detail line is bound to the request_id");
  assert.ok(msgs.includes("http request started") && msgs.includes("http request completed"), "entry+exit present");
  assert.ok(page.entries.every((e) => e.requestId === rid), "every line carries the request_id");

  const failed = page.entries.find((e) => e.msg === "http request failed")!;
  assert.equal(typeof failed.stack, "string", "full stack is present");
  assert.ok((failed.stack as string).includes("at "), "stack has frames");
  assert.ok(
    failed.cause && typeof failed.cause === "object" && typeof (failed.cause as Record<string, unknown>).stack === "string",
    "cause keeps its own stack",
  );
  const serialized = JSON.stringify(failed);
  assert.ok(!serialized.includes("hunter2"), "password value redacted");
  assert.ok(!serialized.includes("tok-SHOULD-NOT-LEAK"), "token value redacted");
  assert.ok(serialized.includes("[redacted]"), "redaction marker present");
});

test("pagination is lossless past the old 50k cap and stable (no dup/skip)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-pagescale-"));
  const today = new Date().toISOString().slice(0, 10);
  const N = 60_000; // 大于旧的 5 万上限
  const lines: string[] = [];
  for (let i = 0; i < N; i++) {
    lines.push(
      JSON.stringify({ ts: new Date(1_700_000_000_000 + i).toISOString(), level: "error", msg: "e", component: "http", requestId: "r", idx: i }),
    );
  }
  writeFileSync(join(dir, `${LOG_BASE_NAME}-${today}.000.log`), `${lines.join("\n")}\n`);

  const app = express();
  registerLogRoutes(app, { dir });
  const srv = await listenTestServer(app);

  const seen: number[] = [];
  let cursor: string | undefined;
  let guard = 0;
  for (;;) {
    const url = `${srv.url}/logs?level=error&order=asc&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = (await (await fetch(url)).json()) as {
      entries: Array<Record<string, unknown>>;
      hasMore: boolean;
      nextCursor?: string;
    };
    for (const e of page.entries) seen.push(e.idx as number);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
    if (++guard > 200) break; // 防死循环保险
  }
  await srv.close();

  assert.equal(seen.length, N, "every matching line is reachable (no silent 50k truncation)");
  assert.equal(new Set(seen).size, N, "no duplicates across pages");
  assert.deepEqual(seen.slice(0, 3), [0, 1, 2], "asc order preserved");
  assert.equal(seen.at(-1), N - 1, "reaches the true last line");
});
