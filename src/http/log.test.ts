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
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { configureLog } from "../log.js";
import { createRotatingFileSink, LOG_BASE_NAME } from "../log-sink-file.js";
import { getRequestLogger, requestContext } from "./request-context.js";
import { registerLogRoutes } from "./log-routes.js";
import { asyncRoute, registerErrorHandler } from "./routes.js";
import { AppError, validationFailed } from "../errors.js";
import { listenTestServer } from "../test-server.js";
import { tempDir } from "../test-tmp.js";

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
  const dir = tempDir("pi-logq-");
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
  const dir = tempDir("pi-logq-");
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
  const dir = tempDir("pi-errlog-");
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

/**
 * 回归：4xx 的错误行不再拖着一份"指向校验器自己"的堆栈。
 *
 * 症状真实出现过：对 `/logs?from=<非法值>` 发一次请求，日志里就多两份完整栈，
 * 而那一轮的测试断言**全部通过**——噪声不会让任何东西变红,它只把刚做完的
 * 「无损字节偏移分页 + 按 request_id 回溯」的日志按请求规模灌满没用的行。
 * 反向性质（5xx 必须带完整栈与 cause 链）由上面那条测试锁住,两条一起把边界钉死。
 */
test("4xx 的错误行只记原因与 request_id，不记堆栈", async () => {
  const dir = tempDir("pi-errlog-4xx-");
  const sink = createRotatingFileSink({ dir });
  configureLog({ level: "debug", sink: sink.sink });

  const app = express();
  app.use(requestContext());
  app.get(
    "/bad",
    asyncRoute(async () => {
      throw validationFailed("from must be an ISO date or epoch ms", { details: { field: "from" } });
    }),
  );
  registerErrorHandler(app);

  const { url, close } = await listenTestServer(app);
  const r = await fetch(`${url}/bad`);
  const rid = r.headers.get("x-request-id")!;
  assert.equal(r.status, 400);
  // 省的是栈，不是原因：这类文案本来就是写给调用方的，不能顺带把它吞掉。
  assert.equal(((await r.json()) as { error: string }).error, "from must be an ISO date or epoch ms");
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

  // 4xx 走的是 warn 行 `http request rejected`（5xx 才叫 `http request failed`），它以前也带着完整堆栈。
  const failed = page.entries.find((e) => e.msg === "http request rejected");
  assert.ok(failed, "4xx 仍然要留下错误行（不能因为省栈就整条不记）");
  assert.equal(failed!.stack, undefined, "4xx 不记堆栈");
  assert.equal(failed!.cause, undefined, "没有 cause 就不该凭空出现这个字段");
  assert.equal(failed!.message, "from must be an ISO date or epoch ms");
  assert.equal(failed!.level, "warn", "4xx 记在 warn，不占 error 的排障信号");
  assert.equal(failed!.requestId, rid, "错误行仍与本次请求同键，可整条回溯");
});

test("pagination is lossless past the old 50k cap and stable (no dup/skip)", async () => {
  const dir = tempDir("pi-pagescale-");
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

/**
 * 回归：**只剩 .gz 归档**时 desc 查询必须给出内容。
 *
 * `scanPage` 在无游标时把首个文件的 isGz 写死成 `false`，于是当第一个候选文件是归档时，
 * `pageFromFile` 走 gz 分支却拿到 `fromPos = -1` → `all.slice(-1, -1 + limit)`。
 * `slice` 的负数起点会从尾部算起，结果是「只返回最后一条」甚至「返回空」——
 * 用户看到的是「日志明明在，查询却是空的」。
 */
test("只剩 .gz 归档时 desc 查询不能返回空页（首个候选文件是 gz 的回归）", async () => {
  const dir = tempDir("pi-logq-gz-");
  const day = "2026-09-30";
  const lines = [1, 2, 3].map((i) =>
    JSON.stringify({ ts: `${day}T0${i}:00:00.000Z`, level: "error", msg: `m${i}`, component: "x" }),
  );
  writeFileSync(join(dir, `${LOG_BASE_NAME}-${day}.000.log.gz`), gzipSync(`${lines.join("\n")}\n`));
  const app = buildApp(dir);
  const { url, close } = await listenTestServer(app);
  try {
    const desc = (await (await fetch(`${url}/logs?order=desc`)).json()) as {
      count: number;
      hasMore: boolean;
      entries: Array<{ msg: string }>;
    };
    assert.equal(desc.count, 3, "只剩归档时 desc 也必须返回全部命中");
    assert.deepEqual(desc.entries.map((e) => e.msg), ["m3", "m2", "m1"], "desc 必须新→旧");
    assert.equal(desc.hasMore, false);

    const asc = (await (await fetch(`${url}/logs?order=asc`)).json()) as { entries: Array<{ msg: string }> };
    assert.deepEqual(asc.entries.map((e) => e.msg), ["m1", "m2", "m3"], "asc 必须是旧→新");

    // 分页也要无损：limit=2 时第一页 2 条 + hasMore，第二页用游标拿剩下 1 条。
    const page1 = (await (await fetch(`${url}/logs?order=desc&limit=2`)).json()) as {
      entries: Array<{ msg: string }>;
      nextCursor?: string;
      hasMore: boolean;
    };
    assert.deepEqual(page1.entries.map((e) => e.msg), ["m3", "m2"]);
    assert.equal(page1.hasMore, true);
    assert.ok(page1.nextCursor, "有下一页时必须给游标");
    const page2 = (await (
      await fetch(`${url}/logs?order=desc&limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`)
    ).json()) as { entries: Array<{ msg: string }> };
    assert.deepEqual(page2.entries.map((e) => e.msg), ["m1"], "翻页不能丢条目");
  } finally {
    await close();
  }
});
