/**
 * 前端 · 日志 REST 客户端的契约测试。
 *
 * 无头、无 DOM、无真实网络：`fetch` 被打桩，只断言「发出去的请求长什么样」与
 * 「回来的东西怎么解释」。这几条正是回归过的地方（分页边界曾把"恰好等于上限"谎报成截断）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { queryAllForExport, queryLogs, queryStats, type LogPage } from "./logClient.js";

/** 打桩 fetch，记录每次请求的 URL 与 init，并按脚本返回响应。 */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function emptyPage(overrides: Partial<LogPage> = {}): LogPage {
  return { ok: true, count: 0, order: "desc", hasMore: false, entries: [], ...overrides };
}

test("queryLogs：只把非空筛选项挂上 query，逐项对齐后端参数名", async () => {
  const { calls, restore } = stubFetch(() => ({ body: emptyPage() }));
  try {
    await queryLogs({
      from: "2026-10-01T00:00:00Z",
      level: ["error", "warn"],
      module: ["ws", "mcp"],
      q: " 超时 ",
      limit: 50,
      // 刻意留空：空串 / 空数组 / undefined 都不该变成查询参数
      to: "",
      requestId: undefined,
      order: undefined,
      cursor: "",
    });
    const url = new URL(calls[0]!.url, "http://localhost");
    assert.equal(url.pathname, "/logs");
    assert.equal(url.searchParams.get("from"), "2026-10-01T00:00:00Z");
    assert.equal(url.searchParams.get("level"), "error,warn");
    assert.equal(url.searchParams.get("module"), "ws,mcp");
    assert.equal(url.searchParams.get("q"), " 超时 ");
    assert.equal(url.searchParams.get("limit"), "50");
    for (const absent of ["to", "requestId", "order", "cursor"]) {
      assert.equal(url.searchParams.has(absent), false, `${absent} 不该出现（值为空）`);
    }
    // 空数组同样不出现在 query 上
    await queryLogs({ level: [], module: [] });
    assert.equal(calls[1]!.url, "/logs", "没有任何筛选时不应带 ?");
    assert.equal(calls[0]!.init?.headers && (calls[0]!.init.headers as Record<string, string>).accept, "application/json");
  } finally {
    restore();
  }
});

test("queryStats：走 /logs/stats，与 queryLogs 共用同一套筛选映射", async () => {
  const { calls, restore } = stubFetch(() => ({
    body: { ok: true, groupedBy: "template", count: 0, stats: [] },
  }));
  try {
    await queryStats({ level: ["error"], limit: 10 });
    const url = new URL(calls[0]!.url, "http://localhost");
    assert.equal(url.pathname, "/logs/stats");
    assert.equal(url.searchParams.get("level"), "error");
  } finally {
    restore();
  }
});

test("非 2xx 时抛出带状态码与路径的错误（而不是把错误体当数据用）", async () => {
  const { restore } = stubFetch(() => ({ status: 503, body: { ok: false } }));
  try {
    await assert.rejects(() => queryLogs({}), /日志接口返回 503（\/logs）/);
  } finally {
    restore();
  }
});

test("AbortSignal 原样透传给 fetch", async () => {
  const { calls, restore } = stubFetch(() => ({ body: emptyPage() }));
  try {
    const controller = new AbortController();
    await queryLogs({}, controller.signal);
    assert.equal(calls[0]!.init?.signal, controller.signal);
  } finally {
    restore();
  }
});

test("queryAllForExport：按 nextCursor 翻页，直到 hasMore=false", async () => {
  const pages: LogPage[] = [
    emptyPage({ entries: [{ msg: "a" }], hasMore: true, nextCursor: "c1" }),
    emptyPage({ entries: [{ msg: "b" }], hasMore: true, nextCursor: "c2" }),
    emptyPage({ entries: [{ msg: "c" }], hasMore: false }),
  ];
  let index = 0;
  const { calls, restore } = stubFetch(() => ({ body: pages[index++]! }));
  try {
    const result = await queryAllForExport({ q: "x" }, 20_000);
    assert.deepEqual(result, { entries: [{ msg: "a" }, { msg: "b" }, { msg: "c" }], truncated: false });
    assert.equal(calls.length, 3);
    assert.equal(new URL(calls[0]!.url, "http://localhost").searchParams.get("cursor"), null);
    assert.equal(new URL(calls[1]!.url, "http://localhost").searchParams.get("cursor"), "c1");
    assert.equal(new URL(calls[2]!.url, "http://localhost").searchParams.get("cursor"), "c2");
    // 导出走的是自己的分页步长，不沿用 UI 的 limit
    assert.equal(new URL(calls[0]!.url, "http://localhost").searchParams.get("limit"), "1000");
  } finally {
    restore();
  }
});

test("queryAllForExport：恰好等于上限且已无下一页时**不谎报**截断（回归）", async () => {
  const { restore } = stubFetch(() => ({ body: emptyPage({ entries: [{ msg: "a" }, { msg: "b" }], hasMore: false }) }));
  try {
    assert.deepEqual(await queryAllForExport({}, 2), { entries: [{ msg: "a" }, { msg: "b" }], truncated: false });
  } finally {
    restore();
  }
});

test("queryAllForExport：确实超出上限时截断并如实标记", async () => {
  const { restore } = stubFetch(() => ({
    body: emptyPage({ entries: [{ msg: "a" }, { msg: "b" }, { msg: "c" }], hasMore: false }),
  }));
  try {
    assert.deepEqual(await queryAllForExport({}, 2), {
      entries: [{ msg: "a" }, { msg: "b" }],
      truncated: true,
    });
  } finally {
    restore();
  }
});

test("queryAllForExport：还有下一页但已达上限时立即停止，不再多拉一页", async () => {
  const { calls, restore } = stubFetch(() => ({
    body: emptyPage({ entries: [{ msg: "a" }, { msg: "b" }], hasMore: true, nextCursor: "c1" }),
  }));
  try {
    const result = await queryAllForExport({}, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.entries.length, 2);
    assert.equal(calls.length, 1, "达到上限后不该再发第二次请求");
  } finally {
    restore();
  }
});
