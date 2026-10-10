/**
 * pi-starter · 记忆工具：remember / recall
 *
 * 跨会话记忆的模型侧入口。这两条与知识库工具的**根本差别**是「知识库只读、记忆可写」，
 * 所以这里多了一层「写什么」的约束：记忆是长期上下文，写进去的每条都会被未来的自己读到，
 * 无节制地记等于让噪声随时间淹没信号。
 *
 * 与 `search_knowledge` / `read_knowledge` 一样，工具只在**有记忆存储**时装配
 * （见 `agent.ts`），没有存储时不注册——不注册比注册一个永远报错的工具诚实。
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { MAX_MEMORY_BYTES, type MemoryStore } from "../memory/store.js";

/**
 * 写入 / 覆盖一条长期记忆。
 *
 * 描述里刻意把「该记什么、不该记什么」写给模型看：这是记忆类工具最容易用错的地方
 * （模型会把整段对话摘录当作记忆写进去）。
 */
export function createRememberTool(store: MemoryStore) {
  return defineTool({
    name: "remember",
    label: "记住一条长期信息",
    description:
      "把一条**跨会话有用**的信息持久化，供以后的对话用 recall 取回。" +
      "适合记：用户偏好与约定（称呼、语言、代码风格）、长期有效的项目事实、上次未完成的结论。" +
      "不要记：可从工具实时查到的内容（时间、文件、库里的行）、一次性的对话细节、" +
      "涉密信息（密钥、口令）。同一段正文重复写入会覆盖而不是新增，所以纠正记忆直接用新正文再写一次。",
    parameters: Type.Object({
      text: Type.String({
        description:
          "要记住的正文。一句话到一小段，写清楚「是什么」而不是「什么时候说的」。",
        maxLength: MAX_MEMORY_BYTES,
      }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "可选标签，便于以后过滤，如 [\"preference\", \"project\"]。",
          maxItems: 16,
        }),
      ),
    }),
    async execute(_id, params: { text: string; tags?: string[] }) {
      try {
        const { entry, evicted } = store.remember({ text: params.text, tags: params.tags });
        const evictedNote = evicted > 0 ? `（超出上限，已淘汰 ${evicted} 条最旧的记忆）` : "";
        return {
          content: [
            { type: "text", text: `已记住（id=${entry.id}）${evictedNote}：${entry.text}` },
          ],
          details: { ok: true, id: entry.id, tags: entry.tags, evicted, reason: "" },
        };
      } catch (err) {
        // 校验失败要如实回给模型，让它自己改小或改短，而不是抛异常收场。
        const reason = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `没能记住：${reason}` }],
          details: { ok: false, id: "", tags: [], evicted: 0, reason },
        };
      }
    },
  });
}

/** 检索长期记忆。空查询 = 列出最近记过的若干条。 */
export function createRecallTool(store: MemoryStore) {
  return defineTool({
    name: "recall",
    label: "检索长期记忆",
    description:
      "取回以前用 remember 存下的跨会话记忆。用户提到「上次」「之前说过」「我的偏好」时先查这里。" +
      "query 留空则按时间倒序列出最近记过的几条。这是记忆，不是知识库：产品文档走 search_knowledge。",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "关键词。留空则列出最近记过的记忆。" }),
      ),
      limit: Type.Optional(Type.Number({ description: "最多返回几条，默认 5" })),
    }),
    async execute(_id, params: { query?: string; limit?: number }) {
      const hits = store.recall(params.query ?? "", params.limit);
      if (hits.length === 0) {
        const text = params.query?.trim()
          ? `没有匹配「${params.query}」的记忆。`
          : "还没有任何记忆。";
        return { content: [{ type: "text", text }], details: { hits: [], total: store.size } };
      }
      const text = hits
        .map((hit, i) => {
          const tagPart = hit.tags.length > 0 ? ` [${hit.tags.join(", ")}]` : "";
          return `${i + 1}. (${hit.id})${tagPart} ${hit.text}`;
        })
        .join("\n");
      return {
        content: [{ type: "text", text }],
        details: { hits, total: store.size },
      };
    },
  });
}
