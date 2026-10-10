/**
 * pi-starter · 消息投影层（SDK 消息 → 线协议 `UiMessage`）
 *
 * 从 `session-hub.ts` 拆出。这里全是**纯函数 + 弱引用缓存类型**，不持有任何会话状态、
 * 不碰 WebSocket、不依赖 `Conversation`，因此可以单独测、单独推理。
 *
 * 三件事：
 *   1. 把 SDK 的 `AgentMessage` 投影成线协议 `UiMessage`（`projectMessage`）——
 *      这是「同一对象引用 → 同一 `UiMessage` 对象」的仅追加优化所在；
 *   2. 从消息内容形态里抽文本（`extractText` / `extractPartialText`），历史与流式共用同一套判定；
 *   3. 从首条用户消息推标题、把提示词压成进度行（`deriveTitle` / `summarizePrompt`）。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UiMessage, UiToolCall } from "../protocol.js";

/** 消息投影缓存：保证「仅追加」判定能靠对象引用等同性完成。 */
export type ProjectionCache = WeakMap<AgentMessage, UiMessage | null>;
/** 投影内容签名：签名变 => 必须换新对象（见 projectMessage）。 */
export type ProjectionSig = WeakMap<AgentMessage, string>;
/**
 * 单份快照最多携带的消息条数。
 *
 * 服务端保留完整历史，这里只约束**传输体积**。500 条足以覆盖长会话，
 * 又能把快照压在几百 KB 量级，而不是每个节流周期都随对话无限增长（每份都要重新序列化）。
 */
export const MAX_SNAPSHOT_MESSAGES = 500;

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") out += text;
    }
  }
  return out;
}

/** SDK 的 toolCall.arguments 正常是半对象；异常形状不进协议。 */
function asArgs(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 一条 assistant 消息里的思维链与工具调用。 */
function projectParts(content: unknown): { thinking?: string; calls?: UiToolCall[] } {
  if (!Array.isArray(content)) return {};
  let thinking = "";
  const calls: UiToolCall[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; thinking?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (p.type === "thinking" && typeof p.thinking === "string" && p.thinking) {
      thinking += (thinking ? "\n" : "") + p.thinking;
    } else if (p.type === "toolCall" && typeof p.id === "string") {
      const args = asArgs(p.arguments);
      calls.push({
        id: p.id,
        name: typeof p.name === "string" ? p.name : "tool",
        ...(args ? { args } : {}),
      });
    }
  }
  return { ...(thinking ? { thinking } : {}), ...(calls.length > 0 ? { calls } : {}) };
}

/** 已配对的工具结果（按 toolCallId）。 */
export type ToolResults = Map<string, { text: string; isError?: boolean; durationMs?: number }>;

/** Project an SDK AgentMessage to a UI message, or null when it is not a chat message. */
export function projectMessage(
  message: AgentMessage,
  cache: ProjectionCache,
  entryId: string | undefined,
  results: ToolResults,
  sigs: ProjectionSig,
): UiMessage | null {
  const role = (message as { role?: string }).role;
  if (role !== "user" && role !== "assistant") return null;
  const content = (message as { content?: unknown }).content;
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  const timestamp = (message as { timestamp?: number }).timestamp;
  const parts = projectParts(content);
  const text = extractText(content);
  // 签名含所有会影响投影内容的变量。工具结果是在另一条 toolResult 消息里到达的，
  // 它一到就会改变签名——此时**必须**产出新对象而不是原地改：SnapshotEmitter 的
  // “仅追加”快路径靠对象引用相等判定，引用不变就永远不会把新到结果发给客户端。
  const resolved = (parts.calls ?? []).filter((c) => results.has(c.id)).length;
  const callCount = parts.calls?.length ?? 0;
  const stop = typeof stopReason === "string" ? stopReason : "";
  // 用模板串而不是「数组 + join」：这个签名每个快照周期都要为每条消息重建一次，
  // 数组分配 + join 会先造出 n 个中间字符串，模板串只产出最终那一个（同样的结果）。
  const sig = `${text.length}|${parts.thinking?.length ?? 0}|${callCount}|${resolved}|${stop}|${entryId ?? ""}`;
  const hit = cache.get(message);
  if (hit && sigs.get(message) === sig) return hit;

  const calls = (parts.calls ?? []).map((c) => {
    const r = results.get(c.id);
    return r
      ? {
          ...c,
          ...(r.text ? { result: r.text } : {}),
          ...(r.isError ? { isError: true } : {}),
          ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
        }
      : c;
  });
  const ui: UiMessage = {
    role,
    text,
    ...(parts.thinking ? { thinking: parts.thinking } : {}),
    ...(calls.length > 0 ? { calls } : {}),
    ...(role === "assistant" && typeof stopReason === "string" ? { stopReason } : {}),
    timestamp,
    ...(entryId ? { entryId } : {}),
  };
  cache.set(message, ui);
  sigs.set(message, sig);
  return ui;
}

/** Derive a conversation title from the first user message. */
export function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New conversation";
  return clean.length > 40 ? `${clean.slice(0, 40)}...` : clean;
}

/**
 * Prompt digest for the log: collapse whitespace and keep at most 200 chars.
 * The red line forbids persisting full prompt bodies, so only a short summary is logged;
 * the exact length is carried in a separate field by the caller.
 */
export function summarizePrompt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > 200 ? `${flat.slice(0, 200)}...[+${flat.length - 200} chars]` : flat;
}

/**
 * Pull displayable text out of a tool's `partialResult`.
 *
 * The field is typed `any` by the SDK and its shape varies per tool (plain string, content
 * blocks, nested arrays), so this stays deliberately defensive: anything unrecognised yields
 * "" rather than "[object Object]" being streamed to the client.
 */
export function extractPartialText(partial: unknown): string {
  if (typeof partial === "string") return partial;
  if (Array.isArray(partial)) return partial.map(extractPartialText).join("");
  if (partial && typeof partial === "object") {
    const obj = partial as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.output === "string") return obj.output;
    if (obj.content !== undefined) return extractPartialText(obj.content);
    if (Array.isArray(obj.parts)) return extractPartialText(obj.parts);
  }
  return "";
}
