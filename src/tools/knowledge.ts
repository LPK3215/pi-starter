/**
 * pi-starter · 示例工具：search_knowledge / read_knowledge
 *
 * 知识库正文不进系统提示词。先检索，再按 name 读全文。
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { searchKnowledge, type KnowledgeDoc } from "../knowledge/index.js";

export function createSearchKnowledgeTool(docs: readonly KnowledgeDoc[]) {
  return defineTool({
    name: "search_knowledge",
    label: "检索知识库",
    description:
      "在知识库里按关键词检索。需要产品、业务或项目事实时先用这个，再 read_knowledge 读命中文档。",
    parameters: Type.Object({
      query: Type.String({ description: "关键词或短语" }),
      limit: Type.Optional(Type.Number({ description: "最多返回几条，默认 5" })),
    }),
    async execute(_id, params: { query: string; limit?: number }) {
      const hits = searchKnowledge(docs, params.query, params.limit ?? 5);
      if (hits.length === 0) {
        return {
          content: [{ type: "text", text: `知识库没有匹配「${params.query}」的文档。` }],
          details: { hits: [] },
        };
      }
      const text = hits
        .map(
          (hit, i) =>
            `${i + 1}. ${hit.name}（${hit.title}） score=${hit.score}\n   ${hit.snippet}`,
        )
        .join("\n");
      return { content: [{ type: "text", text }], details: { hits } };
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
