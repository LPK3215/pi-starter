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

import { chmodSync } from "node:fs";
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
    // 向量可能反映私有文档内容，收紧到仅本人可读。
    //
    // 必须显式 chmod：`new DatabaseSync(path)` 会按**进程 umask** 建文件（通常 0o644），
    // 并不接受权限参数——只写注释不 chmod，等于承诺了一个从未发生的动作。
    // `:memory:` 没有文件可收紧。
    if (this.path !== ":memory:") {
      try {
        chmodSync(this.path, 0o600);
      } catch {
        /* Windows 上是尽力而为 */
      }
    }
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
    const k = Math.max(0, topK);
    if (k === 0) return [];
    // 用 `iterate()` 边取边评、只保留前 k 名：原来的 `.all()` 会把**整张表的向量字节**
    // 一次性物化进内存（上限不受 topK 约束），库一大就把内存放大成库体积的函数。
    // 排序也从"全量排序"降为"对 k 个元素做有界插入"。
    const best: VectorSearchResult[] = [];
    const stmt = this.db.prepare("SELECT id, vector FROM pi_vectors");
    for (const row of stmt.iterate() as unknown as Iterable<{ id: string; vector: Uint8Array }>) {
      const stored = new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength));
      if (stored.length !== q.length) continue; // 维度不符（不同模型）跳过，不静默算错
      const item = { id: row.id, score: dot(q, stored) };
      // 插入位置按**与下面 sort 完全相同的口径**（分数降序、同分按 id 升序）二分：
      // 口径一致才能保证"截断到 k 条"的结果与全量排序后取前 k 逐字相同。
      // 浮点分数几乎不会相等，localeCompare 只在同分时才走。
      let lo = 0;
      let hi = best.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const b = best[mid]!;
        const bGoesFirst = b.score > item.score || (b.score === item.score && b.id.localeCompare(item.id) < 0);
        if (bGoesFirst) lo = mid + 1;
        else hi = mid;
      }
      best.splice(lo, 0, item);
      if (best.length > k) best.pop();
    }
    return best;
  }

  /** 清掉某篇文档的全部 chunk（重索引/删除时可选调用）。 */
  deleteByChunkPrefix(docName: string): number {
    // 刻意**不用 LIKE**：`_` 在 LIKE 里匹配任意单字符、`%` 匹配任意串，而文档名来自
    // `.md` 文件名——`a_b.md` 生成的 `a_b#%` 会把 `aXb#...` 的向量一并删掉（静默数据丢失）。
    // 用定长前缀比较做精确匹配。
    const prefix = `${docName}#`;
    const info = this.db
      .prepare("DELETE FROM pi_vectors WHERE substr(id, 1, ?) = ?")
      .run(prefix.length, prefix);
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
