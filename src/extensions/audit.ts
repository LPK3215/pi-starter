/**
 * pi-starter · 工具调用审计（audit）
 *
 * 记录每次工具调用的起止、耗时与成败。挂在 SDK 的两个可靠事件上：
 *   tool_execution_start → 记开始时间
 *   tool_execution_end   → 配对算出耗时
 *
 * 安全说明（改造重点）：原先直接 `JSON.stringify(event.args)` 写日志，会把
 * `db_query` 的 SQL、`write` 的文件内容、乃至任何入参里的密钥原文落盘。
 * 现在统一走结构化 logger + 自动脱敏（见 log.ts），只记录**元信息**：
 * 工具名、参数字段名列表、耗时、成败。参数值默认不记录。
 */

import type {
  ExtensionAPI,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getLogger } from "../log.js";

/** 单个会话内保留的进行中调用上限，防止 toolCallId 异常时无界增长。 */
const MAX_TRACKED = 256;

export interface AuditOptions {
  /** 是否记录参数**字段名**（不记录值）。默认 true——字段名对排障有用，值可能敏感。 */
  logArgKeys?: boolean;
}

export function auditExtension(pi: ExtensionAPI, options: AuditOptions = {}) {
  const logger = getLogger().child({ component: "audit" });
  const logArgKeys = options.logArgKeys !== false;
  const startTimes = new Map<string, { at: number; toolName: string }>();

  pi.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
    // Defensive cap: a leaked entry would otherwise grow this map without bound.
    if (startTimes.size >= MAX_TRACKED) {
      const oldest = startTimes.keys().next();
      if (!oldest.done) startTimes.delete(oldest.value);
    }
    startTimes.set(event.toolCallId, { at: Date.now(), toolName: event.toolName });
    logger.debug("工具调用开始", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      // Field NAMES only — values may contain SQL, file contents or credentials.
      argKeys: logArgKeys ? Object.keys(event.args ?? {}).sort() : undefined,
    });
  });

  pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
    const started = startTimes.get(event.toolCallId);
    startTimes.delete(event.toolCallId);
    const durationMs = started ? Date.now() - started.at : undefined;
    // Failures deserve warn so they surface above info noise in normal operation.
    const write = event.isError ? logger.warn.bind(logger) : logger.debug.bind(logger);
    write("工具调用结束", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      durationMs,
      isError: event.isError === true,
    });
  });
}
