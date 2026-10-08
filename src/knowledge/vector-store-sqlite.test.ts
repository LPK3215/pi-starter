import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteVectorStore } from "./vector-store-sqlite.js";
import { VectorRetriever, type EmbeddingProvider } from "./retrieval.js";
import type { KnowledgeDoc } from "./index.js";

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

test("SqliteVectorStore：upsert/has/query + 关闭重开后仍在（持久化）", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pi-vec-")), "vectors.db");
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
