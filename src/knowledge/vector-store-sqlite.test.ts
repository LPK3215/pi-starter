import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteVectorStore } from "./vector-store-sqlite.js";
import { VectorRetriever, type EmbeddingProvider } from "./retrieval.js";
import type { KnowledgeDoc } from "./index.js";
import { tempDir } from "../test-tmp.js";

function doc(name: string, title: string, body: string, description = ""): KnowledgeDoc {
  return { name, title, description, filePath: `/x/${name}.md`, body };
}
class FakeEmbeddings implements EmbeddingProvider {
  readonly id = "fake";
  calls = 0;
  constructor(private readonly vocab: string[]) {}
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map((t) => this.vocab.map((w) => (t.includes(w) ? 1 : 0.001)));
  }
}

const docs: KnowledgeDoc[] = [
  doc("faq", "常见问题", "如何切换模型：POST /model。", "怎么切换模型"),
  doc("pricing", "价格", "基础版 99 / 月。", "套餐"),
];

/**
 * 回归：注释曾承诺「首次开库设 0o600」，但代码里没有任何 chmod ——
 * `new DatabaseSync(path)` 按进程 umask 建文件（通常 0o644），
 * 而向量可能反映私有文档内容，共享主机上可被他人读取。
 */
test("SqliteVectorStore：落盘权限收紧到 0o600", () => {
  if (process.platform === "win32") return; // Windows 上 chmod 只能力所能及
  const file = join(tempDir("pi-vec-mode-"), "vectors.db");
  const store = new SqliteVectorStore({ path: file });
  try {
    assert.equal(statSync(file).mode & 0o777, 0o600, "向量库必须仅本人可读");
  } finally {
    store.close();
  }
});

/**
 * 回归：`deleteByChunkPrefix` 曾用 `id LIKE 'docName#%'`。
 *
 * 文档名来自 `.md` 文件名，而 LIKE 里 `_` 匹配任意单字符、`%` 匹配任意串——`a_b.md` 生成的
 * 模式会把 `aXb.md` 的全部向量一起删掉（静默数据丢失，且没有任何报错）。
 */
test("SqliteVectorStore：deleteByChunkPrefix 精确匹配（文档名里的 `_` 不是通配符）", async () => {
  const store = new SqliteVectorStore();
  await store.upsert([
    { id: "a_b.md#0#h", vector: [1, 0] },
    { id: "aXb.md#0#h", vector: [0, 1] },
  ]);

  assert.equal(store.deleteByChunkPrefix("a_b.md"), 1, "只删自己那一篇");
  assert.equal(store.has("a_b.md#0#h"), false);
  assert.equal(store.has("aXb.md#0#h"), true, "LIKE 会把这本不相干的向量一起删掉");
  store.close();
});

test("SqliteVectorStore：upsert/has/query + 关闭重开后仍在（持久化）", async () => {
  const file = join(tempDir("pi-vec-"), "vectors.db");
  const store = new SqliteVectorStore({ path: file });
  await store.upsert([
    { id: "a", vector: [1, 0] },
    { id: "b", vector: [0, 1] },
  ]);
  assert.equal(store.has("a"), true);
  assert.equal(store.has("zzz"), false);
  assert.equal(store.size, 2);
  const top = await store.query([1, 0], 2);
  assert.equal(top[0]?.id, "a");
  store.close();

  // 重开同一文件：向量还在（重启不重算的基础）。
  const reopened = new SqliteVectorStore({ path: file });
  assert.equal(reopened.has("a"), true);
  const top2 = await reopened.query([1, 0], 2);
  assert.equal(top2[0]?.id, "a");
  reopened.close();
});

test("VectorRetriever + SqliteVectorStore：第二次 build 不重新 embedding", async () => {
  const store = new SqliteVectorStore({ path: ":memory:" });
  const emb = new FakeEmbeddings(["切换", "模型"]);
  await VectorRetriever.build(docs, emb, store);
  assert.ok(emb.calls >= 1);
  const emb2 = new FakeEmbeddings(["切换", "模型"]);
  const ready = await VectorRetriever.build(docs, emb2, store);
  assert.equal(emb2.calls, 0, "已入库内容不变→不重算");
  // 检索仍能命中（从持久 store 读向量）
  const hits = await ready.search("切换 模型", 5);
  assert.equal(hits[0]?.name, "faq");
  store.close();
});
