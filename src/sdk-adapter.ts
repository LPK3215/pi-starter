/**
 * pi-starter · SDK 私有形状适配层
 *
 * SDK 锁死在 `0.83.0`，但它有几个能力**没有从公开类型里导出**，只能靠鸭子类型访问：
 *
 *   session.sessionManager            —— 会话树（改名 / 回退 / 编辑 / 分叉要用）
 *   session.agent.state.messages      —— 树变更后要同步给模型的消息数组
 *   session.compact(instructions?)    —— 主动压缩
 *   session.abortCompaction()         —— 取消压缩
 *   session.cycleModel()              —— 沿 scopedModels 轮换
 *   session.cycleThinkingLevel()      —— 轮换思考档
 *   session.setSessionName(name)      —— 写会话名
 *
 * 这些访问原先散落在 `session-hub.ts` 各处，**每处各写一遍 `typeof === "function"` 兜底**，
 * 于是升级 SDK 时的表现是「有些点静默失效、有些点抛错」，而且没有任何一处能列出
 * 「我们到底依赖了哪些私有形状」。收敛到这里之后：
 *   - **一处升级、一处改**；
 *   - 每个访问器都做存在性检查，缺失时返回 `undefined`，由调用方显式降级（不静默崩）；
 *   - 这份清单本身就是文档。
 *
 * 语义与抽取前**逐字一致**（含原有的 `typeof` 检查与缺省返回值），只是位置变了。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

/** 只依赖「是个对象」——具体形状由各访问器自行断言。 */
export type SdkSession = object;

/**
 * 会话树管理器。
 *
 * 额外要求 `buildContextEntries` 可用：调用方（`entryIds`）靠它把消息映射回条目 id，
 * 拿不到就等于拿不到 entryId，宁可显式降级为「无会话树」。
 */
export function sdkSessionManager(session: SdkSession): SessionManager | undefined {
  const manager = (session as { sessionManager?: SessionManager }).sessionManager;
  if (!manager || typeof manager.buildContextEntries !== "function") return undefined;
  return manager;
}

/** 树变更后要改写的「模型看到的消息数组」所在的位置。 */
export function sdkAgentState(session: SdkSession): { messages: AgentMessage[] } | undefined {
  return (session as { agent?: { state?: { messages: AgentMessage[] } } }).agent?.state;
}

/** 主动压缩（官方 `session.compact(instructions?)`）。 */
export function sdkCompact(
  session: SdkSession,
): ((instructions?: string) => Promise<unknown>) | undefined {
  const fn = (session as { compact?: (instructions?: string) => Promise<unknown> }).compact;
  return typeof fn === "function" ? fn : undefined;
}

/** 取消正在进行的压缩（幂等）。 */
export function sdkAbortCompaction(session: SdkSession): (() => void) | undefined {
  const fn = (session as { abortCompaction?: () => void }).abortCompaction;
  return typeof fn === "function" ? fn : undefined;
}

/** 沿官方 `scopedModels` 轮换到下一个模型。 */
export function sdkCycleModel(
  session: SdkSession,
): (() => Promise<{ model?: Model<any> } | undefined>) | undefined {
  const fn = (session as { cycleModel?: () => Promise<{ model?: Model<any> } | undefined> }).cycleModel;
  return typeof fn === "function" ? fn : undefined;
}

/** 轮换思考档。 */
export function sdkCycleThinkingLevel(session: SdkSession): (() => string | undefined) | undefined {
  const fn = (session as { cycleThinkingLevel?: () => string | undefined }).cycleThinkingLevel;
  return typeof fn === "function" ? fn : undefined;
}

/**
 * 写会话名：优先官方 `setSessionName`，退回落 `sessionManager.appendSessionInfo`。
 *
 * 返回是否成功写入。两条路都没有时返回 false —— 调用方据此决定是否提示，
 * 但**不抛错**：改名失败不该让一次 UI 操作变成 5xx。
 */
export function sdkRenameSession(session: SdkSession, name: string): boolean {
  const setName = (session as { setSessionName?: (n: string) => void }).setSessionName;
  if (typeof setName === "function") {
    setName.call(session, name);
    return true;
  }
  const manager = (session as { sessionManager?: { appendSessionInfo?: (n: string) => void } })
    .sessionManager;
  if (manager && typeof manager.appendSessionInfo === "function") {
    manager.appendSessionInfo(name);
    return true;
  }
  return false;
}
