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
  /** 可选：已知某 id 已入库则跳过重新 embedding（持久化后端靠它做"重启不重算"）。 */
  has?(id: string): boolean | Promise<boolean>;
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

  has(id: string): boolean {
    return this.vectors.has(id);
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
  /** 内容寻址 id：同一 (文档, 段序, 正文) 稳定；正文变了→新 id，自然重算。 */
  id: string;
  name: string;
  text: string;
}

/** 稳定小哈希（FNV-1a → base36），不加密、只为内容变则 id 变。 */
function chunkHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
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
 * 持久化 store（实现 `has`）下，已入库且内容未变的 chunk 不重新 embedding——"重启不重算"。
 * 构建是异步（要调 embedding 源），用静态 `build()` 拿到一个就绪实例。
 */
export class VectorRetriever implements Retriever {
  readonly kind = "vector" as const;
  private readonly chunkById = new Map<string, ChunkMeta>();

  private constructor(
    private readonly docsByName: Map<string, KnowledgeDoc>,
    private readonly embeddings: EmbeddingProvider,
    private readonly store: VectorStore,
  ) {}

  /**
   * 实际送去向量化的文本：`title\nbody`。
   *
   * 抽成一处是因为它必须被**同一个值**用在两处：chunk id 的哈希（决定要不要重新 embedding）
   * 与 embed 的输入。两处不一致时，改标题不会触发重算，缓存下来的就是过期向量。
   */
  private static embedText(title: string, text: string): string {
    return `${title}\n${text}`;
  }

  /** 切段 → 只对未入库的 chunk 分批 embedding → upsert，返回就绪实例。 */
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
      const chunks = chunkDoc(doc);
      for (let i = 0; i < chunks.length; i += 1) {
        const text = chunks[i]!;
        // id 必须由**实际送去向量化的那段文本**派生（见 embedText）。
        // 只哈希 body 的话，改 frontmatter 的 `title` 不会让 id 变化 → `store.has()` 命中
        // → 跳过重新 embedding，库里还是旧向量，而 snippet 已是新文本：评分与展示不一致。
        metas.push({
          id: `${doc.name}#${i}#${chunkHash(VectorRetriever.embedText(doc.title, text))}`,
          name: doc.name,
          text,
        });
      }
    }
    for (const m of metas) retriever.chunkById.set(m.id, m);
    // 持久 store 已含且内容未变→跳过 embedding；InMemory/无 has 时 hasKnown=false。
    const toEmbed: ChunkMeta[] = [];
    for (const m of metas) {
      const known = store.has ? await store.has(m.id) : false;
      if (!known) toEmbed.push(m);
    }
    for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
      const batch = toEmbed.slice(i, i + EMBED_BATCH);
      // 把 title 拼进待向量化文本，让整段命中不只看 body。
      const vectors = await embeddings.embed(
        batch.map((m) => VectorRetriever.embedText(retriever.docsByName.get(m.name)?.title ?? "", m.text)),
      );
      if (vectors.length !== batch.length) {
        throw new Error(
          `embedding 返回 ${vectors.length} 条，期望 ${batch.length} 条（provider ${embeddings.id}）`,
        );
      }
      await store.upsert(vectors.map((vector, j) => ({ id: batch[j]!.id, vector })));
    }
    return retriever;
  }

  async search(query: string, limit = 5): Promise<RetrievalHit[]> {
    const q = query.trim();
    if (!q || this.chunkById.size === 0) return [];
    const [qvec] = await this.embeddings.embed([q]);
    if (!qvec) return [];
    const want = Math.max(1, limit);
    /**
     * 按文档聚合取最高分 chunk。
     *
     * 取样窗口必须**随结果扩大**：只取 `want*3` 个 chunk 时，某篇文档若命中大量 chunk 会把
     * 其它文档整篇挤出窗口，聚合后返回的文档数就少于 `want`（聚合式检索的经典欠取）。
     * 这里逐步翻倍，直到拿到 `want` 篇不同文档或把已知 chunk 都取过一遍。
     *
     * 上限用 `chunkById.size`（当前**有效** chunk 数）：持久库里可能留着改标题前的孤儿向量
     * （见 retrieval.test.ts），它们会占掉一些取样槽位——那是存储卫生问题，不影响正确性，
     * 因为下面的 `if (!meta) continue` 会把它们滤掉。
     */
    const total = this.chunkById.size;
    let take = Math.min(total, want * 3);
    let best = new Map<string, { score: number; chunk: ChunkMeta }>();
    for (;;) {
      const results = await this.store.query(qvec, take);
      best = new Map<string, { score: number; chunk: ChunkMeta }>();
      for (const r of results) {
        const meta = this.chunkById.get(r.id);
        if (!meta) continue;
        const cur = best.get(meta.name);
        if (!cur || r.score > cur.score) best.set(meta.name, { score: r.score, chunk: meta });
      }
      if (best.size >= want || take >= total) break;
      take = Math.min(total, take * 2);
    }
    const hits: RetrievalHit[] = [];
    for (const [name, { score, chunk }] of best) {
      const doc = this.docsByName.get(name);
      if (!doc) continue;
      hits.push({
        name,
        title: doc.title,
        description: doc.description,
        score,
        snippet: snippet(chunk.text),
      });
    }
    hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return hits.slice(0, want);
  }
}

function snippet(text: string, width = 200): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > width ? `${clean.slice(0, width)}…` : clean;
}
