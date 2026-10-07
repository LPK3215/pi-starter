/**
 * pi-starter · 扩展层
 *
 * 所有扩展在这里「登记」成 allExtensions，由 agent.ts 传给 DefaultResourceLoader。
 * 扩展 = 在 Agent 干活的固定环节上挂一段你自己的代码（pi.on）。
 *
 * 新增一个扩展 = 两个动作：
 *   1. 在 src/extensions/ 下新建一个文件（如 my-extension.ts）
 *      export function myExtension(pi: ExtensionAPI) { pi.on("事件名", handler) }
 *   2. 在下方 import 并加入 allExtensions 数组
 *
 * 常用事件（对应 pi-agent-notes P06 章事件菜单）：
 *   tool_call          → 工具执行前（可拦截 block / 改参数）★ 最常用
 *   tool_result        → 工具执行后（可改返回内容）
 *   context            → 发 LLM 前（可注入消息，如用户偏好）
 *   input              → 收到用户输入后（可改写 / 拦截）
 *   before_agent_start → 开跑前（可改系统提示词）
 *   agent_settled      → 一次 prompt() 彻底跑完（可靠结束信号）
 *   tool_execution_start / end → 工具实际开跑 / 结束（审计日志）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { auditExtension } from "./audit.js";
import { guardExtension } from "./guard.js";

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

/** 脚手架内置扩展清单：新扩展往这里加 */
export const allExtensions: ExtensionFactory[] = [
  guardExtension,
  auditExtension,
];
