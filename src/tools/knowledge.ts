/**
 * pi-starter · 示例工具：search_knowledge / read_knowledge
 *
 * 知识库正文不进系统提示词。先检索，再按 name 读全文。
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { KnowledgeDoc } from "../knowledge/index.js";
import type { Retriever } from "../knowledge/retrieval.js";

/** 检索条数的默认值与硬上限——上限挡的是"模型把整库正文塞进上下文"。 */
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 50;

/**
 * 检索工具——官方规定的 RAG 入口（`pi.registerTool` 一个可搜索工具）。
 * 只依赖 `Retriever`：背后是关键词还是向量库对模型透明；检索是 async。
 */
export function createSearchKnowledgeTool(retriever: Retriever) {
  return defineTool({
    name: "search_knowledge",
    label: "检索知识库",
    description:
      "在知识库里检索。需要产品、业务或项目事实时先用这个，再 read_knowledge 读命中文档。",
    parameters: Type.Object({
      query: Type.String({ description: "关键词或自然语言描述" }),
      limit: Type.Optional(Type.Number({ description: "最多返回几条，默认 5" })),
    }),
    async execute(_id, params: { query: string; limit?: number }) {
      // limit 来自模型（外部可控）：不设上界时一句 `limit: 100000` 就能把整库正文拖进一轮
      // 上下文。非数值 / 越界一律夹到 [1, MAX_SEARCH_LIMIT]。
      const raw = Number(params.limit ?? DEFAULT_SEARCH_LIMIT);
      const limit = Number.isFinite(raw)
        ? Math.min(Math.max(Math.trunc(raw), 1), MAX_SEARCH_LIMIT)
        : DEFAULT_SEARCH_LIMIT;
      const hits = await retriever.search(params.query, limit);
      if (hits.length === 0) {
        return {
          content: [{ type: "text", text: `知识库没有匹配「${params.query}」的文档。` }],
          details: { hits: [], retriever: retriever.kind },
        };
      }
      const text = hits
        .map(
          (hit, i) =>
            `${i + 1}. ${hit.name}（${hit.title}） score=${hit.score}\n   ${hit.snippet}`,
        )
        .join("\n");
      return { content: [{ type: "text", text }], details: { hits, retriever: retriever.kind } };
    },
  });
}

export function createReadKnowledgeTool(docs: readonly KnowledgeDoc[]) {
  const byName = new Map(docs.map((doc) => [doc.name, doc]));

  return defineTool({
    name: "read_knowledge",
    label: "读取知识库文档",
    description: "按 name 读取知识库文档全文。name 来自系统提示词目录或 search_knowledge 的命中。",
    parameters: Type.Object({
      name: Type.String({ description: "文档 name，不含 .md" }),
    }),
    async execute(_id, params: { name: string }) {
      const doc = byName.get(params.name);
      if (!doc) {
        const available = [...byName.keys()].join("、") || "（空）";
        return {
          content: [{ type: "text", text: `没有文档 ${params.name}。可用：${available}` }],
          details: { found: false, name: params.name },
        };
      }
      const header = `# ${doc.title}\n`;
      const text = doc.description ? `${header}${doc.description}\n\n${doc.body}` : `${header}${doc.body}`;
      return { content: [{ type: "text", text }], details: { found: true, name: doc.name } };
    },
  });
}
