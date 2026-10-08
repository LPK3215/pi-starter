import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryVectorStore,
  KeywordRetriever,
  VectorRetriever,
  type EmbeddingProvider,
} from "./retrieval.js";
import type { KnowledgeDoc } from "./index.js";
import { searchKnowledge } from "./index.js";

function doc(name: string, title: string, body: string, description = ""): KnowledgeDoc {
  return { name, title, description, filePath: `/x/${name}.md`, body };
}

// 确定性假 embedding：按小词表命中计数成向量（无需网络即可验证语义排序）。可记录调用次数。
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
  doc("faq", "常见问题", "如何切换模型：POST /model。模型切换示例见文档。", "怎么切换模型"),
  doc("pricing", "价格", "基础版 99 / 月，专业版 299 / 月。", "套餐与计费"),
];

test("KeywordRetriever 与 searchKnowledge 结果一致", async () => {
  const r = new KeywordRetriever(docs);
  const viaTool = await r.search("切换模型", 5);
  const direct = searchKnowledge(docs, "切换模型", 5);
  assert.equal(r.kind, "keyword");
  assert.deepEqual(viaTool.map((h) => h.name), direct.map((h) => h.name));
});

test("VectorRetriever：语义命中排序 + 按文档聚合 + limit", async () => {
  const r = await VectorRetriever.build(
    docs,
    new FakeEmbeddings(["切换", "模型", "价格", "版本"]),
    new InMemoryVectorStore(),
  );
  assert.equal(r.kind, "vector");
  const hits = await r.search("切换 模型", 5);
  assert.equal(hits[0]?.name, "faq", "含『切换/模型』的文档排第一");
  assert.ok(hits.every((h) => h.score > 0), "命中项有正分");

  const priced = await r.search("价格 版本", 5);
  assert.equal(priced[0]?.name, "pricing", "价格类 query 命中 pricing");

  const one = await r.search("切换 模型 价格 版本", 1);
  assert.equal(one.length, 1, "limit 生效");
});

test("VectorRetriever：空库返回空、不抛；空 query 返回空", async () => {
  const empty = await VectorRetriever.build([], new FakeEmbeddings(["x"]), new InMemoryVectorStore());
  assert.deepEqual(await empty.search("任何"), []);
  const r = await VectorRetriever.build(docs, new FakeEmbeddings(["切换", "模型"]), new InMemoryVectorStore());
  assert.deepEqual(await r.search("   "), []);
});

test("InMemoryVectorStore：cosine topK 排序、维度不一致跳过", async () => {
  const store = new InMemoryVectorStore();
  await store.upsert([
    { id: "a", vector: [1, 0] },
    { id: "b", vector: [0, 1] },
  ]);
  const top = await store.query([1, 0], 2);
  assert.equal(top[0]?.id, "a");
  assert.ok((top[0]?.score ?? 0) > (top[1]?.score ?? 0));
  // 维度不一致的候选被跳过，不静默算错
  await store.upsert([{ id: "c", vector: [1, 0, 0] }]);
  const after = await store.query([1, 0], 5);
  assert.ok(!after.some((r) => r.id === "c"), "维度不符的条目不进结果");
});

test("持久化 store（has）下，第二次 build 不重新 embedding", async () => {
  const store = new InMemoryVectorStore();
  const emb = new FakeEmbeddings(["切换", "模型"]);
  await VectorRetriever.build(docs, emb, store);
  const callsAfterFirst = emb.calls;
  assert.ok(callsAfterFirst >= 1, "第一次必须真的算过 embedding");
  const emb2 = new FakeEmbeddings(["切换", "模型"]);
  await VectorRetriever.build(docs, emb2, store); // 复用已填充的 store
  assert.equal(emb2.calls, 0, "已入库且内容未变的 chunk 不再重算");
});
