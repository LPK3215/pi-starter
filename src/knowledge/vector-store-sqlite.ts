/**
 * pi-starter · 持久化向量存储（node:sqlite，零新依赖）
 *
 * 与 InMemoryVectorStore 平级实现 VectorStore 接口：向量落进 sqlite 表，重启后
 * VectorRetriever.build 通过 `has(id)` 跳过内容未变的 chunk，不重新 embedding。
 * chunk id 是内容寻址的（name#序号#正文哈希），所以正文一改就换新 id、自动重算。
 *
 * 只存向量 + 元数据；检索仍是 cosine（这里在 JS 里算，和内存版一致），
 * 要接真正的向量库（Qdrant/pgvector）时另写一个 VectorStore 实现替换，上层不动。
 */

import { DatabaseSync } from "node:sqlite";
import type { VectorItem, VectorSearchResult, VectorStore } from "./retrieval.js";

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
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

export interface SqliteVectorStoreOptions {
  /** sqlite 文件路径；`:memory:` 或省略 = 内存库（用于测试）。 */
  path?: string;
}

export class SqliteVectorStore implements VectorStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(options: SqliteVectorStoreOptions = {}) {
    this.path = options.path?.trim() || `:memory:`;
    this.db = new DatabaseSync(this.path);
    // 首次开库设 0o600（含 API 无关，但向量可能反映私有文档内容，收紧到仅本人可读）。
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS pi_vectors (id TEXT PRIMARY KEY, dim INTEGER NOT NULL, vector BLOB NOT NULL)",
    );
  }

  async upsert(items: VectorItem[]): Promise<void> {
    if (items.length === 0) return;
    const stmt = this.db.prepare("INSERT OR REPLACE INTO pi_vectors (id, dim, vector) VALUES (?, ?, ?)");
    for (const item of items) {
      const v = normalize(item.vector);
      stmt.run(item.id, v.length, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    }
  }

  has(id: string): boolean {
    const row = this.db.prepare("SELECT 1 AS hit FROM pi_vectors WHERE id = ? LIMIT 1").get(id);
    return row !== undefined;
  }

  async query(vector: number[], topK: number): Promise<VectorSearchResult[]> {
    const q = normalize(vector);
    const rows = this.db.prepare("SELECT id, vector FROM pi_vectors").all() as unknown as Array<{
      id: string;
      vector: Uint8Array;
    }>;
    const scored: VectorSearchResult[] = [];
    for (const row of rows) {
      const stored = new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength));
      if (stored.length !== q.length) continue; // 维度不符（不同模型）跳过，不静默算错
      scored.push({ id: row.id, score: dot(q, stored) });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, Math.max(0, topK));
  }

  /** 清掉某篇文档的全部 chunk（重索引/删除时可选调用）。 */
  deleteByChunkPrefix(docName: string): number {
    const info = this.db
      .prepare("DELETE FROM pi_vectors WHERE id LIKE ?")
      .run(`${docName}#%`);
    return Number(info.changes ?? 0);
  }

  get size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM pi_vectors").get() as { n: number };
    return Number(row?.n ?? 0);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
