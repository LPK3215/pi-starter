/**
 * pi-starter · 示例工具：ask_user_question（回合中途反问人类并等待输入）
 *
 * 这是 HITL（human-in-the-loop）工具，演示**官方姿势**：不自己造等待/回收机制，
 * 直接调 SDK 的 `ctx.ui.input()/select()/confirm()`。SDK 只给 TUI 和 RPC 子进程配了
 * "谁来回答"，本项目跑进程内 + WS，所以 `ctx.ui` 由 extension-ui-bridge.ts 桥到 WS——
 * 工具本身完全不知道底下是终端还是 WebSocket，这正是官方接口的价值。
 *
 * 与"结束回合反问"的分工：
 *   - 简单问题（比如问年龄）更该**在正常回复里收尾**，等用户下一条消息——零工具、零阻塞。
 *   - 本工具用于「已经开始干活、只差一个具体事实、不想打断整轮」的场景：发问、阻塞等答案、
 *     拿到就继续。语义与审批闸门同源（gate.ts），二者都靠桥把问题推给人、等回复、兜底不挂死。
 *
 * 兜底：`ctx.hasUI` 为假（如 print/JSON 模式没有可应答界面）时不假装等待，直接回明情况，
 * 让模型改用正常提问收尾；用户取消/超时同样返回"未作答"，模型可据此重新决策。
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const askUserQuestionTool = defineTool({
  name: "ask_user_question",
  label: "向用户提问",
  description:
    "当缺少某个只有用户知道的事实、且必须在当前这一轮内拿到答案才能继续时，向用户提问并等待其输入。" +
    "不要用它替代能靠下一条消息解决的普通问题；仅在「继续执行比猜错更划算」时使用。",
  promptSnippet: "向用户提一个需要即时回答的问题并等待输入（文本 / 单选 / 确认）。",
  // 官方 `ToolDefinition.executionMode`：HITL 工具会阻塞等人类，强制串行以免与其它并发工具互相抢答。
  executionMode: "sequential",
  parameters: Type.Object({
    question: Type.String({ description: "要问用户的问题正文。" }),
    type: Type.Optional(
      Type.Union(
        [Type.Literal("text"), Type.Literal("select"), Type.Literal("confirm")],
        { description: "应答形式，默认 text。" },
      ),
    ),
    options: Type.Optional(
      Type.Array(Type.String(), { description: "type=select 时的候选项列表。" }),
    ),
    placeholder: Type.Optional(
      Type.String({ description: "type=text 时输入框的占位提示。" }),
    ),
  }),

  async execute(
    _id,
    params: { question: string; type?: "text" | "select" | "confirm"; options?: string[]; placeholder?: string },
    signal: AbortSignal | undefined,
    _onUpdate,
    ctx,
  ) {
    // 没有可应答的人类界面（无 UI 的运行模式）——不假装等待，如实交回模型。
    if (!ctx.hasUI) {
      return {
        content: [
          {
            type: "text",
            text: "当前运行环境没有可即时应答的人类界面。请在正常回复里直接向用户提问，等其下一条消息再继续。",
          },
        ],
        details: { answered: false, mode: "no-ui" },
      };
    }

    const kind = params.type ?? "text";
    let answer: string | boolean | undefined;
    if (kind === "confirm") {
      answer = await ctx.ui.confirm(params.question, params.question, { signal });
    } else if (kind === "select") {
      answer = await ctx.ui.select(params.question, params.options ?? [], { signal });
    } else {
      answer = await ctx.ui.input(params.question, params.placeholder, { signal });
    }

    // 取消 / 超时 / 无选项：confirm 的 false 也算未确认。
    if (answer === undefined || answer === false) {
      return {
        content: [
          { type: "text", text: "用户未作答（已取消或超时）。请据此调整后续，或在回复中重新提问。" },
        ],
        details: { answered: false, mode: kind },
      };
    }

    const text = typeof answer === "boolean" ? "用户已确认。" : `用户回答：${answer}`;
    return { content: [{ type: "text", text }], details: { answered: true, mode: kind, value: answer } };
  },
});
