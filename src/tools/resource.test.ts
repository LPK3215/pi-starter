import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createReadKnowledgeTool, createSearchKnowledgeTool } from "./knowledge.js";
import { KeywordRetriever } from "../knowledge/retrieval.js";
import { createDbQueryTool, createDbStatusTool } from "./database.js";
import { loadKnowledgeFromDirs, searchKnowledge } from "../knowledge/index.js";
import { loadSkillsFromDirs } from "../skills/index.js";
import { openDatabase } from "../db/index.js";
import type { KnowledgeDoc } from "../knowledge/index.js";
import type { Retriever } from "../knowledge/retrieval.js";
import type { DatabaseStore } from "../db/index.js";
import { tempDir } from "../test-tmp.js";

test("知识库 / 数据库工具登记正确的 name，加载结果可被检索", () => {
  const skillRoot = tempDir("pi-skill-");
  const knowledgeRoot = tempDir("pi-kb-");
  mkdirSync(join(skillRoot, "summarize"));
  writeFileSync(
    join(skillRoot, "summarize", "SKILL.md"),
    "---\nname: summarize\ndescription: 归纳长文本\n---\n# 正文\n",
  );
  writeFileSync(
    join(knowledgeRoot, "faq.md"),
    "---\ntitle: 常见问题\ndescription: 怎么切换模型\n---\nPOST /model\n",
  );

  const skills = loadSkillsFromDirs([skillRoot]);
  const docs = loadKnowledgeFromDirs([knowledgeRoot]);
  const db = openDatabase({ seed: true });
  try {
    assert.equal(skills[0]?.name, "summarize");
    assert.equal(createSearchKnowledgeTool(new KeywordRetriever(docs)).name, "search_knowledge");
    assert.equal(createReadKnowledgeTool(docs).name, "read_knowledge");
    assert.equal(createDbStatusTool(db).name, "db_status");
    assert.equal(createDbQueryTool(db).name, "db_query");
    assert.equal(searchKnowledge(docs, "切换模型")[0]?.name, "faq");
    assert.equal(db.ping().ok, true);
  } finally {
    db.close();
  }
});

/* ────────────────────── 工具 execute 路径 ────────────────────── */
// 上面只验了「name 登记对不对」与加载，execute 里的夹取、截断提示、失败翻译都没走到。

/** 调工具，抽出返回文本与 details。 */
async function runTool(
  tool: { execute: unknown },
  params: unknown,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const result = await (
    tool.execute as (id: string, params: unknown, signal: undefined, update: undefined, ctx: never) => Promise<{
      content: Array<{ type: string; text?: string }>;
      details: Record<string, unknown>;
    }>
  )("call-1", params, undefined, undefined, undefined as never);
  return {
    text: result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join(""),
    details: result.details,
  };
}

function fakeDoc(over: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return { name: "faq", title: "常见问题", description: "怎么切换模型", filePath: "/x/faq.md", body: "POST /model", ...over };
}

function fakeDatabase(over: Partial<DatabaseStore> = {}): DatabaseStore {
  return {
    driver: "sqlite",
    path: ":memory:",
    ping: () => ({ ok: true as const, driver: "sqlite", path: "/tmp/app.db" }),
    listNotes: () => [],
    getNote: () => undefined,
    searchNotes: () => [],
    insertNote: () => ({ id: 1, title: "t", body: "b" }),
    query: () => ({ columns: [], rows: [], truncated: false, totalRows: 0 }),
    close: () => {},
    ...over,
  } as unknown as DatabaseStore;
}

test("search_knowledge：limit 来自模型，必须被夹到 [1, 50]，非数值回落默认 5", async () => {
  const seen: number[] = [];
  const retriever: Retriever = {
    kind: "keyword",
    async search(_query, limit) {
      seen.push(limit ?? -1);
      return [];
    },
  };
  const tool = createSearchKnowledgeTool(retriever);
  await runTool(tool, { query: "x", limit: 100_000 });
  await runTool(tool, { query: "x", limit: 0 });
  await runTool(tool, { query: "x", limit: -3 });
  await runTool(tool, { query: "x", limit: Number.NaN });
  await runTool(tool, { query: "x", limit: "abc" });
  await runTool(tool, { query: "x" });
  assert.deepEqual(seen, [50, 1, 1, 5, 5, 5], "limit 必须被夹住，不能把整库正文拖进上下文");
});

test("search_knowledge：没命中就明说没命中，命中则逐条列出并带上 retriever 种类", async () => {
  const empty = createSearchKnowledgeTool({ kind: "vector", async search() { return []; } });
  const emptyRun = await runTool(empty, { query: "不存在的词" });
  assert.match(emptyRun.text, /没有匹配「不存在的词」的文档/);
  assert.equal(emptyRun.details.retriever, "vector");

  const hit = createSearchKnowledgeTool({
    kind: "keyword",
    async search() {
      return [{ name: "faq", title: "常见问题", score: 0.5, snippet: "POST /model" } as never];
    },
  });
  const hitRun = await runTool(hit, { query: "模型" });
  assert.match(hitRun.text, /1\. faq（常见问题） score=0\.5/);
  assert.match(hitRun.text, /POST \/model/);
});

test("read_knowledge：未知 name 列出可用文档；命中时按有无 description 拼装标题", async () => {
  const tool = createReadKnowledgeTool([fakeDoc(), fakeDoc({ name: "changelog", title: "变更", description: "" })]);
  const missing = await runTool(tool, { name: "nope" });
  assert.match(missing.text, /没有文档 nope/);
  assert.match(missing.text, /faq、changelog/, "要告诉模型有哪些可用，否则它只能瞎试");
  assert.equal(missing.details.found, false);

  const withDesc = await runTool(tool, { name: "faq" });
  assert.equal(withDesc.text, "# 常见问题\n怎么切换模型\n\nPOST /model");
  const withoutDesc = await runTool(tool, { name: "changelog" });
  assert.equal(withoutDesc.text, "# 变更\nPOST /model", "没有 description 时不该多出空行段");
  assert.equal(withoutDesc.details.found, true);
});

test("db_status：把 driver 与路径回给模型", async () => {
  const status = await runTool(createDbStatusTool(fakeDatabase()), {});
  assert.match(status.text, /数据库连通：sqlite \/tmp\/app\.db/);
  assert.equal(status.details.path, "/tmp/app.db");
});

test("db_query：非只读 SQL 在**落到 database.query 之前**就被拒", async () => {
  let called = 0;
  const tool = createDbQueryTool(fakeDatabase({ query: () => { called += 1; return { columns: [], rows: [], truncated: false, totalRows: 0 }; } }));
  const res = await runTool(tool, { sql: "DELETE FROM notes" });
  assert.equal(res.details.ok, false);
  assert.equal(called, 0, "被拒的 SQL 绝不能真的执行");
  assert.match(res.text, /SELECT|只允许/);
});

test("db_query：查询抛错时翻成「查询失败：…」，不把异常冒给模型", async () => {
  const tool = createDbQueryTool(fakeDatabase({ query: () => { throw new Error("no such table: nope"); } }));
  const res = await runTool(tool, { sql: "SELECT * FROM nope" });
  assert.equal(res.details.ok, false);
  assert.match(res.text, /查询失败：no such table: nope/);
});

test("db_query：被截断时必须显式告知真实总行数，否则模型会以为表只有这么长", async () => {
  const tool = createDbQueryTool(
    fakeDatabase({ query: () => ({ columns: ["id"], rows: [{ id: 1 }, { id: 2 }], truncated: true, totalRows: 500 }) }),
  );
  const res = await runTool(tool, { sql: "SELECT * FROM notes" });
  assert.equal(res.details.ok, true);
  assert.equal(res.details.truncated, true);
  assert.equal(res.details.totalRows, 500);
  assert.equal(res.details.rowCount, 2);
  assert.match(res.text, /实际共 500 行/);
  assert.match(res.text, /请加 LIMIT/, "要给出可执行的下一步，而不是只说被截断");

  const full = await runTool(
    createDbQueryTool(fakeDatabase({ query: () => ({ columns: ["id"], rows: [{ id: 1 }], truncated: false, totalRows: 1 }) })),
    { sql: "SELECT * FROM notes" },
  );
  assert.ok(!full.text.includes("[注意]"), "没截断就不该出现提示");
});
