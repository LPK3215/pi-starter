/**
 * 会话树上的改名、回退、编辑、分叉。
 *
 * SDK 的会话是只追加的 JSONL 树。`branch()` 只改内存里的叶子；重新打开文件时，
 * 叶子会被指回文件里的最后一条。所以回退和编辑都必须再追加一条 custom 标记，
 * 让标记成为最后一条。普通 custom 不进模型上下文（`branch_summary` 会进，不能用）。
 *
 * `createBranchedSession` 会改掉调用它的那个 manager 的 sessionId 和文件。
 * 分叉必须先 `SessionManager.open` 出一个用完即丢的副本，不能拿正在对话的那个来调。
 */

import { existsSync } from "node:fs";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { AppError, badRequest } from "../errors.js";
import { assertSessionFileAllowed } from "./store.js";

/** 回退 / 编辑留下的标记。不进模型上下文。 */
export const TREE_MARKER_TYPE = "pi-starter.tree";

/** 展示标题上限。超过就拒绝，不静默截断。 */
export const MAX_TITLE_CHARS = 80;

export interface TreeMarker {
  action: "rollback" | "edit";
  entryId: string;
}

export interface EditResult {
  entryId: string;
  text: string;
  markerId: string;
}

export interface ForkResult {
  sessionFile: string;
  sessionId: string;
  messageCount: number;
}

/** 去掉首尾空白和换行。空标题拒绝。 */
export function normalizeConversationTitle(raw: string): string {
  if (typeof raw !== "string") throw badRequest("标题必须是字符串");
  const title = raw.replace(/[\r\n]+/g, " ").replace(/[ \t]+/g, " ").trim();
  if (!title) throw badRequest("标题不能为空");
  if (title.length > MAX_TITLE_CHARS) {
    throw badRequest(`标题不能超过 ${MAX_TITLE_CHARS} 个字符`);
  }
  return title;
}

/** 分叉后的展示名。源标题太长时先截断再加后缀，保证仍过得了标题上限。 */
export function forkedConversationTitle(source: string): string {
  const suffix = "（分叉）";
  const base = source.trim() && source !== "New conversation" ? source.trim() : "对话";
  const room = MAX_TITLE_CHARS - suffix.length;
  const head = base.length > room ? base.slice(0, room) : base;
  return `${head}${suffix}`;
}

function requireEntry(manager: SessionManager, entryId: string): SessionEntry {
  const id = entryId.trim();
  if (!id) throw badRequest("记录 id 不能为空");
  const entry = manager.getEntry(id);
  if (!entry) throw badRequest("没有这条记录");
  return entry;
}

function messageText(content: unknown): string {
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

/**
 * 把叶子挪到 `entryId`，再追加标记。被丢掉的后半段还在文件里，但不在当前路径上。
 * 目标记录自己留在路径上。
 */
export function rollbackSession(manager: SessionManager, entryId: string): { markerId: string } {
  const entry = requireEntry(manager, entryId);
  manager.branch(entry.id);
  const markerId = manager.appendCustomEntry(TREE_MARKER_TYPE, {
    action: "rollback",
    entryId: entry.id,
  } satisfies TreeMarker);
  return { markerId };
}

/**
 * 编辑一条用户消息：叶子回到它的父节点（第一条则回到空），再追加标记。
 * 这条消息和它后面的内容离开当前路径。原文交还调用方，不自动再发一轮。
 */
export function editUserMessage(manager: SessionManager, entryId: string): EditResult {
  const entry = requireEntry(manager, entryId);
  if (entry.type !== "message" || entry.message.role !== "user") {
    throw badRequest("只能编辑用户消息");
  }
  const text = messageText(entry.message.content);
  if (entry.parentId) manager.branch(entry.parentId);
  else manager.resetLeaf();
  const markerId = manager.appendCustomEntry(TREE_MARKER_TYPE, {
    action: "edit",
    entryId: entry.id,
  } satisfies TreeMarker);
  return { entryId: entry.id, text, markerId };
}

/**
 * 把从根到 `entryId`（缺省为当前叶子）的路径写成一个新文件。
 *
 * 打开的是一次性 manager。返回前源文件的 id 不会被这个函数改掉——
 * 它只读源文件，写的是另一个路径。没有助手回复时 SDK 不落盘，这里直接拒绝。
 */
export function forkSessionFile(
  sourceFile: string,
  entryId: string | undefined,
  allowedRoots: readonly string[],
): ForkResult {
  if (!existsSync(sourceFile)) {
    throw badRequest("这条对话还没落盘，等助手回复后再分叉");
  }
  assertSessionFileAllowed(sourceFile, allowedRoots);
  const scratch = SessionManager.open(sourceFile);
  const sourceId = scratch.getSessionId();
  const leaf = entryId?.trim() ? entryId.trim() : scratch.getLeafId();
  if (!leaf || !scratch.getEntry(leaf)) throw badRequest("没有可以分叉的记录");
  let newFile: string | undefined;
  try {
    newFile = scratch.createBranchedSession(leaf);
  } catch (err) {
    throw new AppError("internal", "无法分叉这条对话", { cause: err });
  }
  if (!newFile || !existsSync(newFile)) {
    throw badRequest("这条分支还没有助手回复，SDK 不会写出新的会话文件");
  }
  assertSessionFileAllowed(newFile, allowedRoots);
  const opened = SessionManager.open(newFile);
  const sessionId = opened.getSessionId();
  if (!sessionId || sessionId === sourceId) {
    throw new AppError("internal", "分叉后的会话标识没有变");
  }
  return {
    sessionFile: newFile,
    sessionId,
    messageCount: opened.buildSessionContext().messages.length,
  };
}
