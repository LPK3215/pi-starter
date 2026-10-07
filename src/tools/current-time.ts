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
    const text = params.timezone
      ? `当前时间：${now.toLocaleString("zh-CN", { timeZone: params.timezone })}（${params.timezone}）`
      : `当前时间：${now.toLocaleString("zh-CN")}（本地时区）`;
    return { content: [{ type: "text", text }], details: {} };
  },
});
