/**
 * pi-starter · 示例扩展：audit（工具调用审计日志）
 *
 * 演示 pi.on 在「工具真正开跑 / 跑完」时挂日志。
 * 用 event.toolCallId 配对 start 和 end，算出每次工具调用的耗时。
 *
 * 生产环境把 console.log 换成写日志文件 / 打监控指标即可。
 */

import type {
  ExtensionAPI,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";

export function auditExtension(pi: ExtensionAPI) {
  const startTimes = new Map<string, number>();

  pi.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
    startTimes.set(event.toolCallId, Date.now());
    console.log(`📝 [审计] 调用工具 ${event.toolName}，参数：${JSON.stringify(event.args ?? {})}`);
  });

  pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
    const start = startTimes.get(event.toolCallId) ?? Date.now();
    startTimes.delete(event.toolCallId);
    const cost = Date.now() - start;
    console.log(
      `📝 [审计] ${event.toolName} 完成，耗时 ${cost}ms，${event.isError ? "❌ 失败" : "✅ 成功"}`,
    );
  });
}
