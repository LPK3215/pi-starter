/**
 * pi-starter · SSE 事件翻译
 *
 * 把 AgentSession 事件翻成前端 / 任意语言都能读的 SSE 字符串。
 * 从 server.ts 拆出来，方便单测，也方便换传输层时复用协议。
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export const TOOL_RESULT_PREVIEW_LIMIT = 500;

/** 把一条消息格式化成 SSE 规范字符串 */
export function sse(type: string, data: unknown): string {
  return `data: ${JSON.stringify({ type, data })}\n\n`;
}

export function toolResultPreview(result: unknown, limit = TOOL_RESULT_PREVIEW_LIMIT): string {
  const text = extractToolResultText(result);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function extractToolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return "";
  const first = content[0];
  if (!first || typeof first !== "object") return "";
  const text = (first as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

/**
 * Pi 事件 → SSE 字符串（null = 前端不关心，跳过）
 * 对应 P07 章的事件翻译表。
 */
export function translateEvent(event: AgentSessionEvent): string | null {
  switch (event.type) {
    case "message_update": {
      const ae = event.assistantMessageEvent;
      if (ae?.type === "text_delta") return sse("text", { delta: ae.delta });
      if (ae?.type === "thinking_delta") return sse("thinking", { delta: ae.delta });
      return null;
    }
    case "tool_execution_start":
      return sse("tool_start", {
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
      });
    case "tool_execution_end":
      return sse("tool_end", {
        id: event.toolCallId,
        name: event.toolName,
        result: toolResultPreview(event.result),
        isError: event.isError ?? false,
      });
    default:
      return null;
  }
}

/**
 * 官方 JSON 事件流（json.md）：一条事件 = 一行 JSON，不做 SSE 封装。
 * 与 translateEvent 并存：后者是给前端的精简协议，这里给跨语言 / 自定义 UI 的原始事件出口。
 */
export function jsonlEvent(event: AgentSessionEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** NDJSON 首行的会话头，对齐 json.md 的 `{"type":"session",...}`。 */
export function jsonlSessionHeader(info: {
  id: string;
  timestamp: string;
  cwd: string;
  version?: number;
}): string {
  return `${JSON.stringify({
    type: "session",
    version: info.version ?? 3,
    id: info.id,
    timestamp: info.timestamp,
    cwd: info.cwd.replace(/\\/g, "/"),
  })}\n`;
}

/** 原始通道里一条非事件的错误行（失败/预检拒绝），仍是合法 JSON 行。 */
export function jsonlError(message: string, code?: string): string {
  return `${JSON.stringify({ type: "error", message, ...(code ? { code } : {}) })}\n`;
}
