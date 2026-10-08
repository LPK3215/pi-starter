/**
 * npm run rag:smoke —— 本地进程内 RAG 一键实机验证（可选，需网络/模型）
 *
 * 用官方入口姿势真跑一遍：装载 knowledge → TransformersEmbeddings（进程内，首次会下载权重）
 * → VectorRetriever 建索引 → 语义 query 检索 → 打印命中。
 *
 * 诚实原则：环境不满足（没装 @huggingface/transformers / 下载不通）时**明确 SKIP 并说明原因、
 * 退出码 0**——这是可选实机验证，不该因缺外部条件而把流水线判红；但真跑起来却没检索出结果会 FAIL。
 *
 * 可配 env：
 *   PI_EMBEDDINGS_MODEL（默认 Xenova/bge-small-zh-v1.5）
 *   PI_EMBEDDINGS_HF_ENDPOINT（直连不通时填 hf-mirror.com 等镜像）
 *   PI_EMBEDDINGS_CACHE_DIR（权重缓存目录）
 */

import { loadScaffoldKnowledge } from "../src/knowledge/index.js";
import { VectorRetriever, InMemoryVectorStore } from "../src/knowledge/retrieval.js";
import { TransformersEmbeddings } from "../src/knowledge/embeddings-transformers.js";

function skip(reason) {
  console.log(`SKIP  本地 RAG 实机验证：${reason}`);
  process.exit(0);
}

let TransformersEmbeddingsCtor;
try {
  // 触发对 @huggingface/transformers 的探测；没装则 loadTransformers 会抛清晰错误。
  TransformersEmbeddingsCtor = TransformersEmbeddings;
  await new TransformersEmbeddingsCtor({ model: "__probe__" }).embed(["ping"]).catch((err) => {
    const msg = String(err?.message ?? err);
    if (/需要安装 @huggingface\/transformers/.test(msg)) throw new Error("DEP_MISSING");
    throw err;
  });
} catch (err) {
  if (String(err?.message).includes("DEP_MISSING")) {
    skip("未安装 @huggingface/transformers（`npm i @huggingface/transformers`）");
  }
  // 其它错误（下载不通等）在下面 embed 阶段处理，这里放行到实跑。
}

const model = process.env.PI_EMBEDDINGS_MODEL?.trim() || "Xenova/bge-small-zh-v1.5";
const remoteHost = process.env.PI_EMBEDDINGS_HF_ENDPOINT?.trim() || undefined;
const cacheDir = process.env.PI_EMBEDDINGS_CACHE_DIR?.trim() || undefined;

const docs = loadScaffoldKnowledge();
if (docs.length === 0) skip("知识库为空，无从验证检索");

const embeddings = new TransformersEmbeddings({ model, ...(remoteHost ? { remoteHost } : {}), ...(cacheDir ? { cacheDir } : {}) });
console.log(`RUN   模型=${model} host=${remoteHost ?? "huggingface.co"} docs=${docs.map((d) => d.name).join(",")}`);

let retriever;
try {
  retriever = await VectorRetriever.build(docs, embeddings, new InMemoryVectorStore());
} catch (err) {
  const msg = String(err?.message ?? err);
  // 环境类不可用（网络/镜像/未装依赖/原生二进制未就绪）一律 SKIP，不把可选实机验证判红。
  if (/fetch failed|timeout|ENOTFOUND|ECONNREFUSED|ModelFileNotFound|network|onnxruntime|native|shared lib|GLIBC|Cannot find module|postinstall|install/i.test(msg)) {
    skip(`模型下载/运行环境不可用（网络、镜像或原生依赖）：${msg.slice(0, 160)}。装好 @huggingface/transformers、放行 onnxruntime 安装脚本、必要时设 PI_EMBEDDINGS_HF_ENDPOINT 后重试。`);
  }
  console.error(`FAIL  建索引出错：${msg}`);
  process.exit(1);
}

const hits = await retriever.search("如何更换使用的模型", 3);
console.log(`HITS  ${JSON.stringify(hits.map((h) => ({ name: h.name, score: Number(h.score.toFixed(3)) })))}`);
if (hits.length > 0 && hits[0].score > 0) {
  console.log("PASS  本地进程内 embedding + 向量检索已打通");
  await embeddings.dispose();
  process.exit(0);
}
console.error("FAIL  检索无有效命中");
await embeddings.dispose();
process.exit(1);
