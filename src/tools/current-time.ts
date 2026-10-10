/**
 * pi-starter · 示例工具：current_time（获取当前时间）
 *
 * 这是一个最小可用的 defineTool 示例，演示工具三件套：
 *   ① name / description —— 给 LLM 看的说明书（决定了它什么时候会用）
 *   ② parameters        —— 参数 schema（TypeBox 定义，框架自动校验）
 *   ③ execute           —— 真正干活，返回给 LLM 的结果
 *
 * 新工具照这个结构写即可。加完别忘在 tools/index.ts 里登记。
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const currentTimeTool = defineTool({
  name: "current_time",
  label: "获取当前时间",
  description: "获取当前的日期和时间。当用户问「现在几点」「今天几号」时使用。",
  parameters: Type.Object({
    timezone: Type.Optional(
      Type.String({
        description: "可选，时区标识，如 Asia/Shanghai。默认本地时区。",
      }),
    ),
  }),

  async execute(_id, params: { timezone?: string }) {
    const now = new Date();
    if (params.timezone) {
      try {
        return {
          content: [
            {
              type: "text",
              text: `当前时间：${now.toLocaleString("zh-CN", { timeZone: params.timezone })}（${params.timezone}）`,
            },
          ],
          // 三个分支的 details 必须**同形状**，否则 SDK 的 AgentToolResult<T> 推断会失败
          // （可选字段在一支里有、另一支里没有，联合类型就对不上）。用 "local" 表示未指定。
          details: { ok: true, timezone: params.timezone },
        };
      } catch {
        // `toLocaleString` 只认 IANA 名称，而模型很自然会写 `UTC+8` / `GMT+8` ——
        // 那两种在 Node 里都是 RangeError。不吞掉的话这个工具会直接抛异常收场，
        // 而现在如实说明并给出可用写法，模型下一次调用就能自己改对。
        return {
          content: [
            {
              type: "text",
              text:
                `无法识别的时区「${params.timezone}」。时区必须是 IANA 名称，` +
                `例如 Asia/Shanghai、America/New_York、UTC（用 Etc/GMT-8 表示东八区，符号是反的）；` +
                `不要用 UTC+8 / GMT+8 这类写法。`,
            },
          ],
          details: { ok: false, timezone: params.timezone },
        };
      }
    }
    return {
      content: [{ type: "text", text: `当前时间：${now.toLocaleString("zh-CN")}（本地时区）` }],
      details: { ok: true, timezone: "local" },
    };
  },
});
