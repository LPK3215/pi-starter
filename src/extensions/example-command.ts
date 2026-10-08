/**
 * 代码型斜杠命令示例（官方 `pi.registerCommand` + `pi.sendUserMessage`）
 *
 * 这是**示例**，默认不登记进 `allExtensions`。要用：把它传给
 * `buildAgent({ extraExtensions: [exampleCommandExtension] })`，或照它写自己的命令。
 * 官方文档：`extensions.md`（registerCommand / sendUserMessage / sendMessage）。
 *
 * 为什么单独有它：脚手架的斜杠命令默认走 **prompt templates(.md)**（文件名即 `/name`，
 * 由 SDK 在 `session.prompt` 里展开）——那是"数据型"命令。`pi.registerCommand` 是官方
 * 的**另一条**路：用代码定义命令，`handler` 里能主动 `pi.sendUserMessage` 注入一条用户
 * 消息并触发一轮，或 `pi.sendMessage` 注入自定义消息。两条都是官方机制，按需要用。
 *
 * 注意：注入 user 消息是**扩展**才有的能力（`AgentSession` 本身不暴露 sendUserMessage），
 * 所以这里通过扩展暴露，而不是硬造一条内核 WS 命令——不凭空加非官方的通道。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function exampleCommandExtension(pi: ExtensionAPI): void {
  // /deploy [target] —— 代码型命令：向模型注入一条固定的用户指令并触发一轮。
  pi.registerCommand("deploy", {
    description: "Summarize what a deploy to the target environment should cover",
    // handler 签名：(args, ctx) => Promise<void>。args 是命令后面跟的参数串。
    handler: async (args) => {
      const target = args?.trim() || "staging";
      // sendUserMessage 始终触发一轮；空闲时可直接发。
      pi.sendUserMessage(`列出部署到 ${target} 前需要确认的检查项。`);
    },
  });
}
