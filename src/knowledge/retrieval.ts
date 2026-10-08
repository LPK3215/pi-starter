/**
 * pi-starter · 知识检索的可插拔层
 *
 * 官方 SDK 不提供 RAG——它给的正确入口是"自己 `pi.registerTool` 一个可搜索工具"
 * （见 docs/extensions.md 的 search 工具示例：内部实现可以是关键词、BM25、embeddings）。
 * 这一层把"检索怎么做"抽象成接口，`search_knowledge` 工具与 REST `/knowledge/search`
 * 只依赖 `Retriever`，不关心背后是关键词还是向量库。
 *
 * - 默认 `KeywordRetriever`：复用 knowledge/index.ts 现有关键词打分，**行为与从前一致**。
 * - `VectorRetriever`：把文档切成段落 → `EmbeddingProvider` 求向量 → `VectorStore` 存 + 检索。
 * - `EmbeddingProvider` / `VectorStore` 都是接口，后端可插拔：内置 `InMemoryVectorStore`
 *   零依赖，外部 Qdrant / pgvector / sqlite-vec 之后实现同接口插入即可，上层不动。
 */

import { searchKnowledge, type KnowledgeDoc, type KnowledgeHit } from "./index.js";

/** 一条检索命中（沿用 KnowledgeHit 形状，工具/路由只认它）。 */
export type RetrievalHit = KnowledgeHit;

export interface Retriever {
  readonly kind: "keyword" | "vector";
  search(query: string, limit?: number): Promise<RetrievalHit[]>;
}

/** 文本 → 向量。实现可以是本地小模型、远程 OpenAI 兼容端点等。 */
export interface EmbeddingProvider {
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorItem {
  id: string;
  vector: number[];
}

export interface VectorSearchResult {
  id: string;
  score: number;
}

/** 向量存取后端。内置内存实现零依赖；外部向量库实现同一接口即可替换。 */
export interface VectorStore {
  upsert(items: VectorItem[]): Promise<void>;
  query(vector: number[], topK: number): Promise<VectorSearchResult[]>;
}

/** 默认后端：关键词打分，包成 async。行为与迁移前一致。 */
export class KeywordRetriever implements Retriever {
  readonly kind = "keyword" as const;
  constructor(private readonly docs: readonly KnowledgeDoc[]) {}
  async search(query: string, limit = 5): Promise<RetrievalHit[]> {
    return searchKnowledge(this.docs, query, limit);
  }
}

/** 零依赖内存向量索引：归一化后点积即 cosine。适合小到中等语料；大规模换外部向量库。 */
export class InMemoryVectorStore implements VectorStore {
  private readonly vectors = new Map<string, Float32Array>();

  async upsert(items: VectorItem[]): Promise<void> {
    for (const item of items) this.vectors.set(item.id, normalize(item.vector));
  }

  async query(vector: number[], topK: number): Promise<VectorSearchResult[]> {
    const q = normalize(vector);
    const scored: VectorSearchResult[] = [];
    for (const [id, v] of this.vectors) {
      if (v.length !== q.length) continue; // 维度不一致（不同模型）跳过，不静默错算
      scored.push({ id, score: dot(q, v) });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, Math.max(0, topK));
  }

  get size(): number {
    return this.vectors.size;
  }
}

function normalize(vec: number[]): Float32Array {
  const out = new Float32Array(vec.length);
  let norm = 0;
  for (let i = 0; i < vec.length; i += 1) {
    out[i] = vec[i] ?? 0;
    norm += out[i]! * out[i]!;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i += 1) out[i] = out[i]! / norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

/** 每文档最多切成多少段、单段最大字符、每批送多少个 chunk 去 embedding。 */
export const MAX_CHUNKS_PER_DOC = 200;
export const MAX_CHUNK_CHARS = 2000;
export const EMBED_BATCH = 64;

interface ChunkMeta {
  name: string;
  text: string;
}

function chunkDoc(doc: KnowledgeDoc): string[] {
  const paras = doc.body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  for (const para of paras) {
    if (chunks.length >= MAX_CHUNKS_PER_DOC) break;
    chunks.push(para.length > MAX_CHUNK_CHARS ? para.slice(0, MAX_CHUNK_CHARS) : para);
  }
  // 空正文兜底：至少用 title+description 建一个 chunk，别让整篇文档进不了索引。
  if (chunks.length === 0) {
    const fallback = [doc.title, doc.description].filter(Boolean).join(" ").trim();
    if (fallback) chunks.push(fallback);
  }
  return chunks;
}

/**
 * 向量检索：启动时把文档切段→求 embedding→存进 VectorStore；检索时把 query 也向量化，
 * 取 topK 个 chunk 后**按文档聚合**（一篇取最高分 chunk 作分），snippet 用命中的 chunk。
 * 构建是异步（要调 embedding 源），用静态 `build()` 拿到一个就绪实例。
 */
export class VectorRetriever implements Retriever {
  readonly kind = "vector" as const;
  private metas: ChunkMeta[] = [];

  private constructor(
    private readonly docsByName: Map<string, KnowledgeDoc>,
    private readonly embeddings: EmbeddingProvider,
    private readonly store: VectorStore,
  ) {}

  /** 切段 → 分批 embedding → 存进 store，返回一个就绪实例。 */
  static async build(
    docs: readonly KnowledgeDoc[],
    embeddings: EmbeddingProvider,
    store: VectorStore = new InMemoryVectorStore(),
  ): Promise<VectorRetriever> {
    const retriever = new VectorRetriever(
      new Map(docs.map((d) => [d.name, d])),
      embeddings,
      store,
    );
    const metas: ChunkMeta[] = [];
    for (const doc of docs) {
      for (const chunk of chunkDoc(doc)) {
        metas.push({ name: doc.name, text: chunk });
      }
    }
    for (let i = 0; i < metas.length; i += EMBED_BATCH) {
      const batch = metas.slice(i, i + EMBED_BATCH);
      // 把 title 拼进待向量化文本，让整段命中不只看 body。
      const vectors = await embeddings.embed(
        batch.map((m) => `${retriever.docsByName.get(m.name)?.title ?? ""}\n${m.text}`),
      );
      if (vectors.length !== batch.length) {
        throw new Error(
          `embedding 返回 ${vectors.length} 条，期望 ${batch.length} 条（provider ${embeddings.id}）`,
        );
      }
      await store.upsert(vectors.map((vector, j) => ({ id: String(i + j), vector })));
    }
    retriever.metas = metas;
    return retriever;
  }

  async search(query: string, limit = 5): Promise<RetrievalHit[]> {
    const q = query.trim();
    if (!q || this.metas.length === 0) return [];
    const [qvec] = await this.embeddings.embed([q]);
    if (!qvec) return [];
    const results = await this.store.query(qvec, Math.min(this.metas.length, Math.max(1, limit) * 3));
    // 按文档聚合：同一篇取最高分 chunk。
    const best = new Map<string, { score: number; chunkIndex: number }>();
    for (const r of results) {
      const idx = Number(r.id);
      const meta = this.metas[idx];
      if (!meta) continue;
      const cur = best.get(meta.name);
      if (!cur || r.score > cur.score) best.set(meta.name, { score: r.score, chunkIndex: idx });
    }
    const hits: RetrievalHit[] = [];
    for (const [name, { score, chunkIndex }] of best) {
      const doc = this.docsByName.get(name);
      if (!doc) continue;
      hits.push({
        name,
        title: doc.title,
        description: doc.description,
        score,
        snippet: snippet(this.metas[chunkIndex]!.text),
      });
    }
    hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return hits.slice(0, Math.max(1, limit));
  }
}

function snippet(text: string, width = 200): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > width ? `${clean.slice(0, width)}…` : clean;
}
