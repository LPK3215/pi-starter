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

/**
 * 回归：chunk id 只哈希 body，而向量化文本含 title。
 *
 * 后果是"改 frontmatter 的 title 不重算向量"：持久 store 里留着旧向量，snippet 却是新文本，
 * 评分与展示不一致。id 必须由**实际送去向量化的那段文本**派生。
 */
test("VectorRetriever：改标题会重新 embedding，内容没变则命中缓存", async () => {
  const store = new InMemoryVectorStore();
  const embeddings = new FakeEmbeddings(["价格"]);
  const original = doc("pricing", "价格", "基础版 99 / 月。");
  await VectorRetriever.build([original], embeddings, store);

  // 反向：内容一字未动时必须仍走缓存（否则每次启动都全量重算，成本白付）。
  const beforeCacheHit = embeddings.calls;
  await VectorRetriever.build([original], embeddings, store);
  assert.equal(embeddings.calls, beforeCacheHit, "内容没变不应重新 embedding");

  // 只改 title，body 一字未动 → 必须重算。
  const beforeRetitle = embeddings.calls;
  const rebuilt = await VectorRetriever.build([doc("pricing", "定价说明", "基础版 99 / 月。")], embeddings, store);
  assert.ok(embeddings.calls > beforeRetitle, "改标题必须触发重新 embedding");
  // id 变了 → 旧向量在持久库里成为**孤儿**（没人再引用它）。这里刻意不断言"库里只剩一份"：
  // 清孤儿需要按文档名前缀删，而那会把新向量一起删掉。孤儿的代价只是存储。
  assert.equal(store.size, 2, "旧 id 的向量作为孤儿留下");
  const hits = await rebuilt.search("价格", 5);
  assert.equal(hits.length, 1, "孤儿不会以「没有正文的命中」形式出现");
  assert.equal(hits[0]?.title, "定价说明", "snippet/标题取自新的文档元数据");
});

/**
 * 回归：聚合式检索的**欠取**。
 *
 * 取样窗口固定为 `limit*3` 个 chunk 时，一篇长文档若占据排名前列，会把其它文档整篇挤出窗口，
 * 聚合后返回的文档数少于 limit。取样必须随结果扩大。
 */
test("VectorRetriever：单篇文档霸榜时仍返回 limit 篇不同文档（聚合不欠取）", async () => {
  // big 有 12 个高度相关的 chunk（切段按空行），o1/o2 各 1 个相关度略低的 chunk。
  // 若只取 3*3=9 个 chunk，窗口会被 big 填满，聚合后只剩 1 篇。
  const big = doc("big", "大文档", Array.from({ length: 12 }, () => "甲 甲 甲").join("\n\n"));
  const other1 = doc("o1", "其他一", "甲 乙");
  const other2 = doc("o2", "其他二", "甲 丙");
  const r = await VectorRetriever.build(
    [big, other1, other2],
    new FakeEmbeddings(["甲", "乙", "丙"]),
    new InMemoryVectorStore(),
  );

  const hits = await r.search("甲 甲 甲", 3);
  assert.equal(hits.length, 3, `三篇都应出现，实际 ${hits.map((h) => h.name).join(",")}`);
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
