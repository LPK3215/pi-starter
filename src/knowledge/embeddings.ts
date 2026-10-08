/**
 * pi-starter · Embedding provider（可插拔）
 *
 * 只是 `EmbeddingProvider` 接口的两个官方姿势之外的实现：
 *   - OpenAICompatEmbeddings：任意 OpenAI 兼容 /v1/embeddings（含 ModelScope 等）；
 *   - OllamaEmbeddings：本机 Ollama /api/embed，跑本地小模型。
 * fetch 可注入，便于离线单测断言请求形状、不联网。向量库外部实现留待同接口扩展。
 */

import type { EmbeddingProvider } from "./retrieval.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function readError(res: Response, label: string): Promise<never> {
  const text = await res.text().catch(() => "");
  throw new Error(`${label} 失败：HTTP ${res.status} ${text.slice(0, 200)}`);
}

export interface OpenAICompatEmbeddingsOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchImpl?: Fetch;
}

/** OpenAI 兼容 /v1/embeddings：body `{ model, input: string[] }` → `data[].embedding`（按 index 对齐）。 */
export class OpenAICompatEmbeddings implements EmbeddingProvider {
  readonly id: string;
  private readonly fetchImpl: Fetch;
  constructor(private readonly opts: OpenAICompatEmbeddingsOptions) {
    this.id = `openai-compat:${opts.model}`;
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const res = await this.fetchImpl(`${trimBase(this.opts.baseUrl)}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.opts.model, input: texts }),
    });
    if (!res.ok) await readError(res, "embeddings");
    const json = (await res.json()) as { data?: { index?: number; embedding?: number[] }[] };
    const rows = Array.isArray(json.data) ? json.data : [];
    // 按 index 排序，保证与输入顺序一一对应（部分 provider 不保证顺序）。
    const ordered = rows
      .map((row, i) => ({ idx: typeof row.index === "number" ? row.index : i, emb: row.embedding }))
      .sort((a, b) => a.idx - b.idx);
    return ordered.map((o) => o.emb ?? []);
  }
}

export interface OllamaEmbeddingsOptions {
  baseUrl?: string;
  model: string;
  fetchImpl?: Fetch;
}

/** 本机 Ollama /api/embed：body `{ model, input: string[] }` → `embeddings: number[][]`。 */
export class OllamaEmbeddings implements EmbeddingProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: Fetch;
  constructor(private readonly opts: OllamaEmbeddingsOptions) {
    this.baseUrl = opts.baseUrl ?? "http://127.0.0.1:11434";
    this.id = `ollama:${opts.model}`;
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.fetchImpl(`${trimBase(this.baseUrl)}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.opts.model, input: texts }),
    });
    if (!res.ok) await readError(res, "ollama embeddings");
    const json = (await res.json()) as { embeddings?: number[][] };
    return Array.isArray(json.embeddings) ? json.embeddings : [];
  }
}
