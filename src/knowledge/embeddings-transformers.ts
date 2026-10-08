/**
 * pi-starter · 进程内 embedding（@huggingface/transformers.js，opt-in）
 *
 * 就是 Python `transformers.js` 的 JS 端口：**首次用直接从 HF Hub 下载 ONNX 权重到
 * 指定缓存目录、进程内跑，不依赖 Ollama 或任何外部服务**。
 *
 * 但 `@huggingface/transformers`（含原生 `onnxruntime-node`）是重依赖——所以：
 *   - 用**动态 import**、非字面量模块名引入，未安装时也不影响 typecheck / 默认零依赖；
 *   - 只有 `PI_EMBEDDINGS_PROVIDER=transformers`（或显式 buildAgent({ embeddings })）时才加载；
 *   - 用到而没装 → 抛清晰提示，绝不静默。
 *
 * 生命周期（你要的下载/加载/使用/卸载）：
 *   - 下载+加载：第一次 embed() 触发 pipeline 构建，权重落到 cacheDir；
 *   - 使用：embed(texts)；
 *   - 卸载：dispose() 释放 pipeline；删缓存目录即彻底清掉本地权重（`clearEnvCache` 提示）。
 */

import type { EmbeddingProvider } from "./retrieval.js";

export interface TransformersEmbeddingsOptions {
  /** HF 模型 id，默认 Xenova/bge-small-zh-v1.5（中英小模型）。 */
  model?: string;
  /** 权重缓存目录；省略则用 transformers.js 默认（用户目录下）。可指到 C 盘某处。 */
  cacheDir?: string;
  /** 量化权重（更小更快），默认 true。 */
  quantized?: boolean;
}

const DEFAULT_MODEL = "Xenova/bge-small-zh-v1.5";

// 动态取包：非字面量 specifier → TS 不去解析其类型，未安装也能编译。
async function loadTransformers(): Promise<any> {
  const specifier = "@huggingface/transformers";
  try {
    return await import(specifier);
  } catch {
    throw new Error(
      "进程内 embedding 需要先安装 @huggingface/transformers（`npm i @huggingface/transformers`），" +
        "或改用远程/Ollama 的 OpenAI 兼容 embeddings 端点。",
    );
  }
}

function toVectors(out: any, count: number): number[][] {
  // pipeline 返回张量；.tolist() 对 batch 输入是 [n, dim]，单条可能是 [dim]。
  const raw = typeof out?.tolist === "function" ? out.tolist() : out;
  if (!Array.isArray(raw)) throw new Error("transformers.js 返回了非预期结构");
  const nested = Array.isArray(raw[0]) ? raw : [raw];
  if (nested.length !== count) {
    throw new Error(`embedding 返回 ${nested.length} 条，期望 ${count} 条`);
  }
  return nested.map((row: unknown) => Array.from(row as number[]));
}

export class TransformersEmbeddings implements EmbeddingProvider {
  readonly id: string;
  private readonly model: string;
  private readonly cacheDir?: string;
  private readonly quantized: boolean;
  private pipelinePromise: Promise<any> | undefined;

  constructor(options: TransformersEmbeddingsOptions = {}) {
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.cacheDir = options.cacheDir?.trim() || undefined;
    this.quantized = options.quantized ?? true;
    this.id = `transformers:${this.model}`;
  }

  private async pipeline(): Promise<any> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        const hf = await loadTransformers();
        if (this.cacheDir && hf.env) hf.env.cacheDir = this.cacheDir;
        if (hf.env) hf.env.allowRemoteModels = true;
        // feature-extraction 即 embedding 池化管线。
        return hf.pipeline("feature-extraction", this.model, { quantized: this.quantized });
      })();
    }
    return this.pipelinePromise;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const pipe = await this.pipeline();
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    return toVectors(out, texts.length);
  }

  /** 释放 pipeline（进程内推理资源）。本地权重文件仍在 cacheDir，删之即彻底卸载。 */
  async dispose(): Promise<void> {
    const pending = this.pipelinePromise;
    this.pipelinePromise = undefined;
    try {
      const pipe = await pending;
      // transformers.js 的 pipeline 实例可能提供 dispose/term；没有也无妨，交给 GC。
      if (pipe && typeof pipe.dispose === "function") await pipe.dispose();
    } catch {
      /* 从未成功构建，忽略 */
    }
  }
}
