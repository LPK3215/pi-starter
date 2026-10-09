/**
 * pi-starter · 会话编排层（AgentService → ClientSession → Conversation）
 *
 * 分层（借鉴 pi-web-ui，但按脚手架定位收窄）：
 *   SessionHub    每个客户端连接一个 ClientSession
 *   ClientSession 内含 N 个 Conversation，任一时刻一个 active
 *   Conversation  绑定一个 AgentSession 订阅，负责事件翻译 + 快照调度
 *
 * 相对 pi-web-ui 的改进：
 *   1. pi-web-ui 的 agent-service.ts 是 15398 行的单体；本方案把「事件翻译 / 快照调度 /
 *      会话编排」拆成三个可独立替换的类，Conversation 不直接持有 WebSocket，只认 push 回调。
 *   2. 多对话通过注入的 createSession 工厂实现；工厂缺席时**自动降级为单对话模式**
 *      （复用 agent.session），保证 CLI / 旧调用方零改动。
 *   3. 上下文占用不依赖 SDK 私有字段，直接用 context/budget 的估算，与裁剪器同源，
 *      UI 进度条与真实裁剪阈值永远一致。
 */

import { existsSync, rmSync } from "node:fs";
import { resolve as resolveAbsPath } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model, ImageContent } from "@earendil-works/pi-ai";
import type { BuiltAgent } from "./agent.js";
import type { RuntimeConfig } from "./config.js";
import { SnapshotEmitter } from "./snapshot.js";
import { computeSoftCap, contextUsageRatio, estimateTokens, planContextTrim, type TrimPlan } from "./context/budget.js";
import { getLogger, type Logger } from "./log.js";
import { AppError, badRequest } from "./http/errors.js";
import { assertSessionFileAllowed, type SessionCatalog, type StoredConversation } from "./sessions/store.js";
import {
  editUserMessage,
  forkSessionFile,
  forkedConversationTitle,
  normalizeConversationTitle,
  rollbackSession,
} from "./sessions/edit.js";
import type { PlanModeController } from "./modes/plan-mode.js";
import { ToolWatchdog } from "./approval/watchdog.js";
import { metrics } from "./metrics.js";
import type {
  ServerMessage,
  UiApproval,
  UiConversation,
  UiMessage,
  UiState,
  UiToolCall,
} from "./protocol.js";

type Session = BuiltAgent["session"];

/** 消息投影缓存：保证「仅追加」判定能靠对象引用等同性完成。 */
type ProjectionCache = WeakMap<AgentMessage, UiMessage | null>;
/** 投影内容签名：签名变 => 必须换新对象（见 projectMessage）。 */
type ProjectionSig = WeakMap<AgentMessage, string>;
/**
 * 单份快照最多携带的消息条数。
 *
 * 服务端保留完整历史，这里只约束**传输体积**。500 条足以覆盖长会话，
 * 又能把快照压在几百 KB 量级，而不是每个节流周期都随对话无限增长（每份都要重新序列化）。
 */
export const MAX_SNAPSHOT_MESSAGES = 500;

function extractText(content: unknown): string {
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
type ToolResults = Map<string, { text: string; isError?: boolean; durationMs?: number }>;

/** Project an SDK AgentMessage to a UI message, or null when it is not a chat message. */
function projectMessage(
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
  const sig = [
    text.length,
    parts.thinking?.length ?? 0,
    callCount,
    resolved,
    stop,
    entryId ?? "",
  ].join("|");
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
function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New conversation";
  return clean.length > 40 ? `${clean.slice(0, 40)}...` : clean;
}

/**
 * Prompt digest for the log: collapse whitespace and keep at most 200 chars.
 * The red line forbids persisting full prompt bodies, so only a short summary is logged;
 * the exact length is carried in a separate field by the caller.
 */
function summarizePrompt(text: string): string {
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
function extractPartialText(partial: unknown): string {
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

export interface ConversationOptions {
  clientId: string;
  session: Session;
  fallbackModel: Model<any>;
  cwd: string;
  cfg: RuntimeConfig;
  push: (msg: ServerMessage) => void;
  /** Provider for the cross-conversation list (owned by ClientSession). */
  listConversations: () => UiConversation[];
  /**
   * Invoked after every finished turn (`agent_end`). Lets the owning ClientSession refresh
   * its conversation list (title/order changed) without Conversation knowing about it.
   */
  onTurnEnd?: () => void;
  /**
   * Whether this conversation exclusively owns its session.
   * True when the session came from the `createSession` factory (must be disposed with the
   * conversation); false when it is the shared `agent.session` (must outlive the conversation).
   */
  ownsSession?: boolean;
  /**
   * Recent turns to keep when planning a context trim (settings.contextKeepRecent).
   * Read lazily so a settings change applies to the next prompt without a restart.
   */
  keepRecent?: () => number;
  /**
   * Per-tool timeout (ms). A hung tool otherwise blocks the conversation forever with no
   * signal. 0 / omitted disables the watchdog.
   */
  toolTimeoutMs?: number;
  /**
   * 计划模式状态控制器（可选）。
   *
   * 不传 = 这套装配没有计划模式，`planMode` 恒为 false，行为与接入前一致。
   */
  planMode?: PlanModeController;
}

/**
 * 主动压缩的结果。
 *
 * 失败也返回结构化结果而不是抛错：调用方是 UI 触发的一次用户操作，把它变成
 * 协议错误帧只会得到一个红色弹窗，而这里的信息（多少 tokens、为什么不能压）
 * 恰恰是用户需要的判断依据。
 */
export interface CompactionOutcome {
  ok: boolean;
  /** 失败原因（面向用户的中文，可直接展示）；成功时为空。 */
  reason?: string;
  tokensBefore?: number;
  tokensAfter?: number;
}

/**
 * 低于这个 token 数就不值得压。
 *
 * 压缩本身要调一次 LLM 做全文摘要，成本与延迟都不低；而几百 token 的上下文
 * 压完几乎还是那么多，纯属白花一次调用。低于门槛时如实告诉用户"现在压不划算"。
 */
export const MIN_COMPACTABLE_TOKENS = 2_000;

/** SDK 的压缩原因 → 面向用户的中文。给未知值留兜底，别让前端拿到裸英文枚举。 */
const COMPACTION_REASON: Record<string, string> = {
  manual: "手动触发",
  threshold: "达到上下文阈值",
  overflow: "上下文溢出",
};

export class Conversation {
  readonly id: string;
  readonly clientId: string;
  title = "New conversation";
  /**
   * 用户或索引已经给定标题。为真时不再从第一条用户消息推导，
   * 否则标题恰好是占位符 "New conversation" 时会被下一条消息盖掉。
   */
  private titleLocked = false;
  deltaSeq = 0;
  streamingText = "";
  /** 本轮已流出的思维链（与 streamingText 同生命周期，供快照的 streamingMessage 携带）。 */
  streamingThinking = "";
  lastActiveAt = Date.now();
  promptedSinceActive = false;
  pendingApproval: UiApproval | null = null;
  /**
   * 本连接内自增的迭代序号。
   *
   * SDK 投给会话订阅的 `turn_start` 只有 `type`（轮次下标在扩展层才有），
   * 所以序号由这里自己数，并且**明确**是「本连接内第几轮」，不冒充 SDK 的下标。
   */
  private turnIndex = 0;
  private readonly planMode: PlanModeController | undefined;
  /** Per-conversation structured logger (carries component + conversationId). */
  private readonly log!: Logger;
  /** High-res start of the current run, set on prompt dispatch; used for run durationMs. */
  private runStartedAt = 0;

  private push: (msg: ServerMessage) => void;
  private readonly unsubscribe: () => void;
  /**
   * UI 投影缓存。压缩会整体重写消息历史，所以它必须可替换——readonly 做不到，
   * 这不是为了方便改字段，而是「压缩后旧投影必须整体失效」本身就是正确性要求。
   */
  private cache: ProjectionCache = new WeakMap();
  /** 与 cache 配套：投影内容签名，变了才换对象。 */
  private projectionSig: ProjectionSig = new WeakMap();
  /** Per-message token counts, keyed by the stable projected UiMessage reference. */
  private tokenCache: WeakMap<UiMessage, number> = new WeakMap();
  private readonly toolStartTimes = new Map<string, number>();
  /**
   * 工具耗时（按 toolCallId），供历史投影用。
   *
   * 不能只靠 `tool_status` 帧：那是一次性的，刷新后就无从得知耗时。
   * 会话内上限防止长会话下无限增长；溢出时丢弃最早的一条。
   */
  private readonly toolDurations = new Map<string, number>();
  /** Called after a turn ends, so the owning ClientSession can refresh its conversation list. */
  private readonly onTurnEnd: (() => void) | undefined;
  private readonly watchdog: ToolWatchdog;
  private readonly session: Session;
  private readonly fallbackModel: Model<any>;
  private readonly cwd: string;
  private readonly ownsSession: boolean;
  private readonly listConversations: () => UiConversation[];
  private readonly keepRecent: () => number;
  readonly snap: SnapshotEmitter;

  constructor(opts: ConversationOptions) {
    this.clientId = opts.clientId;
    this.session = opts.session;
    this.fallbackModel = opts.fallbackModel;
    this.cwd = opts.cwd;
    this.push = opts.push;
    this.ownsSession = opts.ownsSession === true;
    this.listConversations = opts.listConversations;
    this.onTurnEnd = opts.onTurnEnd;
    this.keepRecent = opts.keepRecent ?? (() => 6);
    this.planMode = opts.planMode;
    this.id = opts.session.sessionId;
    const log = (this.log = getLogger().child({ component: "conversation", conversationId: this.id }));
    const timeout = opts.toolTimeoutMs ?? 0;
    // A hung tool blocks the turn with no signal; the watchdog aborts it after the timeout.
    this.watchdog =
      timeout > 0
        ? new ToolWatchdog({
            timeoutMs: timeout,
            abort: () => this.session.abort(),
            exempt: (toolName) => WATCHDOG_EXEMPT_TOOLS.has(toolName),
            onTimeout: (toolName, toolCallId, ms) => {
              log.warn("工具执行超时，已中止本轮", { toolName, toolCallId, timeoutMs: ms });
              this.push({
                type: "notice",
                level: "warn",
                text: `工具 ${toolName} 执行超过 ${Math.round(ms / 1000)}s，已中止本轮`,
              });
              this.snap.flushSnapshot();
            },
          })
        : new ToolWatchdog({ abort: () => undefined, exempt: () => true });
    this.snap = new SnapshotEmitter({
      convId: () => this.id,
      buildState: () => this.buildState(),
      emit: (msg) => this.push(msg),
      intervalMs: opts.cfg.snapshotIntervalMs,
      streamingIntervalMs: opts.cfg.streamingSnapshotIntervalMs,
    });
    this.unsubscribe = opts.session.subscribe((event) => this.onEvent(event));
  }

  /** Rebind the outbound sink (e.g. when a client reconnects on the same id). */
  setPush(push: (msg: ServerMessage) => void): void {
    this.push = push;
  }

  /* ─────────────── 事件翻译（B 类：SDK 事件 → 服务端消息） ─────────────── */

  private onEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_update": {
        const ae = event.assistantMessageEvent;
        if (ae?.type === "text_delta") {
          this.streamingText += ae.delta;
          this.emitDelta("text", ae.delta);
        } else if (ae?.type === "thinking_delta") {
          // 以前只转发增量、不累加：快照里的 streamingMessage 永远没有思维链，
          // 前端的“思考过程”在流式期间也无从渲染。
          this.streamingThinking += ae.delta;
          this.emitDelta("thinking", ae.delta);
        }
        break;
      }
      case "tool_execution_start": {
        this.toolStartTimes.set(event.toolCallId, Date.now());
        this.watchdog.arm(event.toolCallId, event.toolName);
        metrics.inc("toolCallsTotal");
        this.push({
          type: "tool_status",
          conversationId: this.id,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          phase: "start",
        });
        break;
      }
      case "tool_execution_end": {
        const startedAt = this.toolStartTimes.get(event.toolCallId);
        this.toolStartTimes.delete(event.toolCallId);
        if (startedAt !== undefined) {
          const elapsed = Date.now() - startedAt;
          // 有界：长会话下不能无限制累积。Map 保持插入序，满了丢最早的一条。
          if (this.toolDurations.size >= 500) {
            const oldest = this.toolDurations.keys().next().value;
            if (oldest !== undefined) this.toolDurations.delete(oldest);
          }
          this.toolDurations.set(event.toolCallId, elapsed);
        }
        // Always disarm, including on error: a leaked timer would later abort a healthy turn.
        this.watchdog.disarm(event.toolCallId);
        if (event.isError) metrics.inc("toolErrorsTotal");
        const toolDurationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
        this.log.info("tool executed", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError === true,
          ...(toolDurationMs !== undefined ? { durationMs: toolDurationMs } : {}),
        });
        this.push({
          type: "tool_status",
          conversationId: this.id,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          phase: "end",
          isError: event.isError,
          durationMs: toolDurationMs,
        });
        break;
      }
      case "tool_execution_update": {
        // Streaming partial output. Without this a long-running tool looks frozen until it
        // finishes, because tool_status only fires at start/end.
        const delta = extractPartialText(event.partialResult);
        if (delta) this.emitToolDelta(event.toolCallId, event.toolName, delta);
        break;
      }
      case "agent_start": {
        this.streamingText = "";
        this.streamingThinking = "";
        this.promptedSinceActive = true;
        this.push({ type: "run_start", conversationId: this.id });
        break;
      }
      case "agent_end": {
        // The authoritative end-of-turn signal. The SDK event carries only `messages` and
        // `willRetry`, so the stop reason has to be derived from the final assistant message.
        const last = event.messages[event.messages.length - 1];
        const stopReason =
          last?.role === "assistant" && typeof last.stopReason === "string"
            ? last.stopReason
            : undefined;
        this.streamingText = "";
        this.streamingThinking = "";
        this.push({
          type: "run_end",
          conversationId: this.id,
          stopReason,
          willRetry: event.willRetry || undefined,
          aborted: stopReason === "aborted" || undefined,
        });
        // A finished turn changes the conversation list (title, ordering), so refresh it.
        this.logRunSummary(stopReason, event.willRetry === true);
        this.onTurnEnd?.();
        break;
      }
      case "turn_start": {
        // One ReAct iteration inside a single prompt(). `run_start` only fires once per
        // prompt, so a multi-step turn (model → tool → model) is otherwise invisible.
        this.push({ type: "turn_start", conversationId: this.id, turnIndex: ++this.turnIndex });
        break;
      }
      case "turn_end": {
        const message = (event as { message?: AgentMessage }).message;
        const stopReason =
          message && typeof (message as { stopReason?: unknown }).stopReason === "string"
            ? (message as { stopReason: string }).stopReason
            : undefined;
        const toolResults = (event as { toolResults?: unknown[] }).toolResults;
        this.push({
          type: "turn_end",
          conversationId: this.id,
          turnIndex: this.turnIndex,
          ...(stopReason ? { stopReason } : {}),
          ...(Array.isArray(toolResults) ? { toolResults: toolResults.length } : {}),
        });
        break;
      }
      case "message_end": {
        this.streamingText = "";
        this.streamingThinking = "";
        this.refreshTitleFromSession();
        break;
      }
      case "queue_update": {
        // Steering / follow-up 队列变了。快照里的 `queue` 是权威来源，但默认只在边界才刷；
        // 队列随时可能变（用户 steer/followUp 排队），这里立即出一份快照，不必等下一个增量。
        this.getState();
        break;
      }
      case "entry_appended": {
        // A new entry landed in the session transcript: it may carry a better title.
        this.refreshTitleFromSession();
        break;
      }
      case "compaction_start": {
        this.push({
          type: "notice",
          level: "info",
          text: `上下文压缩开始（${COMPACTION_REASON[event.reason] ?? event.reason}）`,
        });
        break;
      }
      case "compaction_end": {
        this.push({
          type: "notice",
          level: event.aborted ? "warn" : "info",
          text: event.aborted ? "上下文压缩被中止" : "上下文压缩完成",
        });
        break;
      }
      case "auto_retry_start": {
        this.push({
          type: "notice",
          level: "warn",
          text: `Retrying (${event.attempt}/${event.maxAttempts}) in ${event.delayMs}ms`,
        });
        break;
      }
      case "auto_retry_end": {
        // 官方事件：重试结算。之前被 default 吞掉，前端只看到「Retrying」看不到「恢复了/最终失败」。
        this.push({
          type: "notice",
          level: event.success ? "info" : "error",
          text: event.success
            ? `重试成功（第 ${event.attempt} 次恢复）`
            : `重试失败（第 ${event.attempt} 次）${event.finalError ? `：${event.finalError}` : ""}`,
        });
        break;
      }
      default:
        break;
    }

    this.lastActiveAt = Date.now();

    // Snapshot checkpoint policy: boundaries flush immediately, everything else throttles.
    if (
      event.type === "agent_end" ||
      event.type === "turn_end" ||
      event.type === "tool_execution_end" ||
      event.type === "message_end" ||
      event.type === "compaction_end" ||
      event.type === "auto_retry_end"
    ) {
      this.snap.flushSnapshot();
    } else {
      this.snap.scheduleSnapshot();
    }
  }

  private emitDelta(channel: "text" | "thinking", delta: string): void {
    this.push({
      type: "message_delta",
      conversationId: this.id,
      seq: ++this.deltaSeq,
      channel,
      delta,
    });
    this.snap.noteDelta();
  }

  /** 工具流式增量。与 message_delta 共用 seq 空间，便于客户端按序排空两类增量。 */
  private emitToolDelta(toolCallId: string, toolName: string, delta: string): void {
    this.push({
      type: "tool_delta",
      conversationId: this.id,
      seq: ++this.deltaSeq,
      toolCallId,
      toolName,
      delta,
    });
    // Note the delta so the snapshot scheduler knows output is still moving.
    this.snap.noteDelta();
  }

  private refreshTitleFromSession(): void {
    if (this.titleLocked || this.title !== "New conversation") return;
    for (const message of this.session.messages) {
      const role = (message as { role?: string }).role;
      if (role !== "user") continue;
      const text = extractText((message as { content?: unknown }).content);
      if (text.trim()) {
        this.title = deriveTitle(text);
        return;
      }
    }
  }

  /**
   * Plan a context trim against the current soft cap.
   *
   * Exposed (and surfaced in the snapshot) rather than applied automatically: dropping messages
   * out from under a live turn is destructive, and the SDK already owns the authoritative
   * summarization path (`compact()` / auto-compaction). Callers use this to decide *whether* to
   * compact, and to show the user how much is at stake — the plan itself is a pure function.
   */
  planTrim(): TrimPlan {
    const model = this.session.model ?? this.fallbackModel;
    const softCap = computeSoftCap(model.contextWindow ?? 0);
    const messages = this.currentMessages();
    return planContextTrim({
      messages,
      maxTokens: softCap,
      keepRecent: this.keepRecent(),
    });
  }

  /* ─────────────── 快照构建（C 类） ─────────────── */

  /** 当前路径上，消息对象 → 会话条目 id。没有会话树时为空。 */
  private entryIds(): Map<AgentMessage, string> {
    const map = new Map<AgentMessage, string>();
    const manager = this.sessionManager();
    if (!manager) return map;
    for (const entry of manager.buildContextEntries()) {
      if (entry.type === "message") map.set(entry.message, entry.id);
    }
    return map;
  }

  private sessionManager(): SessionManager | undefined {
    const manager = (this.session as { sessionManager?: SessionManager }).sessionManager;
    if (!manager || typeof manager.buildContextEntries !== "function") return undefined;
    return manager;
  }

  private requireManager(): SessionManager {
    const manager = this.sessionManager();
    if (!manager) throw badRequest("当前会话不能编辑历史");
    return manager;
  }

  /** 树变了之后，让模型看到的消息和快照跟着走。只 branch() 而不换这份数组，界面还是旧的后半段。 */
  private adoptTree(manager: SessionManager): void {
    const state = (this.session as { agent?: { state?: { messages: AgentMessage[] } } }).agent?.state;
    if (!state) throw new AppError("internal", "当前会话不能同步消息");
    state.messages = manager.buildSessionContext().messages;
    this.cache = new WeakMap();
    this.projectionSig = new WeakMap();
    this.tokenCache = new WeakMap();
    this.streamingText = "";
    this.streamingThinking = "";
    this.getState();
  }

  /** Projected chat messages, using the stable-reference projection cache. */
  private currentMessages(): UiMessage[] {
    const ids = this.entryIds();
    // 第一遍：收齐工具结果。SDK 把结果放在独立的 toolResult 消息里，
    // 而它需要被归回发起调用的那条 assistant 消息，否则历史里只有“调了什么”没有“结果”。
    const results: ToolResults = new Map();
    for (const message of this.session.messages) {
      const tr = message as unknown as {
        role?: string;
        toolCallId?: string;
        content?: unknown;
        isError?: boolean;
      };
      if (tr.role !== "toolResult" || !tr.toolCallId) continue;
      const durationMs = this.toolDurations.get(tr.toolCallId);
      results.set(tr.toolCallId, {
        text: extractText(tr.content),
        ...(tr.isError === true ? { isError: true } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
    const messages: UiMessage[] = [];
    for (const message of this.session.messages) {
      const ui = projectMessage(message, this.cache, ids.get(message), results, this.projectionSig);
      if (ui) messages.push(ui);
    }
    return messages;
  }

  /**
   * Messages exposed to the client, capped so a long conversation cannot produce a
   * multi-megabyte snapshot on every tick.
   *
   * Only the **tail** is dropped: the newest turns are what the UI is rendering. The
   * authoritative full history stays on the server (`session.messages`) and is still what
   * gets sent to the model — this cap affects the wire payload only.
   *
   * Note this keeps the append-only fast path intact: the retained prefix is still a stable
   * prefix of the same array, so SnapshotEmitter's pointer-equality check still succeeds.
   */
  private boundedMessages(all: readonly UiMessage[]): UiMessage[] {
    if (all.length <= MAX_SNAPSHOT_MESSAGES) return all as UiMessage[];
    return all.slice(all.length - MAX_SNAPSHOT_MESSAGES);
  }

  private buildState(): UiState {
    const session = this.session;
    const allMessages = this.currentMessages();
    const totalMessageCount = allMessages.length;
    const messages = this.boundedMessages(allMessages);
    const model = session.model ?? this.fallbackModel;
    const stats = session.getSessionStats();
    const contextTokens = this.estimateTokensCached(messages);
    const softCap = computeSoftCap(model.contextWindow ?? 0);

    return {
      clientId: this.clientId,
      cwd: this.cwd,
      sessionId: session.sessionId,
      conversationId: this.id,
      rev: 0,
      messages,
      messagesTruncated: messages.length < totalMessageCount,
      totalMessages: totalMessageCount,
      streamingMessage:
        session.isStreaming && (this.streamingText || this.streamingThinking)
          ? {
              role: "assistant",
              text: this.streamingText,
              ...(this.streamingThinking ? { thinking: this.streamingThinking } : {}),
            }
          : null,
      isStreaming: session.isStreaming,
      model: { provider: model.provider, id: model.id, name: model.name ?? model.id },
      thinkingLevel: String(session.thinkingLevel ?? ""),
      tools: session.getActiveToolNames(),
      queue: {
        steering: [...session.getSteeringMessages()],
        followUp: [...session.getFollowUpMessages()],
      },
      stats: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        total: stats.tokens.total,
        cost: stats.cost,
        softCap,
        contextTokens,
        context: {
          tokens: contextTokens,
          softCap,
          usage: contextUsageRatio(contextTokens, softCap),
          // `planContextTrim` uses the exact same estimator, so "over budget" here means the
          // trim planner would also propose dropping messages — no second source of truth.
          overBudget: this.planTrim().trimmed,
        },
      },
      pendingApproval: this.pendingApproval,
      planMode: this.isPlanMode(),
      conversations: this.listConversations(),
      labels: this.labels(),
    };
  }

  /**
   * Sum token estimates, reusing per-message counts.
   * UiMessage references are stable (projection cache), so an unchanged conversation costs
   * O(new messages) instead of O(total characters) on every snapshot tick.
   */
  private estimateTokensCached(messages: readonly UiMessage[]): number {
    let total = 0;
    for (const message of messages) {
      let tokens = this.tokenCache.get(message);
      if (tokens === undefined) {
        tokens = estimateTokens(message.text) + 4; // +4 message envelope overhead
        this.tokenCache.set(message, tokens);
      }
      total += tokens;
    }
    return total;
  }

  /* ─────────────── 运行控制 ─────────────── */

  /**
   * The underlying SDK session.
   *
   * Exposed deliberately (rather than kept fully private) because embedders legitimately
   * need it — to register extra extension hooks, read `session.systemPrompt`, or drive
   * `sendCustomMessage`. Tests use it to inject SDK events. It is the same object the
   * conversation itself uses, so mutating it affects the live conversation.
   */
  get sdkSession(): Session {
    return this.session;
  }

  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    if (this.title === "New conversation" && text.trim()) this.title = deriveTitle(text);
    this.lastActiveAt = Date.now();
    // AI 运行观测：只记提示词摘要与长度（红线：完整正文不落盘），并起时戳供 run 耗时。
    this.runStartedAt = performance.now();
    const runModel = this.session.model ?? this.fallbackModel;
    this.log.info("model run started", {
      model: `${runModel.provider}/${runModel.id}`,
      promptLength: text.length,
      promptSummary: summarizePrompt(text),
      imageCount: images?.length ?? 0,
    });
    // preflightResult 在 prompt() resolve 之前回调一次：false = 被预检拒绝（未开始一轮）。
    // SDK 此时不抛错、只静默返回，所以这里把它翻成明确的类型化错误，让 WS/REST 给出反馈
    // 而不是让调用方以为已经发了。
    let accepted = true;
    await this.session.prompt(text, {
      ...(images ? { images } : {}),
      preflightResult: (ok) => {
        accepted = ok;
      },
    });
    if (!accepted) {
      throw new AppError("conflict", "消息被拒绝，未开始处理", { expose: true });
    }
  }

  /**
   * Run summary for AI observability: model, tokens, cost, context usage and whether the
   * context is over the trim budget. All values are read from the same session/estimator the
   * snapshot uses, so the log cannot drift from what the client sees. Bypass-only logging.
   */
  private logRunSummary(stopReason: string | undefined, willRetry: boolean): void {
    const model = this.session.model ?? this.fallbackModel;
    const stats = this.session.getSessionStats();
    const messages = this.boundedMessages(this.currentMessages());
    const softCap = computeSoftCap(model.contextWindow ?? 0);
    const contextTokens = this.estimateTokensCached(messages);
    const usage = contextUsageRatio(contextTokens, softCap);
    const durationMs = this.runStartedAt ? Math.round((performance.now() - this.runStartedAt) * 1000) / 1000 : undefined;
    this.log.info("model run finished", {
      model: `${model.provider}/${model.id}`,
      stopReason,
      willRetry,
      turnIndex: this.turnIndex,
      ...(durationMs !== undefined ? { durationMs } : {}),
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      totalTokens: stats.tokens.total,
      cost: stats.cost,
      contextTokens,
      contextUsage: usage,
      contextTruncated: usage >= 1,
    });
    this.runStartedAt = 0;
  }

  /**
   * 运行中插入一条消息（steering）。
   *
   * 与 `prompt` 的区别是**语义**：`prompt` 会另起一轮，`steer` 是在当前轮的工具调用之间
   * 插话，让模型在下一步就带上这条信息（"别改那个文件了"）。SDK 在非流式时会拒绝，
   * 所以这里先给出明确理由，而不是让 SDK 抛一个泛化错误。
   */
  async steer(text: string, images?: ImageContent[]): Promise<void> {
    if (!this.session.isStreaming) {
      throw new AppError("conflict", "当前没有正在进行的生成，请直接用 prompt 发送", { expose: true });
    }
    this.lastActiveAt = Date.now();
    await this.session.steer(text, images);
    this.getState();
  }

  /**
   * 排队一条消息，等本轮彻底结束后再处理（follow-up）。
   *
   * 与 `steer` 的区别：steer 会打断当前轮的后续工具调用，follow-up 只在模型不再有工具
   * 调用时投递。SDK 在非流式时同样拒绝，理由同上。
   */
  async followUp(text: string, images?: ImageContent[]): Promise<void> {
    if (!this.session.isStreaming) {
      throw new AppError("conflict", "当前没有正在进行的生成，请直接用 prompt 发送", { expose: true });
    }
    this.lastActiveAt = Date.now();
    await this.session.followUp(text, images);
    this.getState();
  }

  /**
   * 取消正在进行的压缩。
   *
   * 无压缩在跑时是**幂等空操作**：SDK 的 `abortCompaction()` 本身就是幂等的，重复调用
   * 不会报错。这里不额外抛错——「已经停了」和「刚停掉」对调用方是同一个结果。
   */
  abortCompaction(): void {
    const abortFn = (this.session as { abortCompaction?: () => void }).abortCompaction;
    if (typeof abortFn !== "function") return;
    abortFn.call(this.session);
    this.getState();
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  async setModel(model: Model<any>): Promise<void> {
    await this.session.setModel(model);
    this.getState();
  }

  setThinking(level: string): void {
    // The SDK narrows ThinkingLevel; callers pass validated strings.
    this.session.setThinkingLevel(level as Parameters<Session["setThinkingLevel"]>[0]);
    this.getState();
  }

  /**
   * 沿官方 `scopedModels` 轮换到下一个模型（官方 `session.cycleModel`）。
   * 装配无轮换列表 / SDK 不提供该方法时返回 undefined。
   */
  async cycleModel(): Promise<Model<any> | undefined> {
    const fn = (this.session as { cycleModel?: () => Promise<{ model?: Model<any> } | undefined> })
      .cycleModel;
    if (typeof fn !== "function") return undefined;
    const result = await fn.call(this.session);
    this.getState();
    return result?.model;
  }

  /** 轮换思考档（官方 `session.cycleThinkingLevel`）。 */
  cycleThinking(): string | undefined {
    const fn = (this.session as { cycleThinkingLevel?: () => string | undefined }).cycleThinkingLevel;
    if (typeof fn !== "function") return undefined;
    const level = fn.call(this.session);
    this.getState();
    return level;
  }

  /**
   * Apply the enabled tool set to the live session (ActiveSet).
   * The SDK filters unknown names and rebuilds the system prompt, so this is safe to call
   * with the registry's full enabled list.
   */
  applyToolSet(toolNames: readonly string[]): void {
    this.session.setActiveToolsByName([...toolNames]);
    this.getState();
  }

  getState(): void {
    this.snap.flushSnapshot(true);
  }

  /**
   * 当前路径上被官方打了标签的条目（官方 `SessionManager.getLabel`）。
   * 没有会话树（无 manager）时返回空。只遍历当前路径的条目，不背整个文件。
   */
  labels(): { entryId: string; label: string }[] {
    const manager = this.sessionManager();
    if (!manager) return [];
    const out: { entryId: string; label: string }[] = [];
    for (const entry of manager.buildContextEntries()) {
      const label = manager.getLabel(entry.id);
      if (label) out.push({ entryId: entry.id, label });
    }
    return out;
  }

  /**
   * 给一条会话条目打（或清）官方标签（`SessionManager.appendLabelChange`）。
   * 标签与回退的 custom 标记是两回事：标签不会把叶子挑回去，也不影响模型看到的上下文。
   */
  setLabel(entryId: string, label: string | undefined): void {
    const manager = this.requireManager();
    const trimmed = label?.trim();
    manager.appendLabelChange(entryId.trim(), trimmed ? trimmed : undefined);
    this.getState();
  }

  /* ─────────────── 主动压缩 ─────────────── */

  /**
   * 主动压缩本对话的上下文。
   *
   * 之前内核只有 SDK 自动触发时的被动 notice——客户端看得见「压缩发生了」，却没有任何
   * 办法自己发起。上下文快满时只能等模型自己决定，而「该保留什么」只有用户知道
   * （例如"保留所有文件路径与最终结论"）。
   *
   * 三条前置条件都给出**明确**理由而不是静默无效或硬崩：
   *   - 正在流式 → 压缩要重写消息历史，与正在追加的消息冲突；
   *   - 上下文太小 → 压了也省不下什么，白白花一次 LLM 调用；
   *   - SDK 不支持 → 装配里没有这个能力。
   */
  async compact(instructions?: string): Promise<CompactionOutcome> {
    const session = this.session;
    if (session.isStreaming) {
      return { ok: false, reason: "正在生成中，请等本轮结束后再压缩" };
    }
    const before = this.estimateTokensCached(this.boundedMessages(this.currentMessages()));
    if (before <= MIN_COMPACTABLE_TOKENS) {
      return {
        ok: false,
        reason: `上下文还很小（约 ${before} tokens），压缩收益不大`,
        tokensBefore: before,
      };
    }
    const compactFn = (session as { compact?: (i?: string) => Promise<unknown> }).compact;
    if (typeof compactFn !== "function") {
      return { ok: false, reason: "当前 SDK 不支持主动压缩", tokensBefore: before };
    }

    this.push({ type: "notice", level: "info", text: "开始压缩上下文…" });
    try {
      await compactFn.call(session, instructions?.trim() || undefined);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.push({ type: "notice", level: "error", text: `压缩失败：${reason}` });
      return { ok: false, reason, tokensBefore: before };
    }
    // 历史被重写过，投影缓存与 token 缓存都必须作废。
    //
    // 这不是杞人忧天：如果 SDK **原地改写**已有消息对象（而不是换新对象），WeakMap 的键
    // 引用没变，就会命中压缩前的投影与 token 数——快照会继续显示被压掉的旧内容。
    // 换新对象时 WeakMap 自然 miss，作废看似多余；但两种实现都存在，所以显式作废。
    this.cache = new WeakMap();
    this.projectionSig = new WeakMap();
    this.tokenCache = new WeakMap();
    this.streamingText = "";
    this.streamingThinking = "";
    const after = this.estimateTokensCached(this.boundedMessages(this.currentMessages()));
    this.getState();
    this.push({
      type: "notice",
      level: "info",
      text: `压缩完成：约 ${before} → ${after} tokens`,
    });
    return { ok: true, tokensBefore: before, tokensAfter: after };
  }

  /* ─────────────── 计划模式 ─────────────── */

  /**
   * 本对话当前是否处于计划模式。
   *
   * 未装配控制器时恒为 false：没有控制器的装配里根本没有这个能力，
   * 让它读设置默认值只会造出一个「看起来开着、实际没人拦」的假状态。
   */
  isPlanMode(): boolean {
    return this.planMode?.isEnabled(this.id) ?? false;
  }

  /** 开关本对话的计划模式。返回设置后的值；没装配控制器时返回 false 且不改任何状态。 */
  setPlanMode(enabled: boolean): boolean {
    if (!this.planMode) return false;
    const next = this.planMode.set(this.id, enabled);
    // 状态变了立刻出一份新快照：否则客户端要等到下一个增量才知道模式变了。
    this.getState();
    return next;
  }

  /** Surface a pending approval request and push it immediately. */
  requestApproval(request: UiApproval): void {
    this.pendingApproval = request;
    this.push({ type: "approval_request", request });
    this.getState();
  }

  /** Clear the pending approval (after a human decision). */
  clearApproval(): void {
    this.pendingApproval = null;
    this.getState();
  }

  toSummary(active: boolean): UiConversation {
    return {
      id: this.id,
      title: this.title,
      active,
      streaming: this.session.isStreaming,
      messageCount: this.session.messages.length,
      updatedAt: this.lastActiveAt,
    };
  }

  /**
   * 用索引里的标题盖过占位符；索引没有时再从会话消息里取。
   * 已经有真实标题时不再被「New conversation」逻辑改掉。
   */
  adoptSavedTitle(saved: string | undefined): void {
    if (saved && saved !== "New conversation") {
      this.title = saved;
      this.titleLocked = true;
    }
    this.refreshTitleFromSession();
  }

  /** 正在生成时不能改树，也不能改名。 */
  streaming(): boolean {
    return this.session.isStreaming;
  }

  /**
   * 改展示名。已打开的对话写进 SDK 的 session_info；调用方负责休眠对话只改索引。
   * 不调模型。
   */
  rename(title: string): string {
    if (this.session.isStreaming) {
      throw new AppError("conflict", "对话正在生成，先停掉再改名");
    }
    const next = normalizeConversationTitle(title);
    const session = this.session as Session & {
      setSessionName?: (name: string) => void;
      sessionManager?: SessionManager;
    };
    if (typeof session.setSessionName === "function") session.setSessionName(next);
    else session.sessionManager?.appendSessionInfo(next);
    this.title = next;
    this.titleLocked = true;
    this.lastActiveAt = Date.now();
    this.getState();
    return next;
  }

  /**
   * 叶子留在这条记录上，后半段离开当前路径。标记写入文件，重启后还在。
   *
   * `summarize` 为真且 SDK 提供了 `navigateTree` 时，走**官方树导航**：把叶子挪到
   * 目标记录并对被丢掉的后半段生成分支摘要（`customInstructions` 说"该保留什么"）。
   * `navigateTree` 不可用（替身 / 老版本）时回落到原先的 `branch()` + custom 标记路径，
   * 行为与接入前一致。两条路之后都要 `adoptTree` 让模型消息与投影缓存跟着走。
   */
  async rollbackTo(
    entryId: string,
    opts?: { summarize?: boolean; instructions?: string },
  ): Promise<void> {
    if (this.session.isStreaming) {
      throw new AppError("conflict", "对话正在生成，先停掉再回退");
    }
    const navigate = (
      this.session as {
        navigateTree?: (
          id: string,
          options?: { summarize?: boolean; customInstructions?: string; label?: string },
        ) => Promise<unknown>;
      }
    ).navigateTree;
    if (opts?.summarize && typeof navigate === "function") {
      await navigate.call(this.session, entryId.trim(), {
        summarize: true,
        ...(opts.instructions ? { customInstructions: opts.instructions } : {}),
      });
      const manager = this.sessionManager();
      if (manager) this.adoptTree(manager);
      else this.getState();
      return;
    }
    const manager = this.requireManager();
    rollbackSession(manager, entryId);
    this.adoptTree(manager);
  }

  /**
   * 把一条用户消息移出当前路径，原文交回。不自动 prompt。
   * 助手消息不能走这里——那是回退，叶子要留在那条记录上。
   */
  editMessage(entryId: string): { entryId: string; text: string } {
    if (this.session.isStreaming) {
      throw new AppError("conflict", "对话正在生成，先停掉再编辑");
    }
    const manager = this.requireManager();
    const edited = editUserMessage(manager, entryId);
    this.adoptTree(manager);
    this.push({
      type: "edit_ready",
      conversationId: this.id,
      entryId: edited.entryId,
      text: edited.text,
    });
    return { entryId: edited.entryId, text: edited.text };
  }

  /**
   * 写进索引的条目。文件还没落盘（SDK 要等第一条 assistant 消息）时返回 undefined，
   * 调用方安静跳过，不要把一条还不存在的路径写进索引。
   */
  toStored(): StoredConversation | undefined {
    const sessionFile = this.session.sessionFile;
    if (!sessionFile || !existsSync(sessionFile)) return undefined;
    return {
      sessionId: this.id,
      sessionFile,
      title: this.title,
      updatedAt: this.lastActiveAt,
      messageCount: this.session.messages.length,
    };
  }

  dispose(): void {
    // Order matters: stop the watchdog first so it cannot abort a session mid-teardown.
    this.watchdog.dispose();
    this.snap.dispose();
    this.unsubscribe();
    // Only dispose sessions this conversation created; the shared agent.session must survive.
    if (this.ownsSession) {
      try {
        this.session.dispose();
      } catch {
        /* already disposed */
      }
    }
  }
}

/* ────────────────────────── ClientSession ────────────────────────── */

export interface ClientSessionOptions {
  clientId: string;
  agent: BuiltAgent;
  cfg: RuntimeConfig;
  cwd: string;
  push: (msg: ServerMessage) => void;
  /**
   * Recent turns to preserve when planning a context trim.
   * Read lazily from settings so `contextKeepRecent` applies without a restart.
   */
  keepRecent?: () => number;
  /**
   * Max simultaneously open conversations per client.
   * Each conversation owns a full AgentSession (loader + tools + subscriptions), so an
   * unbounded count is a memory and CPU leak. LRU-closes the least recently active one
   * instead of refusing the new request — refusing would break the client's flow.
   */
  maxOpenConversations?: number;
  /**
   * 允许打开的会话文件目录（恢复历史对话用）。默认空 = 禁止恢复。
   * Web 传入本脚手架自己的会话目录，不是 CLI 的那一个。
   */
  allowedSessionRoots?: readonly string[];
  /** 本工作区已落盘、但当前连接还没打开的对话。不传就没有历史列表。 */
  persistedConversations?: () => readonly StoredConversation[];
  /** 一轮结束或关闭前把这条对话写回索引。文件还不存在时由 `toStored()` 跳过。 */
  rememberConversation?: (conv: Conversation) => void;
  /**
   * Per-tool timeout (ms) for each conversation's watchdog, read lazily so a settings change
   * applies to newly created conversations. 0 (or omitted) disables the watchdog.
   */
  toolTimeoutMs?: () => number;
  /** 计划模式状态控制器（可选）；不传则该装配没有计划模式。 */
  planMode?: PlanModeController;
}

/** Default cap on simultaneously open conversations per client (matches pi-web-ui). */
export const DEFAULT_MAX_OPEN_CONVERSATIONS = 8;

/**
 * Tools that legitimately outlive any timeout because they wait on a human.
 * Killing these would break the interaction rather than protect it.
 */
const WATCHDOG_EXEMPT_TOOLS = new Set(["ask_user_question", "ask_user", "request_user_input"]);

export class ClientSession {
  readonly clientId: string;
  private readonly convs = new Map<string, Conversation>();
  private activeId = "";
  private readonly agent: BuiltAgent;
  private readonly cfg: RuntimeConfig;
  private readonly cwd: string;
  private readonly push: (msg: ServerMessage) => void;
  private readonly keepRecent: () => number;
  private readonly toolTimeoutMs: () => number;
  private readonly maxOpenConversations: number;
  /**
   * 允许打开的会话文件目录。空数组 = **禁止恢复**（fail-closed）。
   *
   * 必须显式注入。客户端只提交会话 id，路径从索引里查；这里再挡一层，
   * 避免工厂被直接塞进一个目录外的文件。
   */
  private readonly allowedSessionRoots: readonly string[];
  private readonly persistedConversations: () => readonly StoredConversation[];
  private readonly rememberConversation: ((conv: Conversation) => void) | undefined;
  private readonly planMode: PlanModeController | undefined;

  constructor(options: ClientSessionOptions) {
    this.clientId = options.clientId;
    this.agent = options.agent;
    this.cfg = options.cfg;
    this.cwd = options.cwd;
    this.push = options.push;
    this.keepRecent = options.keepRecent ?? (() => 6);
    this.toolTimeoutMs = options.toolTimeoutMs ?? (() => 0);
    const cap = options.maxOpenConversations ?? DEFAULT_MAX_OPEN_CONVERSATIONS;
    this.maxOpenConversations = Number.isInteger(cap) && cap >= 1 ? cap : DEFAULT_MAX_OPEN_CONVERSATIONS;
    this.allowedSessionRoots = options.allowedSessionRoots ?? [];
    this.persistedConversations = options.persistedConversations ?? (() => []);
    this.rememberConversation = options.rememberConversation;
    this.planMode = options.planMode;
  }

  /** Rebind the outbound sink for every conversation (client reconnect). */
  setPush(push: (msg: ServerMessage) => void): void {
    this.pushRef = push;
    for (const conv of this.convs.values()) conv.setPush(push);
  }

  private pushRef: ((msg: ServerMessage) => void) | undefined;

  private emit(msg: ServerMessage): void {
    (this.pushRef ?? this.push)(msg);
  }

  /** Create (or reuse in single-conversation mode) the initial conversation. */
  async attach(): Promise<Conversation> {
    if (this.convs.size === 0) return this.newConversation();
    const existing = this.convs.get(this.activeId);
    if (existing) return existing;
    return this.newConversation();
  }

  /**
   * Create a new conversation. Uses the injected session factory when available;
   * otherwise degrades to the single shared session (CLI / library callers).
   */
  async newConversation(opts?: { resumeFrom?: string }): Promise<Conversation> {
    // 路径来自索引，不来自客户端。这里先挡目录，`resolveSessionManager` 打开前再挡一次。
    // 没有独立会话工厂时不能假装恢复成功——那会静默退回共享 session。
    if (opts?.resumeFrom) {
      assertSessionFileAllowed(opts.resumeFrom, this.allowedSessionRoots);
      if (!this.agent.createSession) {
        throw badRequest("当前代理没有独立会话工厂，无法恢复历史对话");
      }
      const known = this.persistedConversations().some((entry) => entry.sessionFile === opts.resumeFrom);
      if (!known) throw new AppError("forbidden", "只能打开索引中的会话");
    }
    return this.addConversation(opts?.resumeFrom);
  }

  private async addConversation(resumeFrom?: string): Promise<Conversation> {
    const factory = this.agent.createSession;

    // Without a session factory every conversation would share one session (and thus one
    // sessionId). Reusing the existing wrapper avoids stacking a second subscription on the
    // same session, which would leak the old listener and duplicate every delta/snapshot.
    if (!factory && this.convs.size > 0) {
      const existing = this.convs.get(this.activeId) ?? [...this.convs.values()][0];
      if (existing) {
        this.activeId = existing.id;
        this.emitConversations();
        existing.getState();
        return existing;
      }
    }

    // Enforce the cap BEFORE allocating: each conversation owns a full AgentSession, so
    // allocating first and trimming after would briefly exceed the budget we are protecting.
    this.evictForCapacity();

    const session = factory
      ? await factory(resumeFrom ? { resumeFrom } : undefined)
      : this.agent.session;
    let conv!: Conversation;
    conv = new Conversation({
      clientId: this.clientId,
      session,
      fallbackModel: this.agent.model,
      cwd: this.cwd,
      cfg: this.cfg,
      push: (msg) => this.emit(msg),
      listConversations: () => this.listConversations(),
      onTurnEnd: () => {
        this.rememberConversation?.(conv);
        this.emitConversations();
      },
      keepRecent: this.keepRecent,
      toolTimeoutMs: this.toolTimeoutMs(),
      planMode: this.planMode,
      ownsSession: Boolean(factory),
    });
    const saved = this.persistedConversations().find((entry) => entry.sessionId === conv.id);
    conv.adoptSavedTitle(saved?.title);
    this.rememberConversation?.(conv);
    // Defensive: never leave a live wrapper for the same id behind (it would keep its subscription).
    const collision = this.convs.get(conv.id);
    if (collision && collision !== conv) collision.dispose();
    this.convs.set(conv.id, conv);
    this.activeId = conv.id;
    this.emitConversations();
    conv.getState();
    return conv;
  }

  /**
   * Close least-recently-active conversations until there is room for one more.
   *
   * Deliberately evicts rather than refusing: the client asked for a new chat and an error
   * would be worse UX than silently retiring a cold background conversation. The active
   * conversation is never evicted, and we never drop below one.
   */
  private evictForCapacity(): void {
    while (this.convs.size >= this.maxOpenConversations) {
      // Candidates: everything except the active one.
      const candidates = [...this.convs.values()].filter((conv) => conv.id !== this.activeId);
      if (candidates.length === 0) break; // only the active one remains — cannot evict
      const victim = candidates.reduce((oldest, conv) =>
        conv.lastActiveAt < oldest.lastActiveAt ? conv : oldest,
      );
      getLogger()
        .child({ component: "session-hub", clientId: this.clientId })
        .debug("超出并发会话上限，回收最久未活动的对话", {
          victimId: victim.id,
          open: this.convs.size,
          cap: this.maxOpenConversations,
        });
      this.rememberConversation?.(victim);
      victim.dispose();
      this.convs.delete(victim.id);
    }
  }

  get active(): Conversation | undefined {
    return this.convs.get(this.activeId);
  }

  get(conversationId: string): Conversation | undefined {
    return this.convs.get(conversationId);
  }

  switchConversation(conversationId: string): boolean {
    if (!this.convs.has(conversationId)) return false;
    this.activeId = conversationId;
    this.emitConversations();
    this.convs.get(conversationId)?.getState();
    return true;
  }

  closeConversation(conversationId: string): boolean {
    const conv = this.convs.get(conversationId);
    if (!conv) return false;
    // Keep at least one conversation alive.
    if (this.convs.size === 1) return false;
    this.rememberConversation?.(conv);
    conv.dispose();
    this.convs.delete(conversationId);
    if (this.activeId === conversationId) {
      const next = this.convs.keys().next();
      this.activeId = next.done ? "" : next.value;
    }
    this.emitConversations();
    this.active?.getState();
    return true;
  }

  listConversations(): UiConversation[] {
    const live = [...this.convs.values()].map((conv) => conv.toSummary(conv.id === this.activeId));
    const liveIds = new Set(live.map((item) => item.id));
    const dormant: UiConversation[] = this.persistedConversations()
      .filter((entry) => !liveIds.has(entry.sessionId))
      .map((entry) => ({
        id: entry.sessionId,
        title: entry.title,
        active: false,
        streaming: false,
        messageCount: entry.messageCount,
        updatedAt: entry.updatedAt,
        dormant: true,
      }));
    return [...live, ...dormant].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Number of open conversations (for metrics). */
  conversationCount(): number {
    return this.convs.size;
  }

  private emitConversations(): void {
    this.emit({ type: "conversations", items: this.listConversations() });
  }

  /* ─────────────── 命令转发 ─────────────── */

  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    const conv = this.active ?? (await this.newConversation());
    await conv.prompt(text, images);
  }

  async steer(text: string, images?: ImageContent[]): Promise<void> {
    const conv = this.active;
    if (!conv) throw new AppError("conflict", "还没有对话，先发一条消息", { expose: true });
    await conv.steer(text, images);
  }

  async followUp(text: string, images?: ImageContent[]): Promise<void> {
    const conv = this.active;
    if (!conv) throw new AppError("conflict", "还没有对话，先发一条消息", { expose: true });
    await conv.followUp(text, images);
  }

  abortCompaction(): void {
    this.active?.abortCompaction();
  }

  async abort(): Promise<void> {
    await this.active?.abort();
  }

  /**
   * 主动压缩当前对话的上下文。
   *
   * 没有活动对话时**什么也不做**并说明原因——静默返回会让用户以为压过了，
   * 下次上下文满时才发现根本没生效。
   */
  async compact(instructions?: string): Promise<CompactionOutcome> {
    const conv = this.active;
    if (!conv) return { ok: false, reason: "还没有对话，先发一条消息再压缩" };
    return conv.compact(instructions);
  }

  getState(): void {
    this.active?.getState();
  }

  async setModel(ref: string): Promise<Model<any>> {
    const model = await this.agent.switchModel(ref);
    // Apply to every conversation: the model is a client-wide choice, and leaving background
    // conversations on the old model would make snapshots report inconsistent state.
    await Promise.all([...this.convs.values()].map((conv) => conv.setModel(model)));
    return model;
  }

  /** 把一个新模型实例应用到本连接的所有对话（轮换时用，避免重复推进共享 session 的指针）。 */
  async applyModel(model: Model<any>): Promise<void> {
    for (const conv of this.convs.values()) {
      try {
        await conv.setModel(model);
      } catch {
        /* 单个对话切换失败不影响其余 */
      }
    }
  }

  /** 轮换当前对话的思考档（仅作于当前活动对话）。 */
  cycleThinking(): string | undefined {
    return this.active?.cycleThinking();
  }

  setThinking(level: string): void {
    this.active?.setThinking(level);
  }

  /**
   * 向本连接推一条通知。
   *
   * 给「服务端发生了一件事，客户端必须立刻看到」用（子代理失败、MCP 服务器掉线）。
   * 这类事件没有对应的快照字段——等下一次快照才看到，用户会以为什么都没发生。
   */
  notify(level: "info" | "warn" | "error", text: string): void {
    this.emit({ type: "notice", level, text });
  }

  /** Apply a tool set to every conversation (the tool registry is client-wide). */
  applyToolSet(toolNames: readonly string[]): void {
    for (const conv of this.convs.values()) conv.applyToolSet(toolNames);
  }

  requestApproval(conversationId: string, request: UiApproval): void {
    this.convs.get(conversationId)?.requestApproval(request);
  }

  /**
   * 丢掉一条对话，哪怕它是最后一条。只用于恢复结果和索引对不上的失败路径，
   * 正常关闭仍走 `closeConversation`（至少留一条）。
   */
  dropConversation(conversationId: string): void {
    const conv = this.convs.get(conversationId);
    if (!conv) return;
    conv.dispose();
    this.convs.delete(conversationId);
    if (this.activeId === conversationId) {
      const next = this.convs.keys().next();
      this.activeId = next.done ? "" : next.value;
    }
    this.emitConversations();
  }

  /**
   * 仅重推一次会话列表。给那些改了索引但没动本连接内存的操作用（如删除磁盘态历史对话）。
   */
  refreshConversations(): void {
    this.emitConversations();
  }

  dispose(): void {
    for (const conv of this.convs.values()) {
      this.rememberConversation?.(conv);
      conv.dispose();
    }
    this.convs.clear();
    this.activeId = "";
  }
}

/* ────────────────────────── SessionHub ────────────────────────── */

export class SessionHub {
  private readonly sessions = new Map<string, ClientSession>();
  /** sessionId 正在被某个连接打开，挡住并发的第二次 open。 */
  private readonly opening = new Set<string>();

  constructor(
    private readonly agent: BuiltAgent,
    private readonly cfg: RuntimeConfig,
    private readonly cwd: string = process.cwd(),
    private readonly keepRecent: () => number = () => 6,
    private readonly maxOpenConversations: number = DEFAULT_MAX_OPEN_CONVERSATIONS,
    private readonly toolTimeoutMs: () => number = () => 0,
    private readonly allowedSessionRoots: readonly string[] = [],
    private readonly catalog?: SessionCatalog,
    /**
     * 可选的按名装配参数。
     *
     * 位置参数已经排到第 8 个，再加第 9 个会让调用方无法分辨「传错顺序」与「少传一个」——
     * 而这类错误只表现为行为诡异，不会报错。新增能力从这里进。
     */
    private readonly options: { planMode?: PlanModeController } = {},
  ) {}

  /**
   * 导入一个外部 `.jsonl` 会话到本工作区（官方 `SessionManager.forkFrom`）。
   *
   * 官方 CLI/RPC 的 `importFromJsonl` 底层就是同一个 forkFrom 原语。这里把它接到脚手架的
   * 会话目录与索引：源文件被完整复制进本脚手架的会话目录（而非直接引用外部路径），
   * 登记进 catalog 后，走既有的 `openConversation` 即可打开。**不改正在对话的会话。**
   *
   * 安全：导入会读任意外部路径（管理员动作），非 loopback 部署仍须前置鉴权代理；
   * 复制出的目标文件同样过 `assertSessionFileAllowed`（fail-closed，与恢复同一道闸）。
   */
  importConversation(sourcePath: string, title?: string): StoredConversation {
    const dir = this.allowedSessionRoots[0];
    if (!dir) throw new AppError("forbidden", "会话目录未启用，无法导入");
    if (!this.catalog) throw badRequest("没有会话索引，无法登记导入的会话");
    const abs = resolveAbsPath(sourcePath);
    if (!abs.toLowerCase().endsWith(".jsonl")) throw badRequest("导入源必须是 .jsonl 会话文件");
    if (!existsSync(abs)) throw new AppError("not_found", "导入源文件不存在");

    // 官方原语：把源会话的完整历史 fork 到 targetCwd 的会话目录，生成一个全新 session id。
    const forked = SessionManager.forkFrom(abs, this.cwd, dir);
    const sessionFile = forked.getSessionFile();
    if (!sessionFile) throw new AppError("internal", "导入未能生成会话文件");
    assertSessionFileAllowed(sessionFile, this.allowedSessionRoots);

    const entry: StoredConversation = {
      sessionId: forked.getSessionId(),
      sessionFile,
      title: normalizeConversationTitle(title ?? "Imported conversation"),
      updatedAt: Date.now(),
      messageCount: forked.getBranch().length,
    };
    this.catalog.upsert(entry);
    return entry;
  }

  /**
   * 按索引里的会话 id 打开历史对话。客户端不提供路径。
   * 另一个连接已经打开同一条时拒绝，不把对话抢走。
   */
  async openConversation(clientId: string, conversationId: string): Promise<Conversation> {
    const owner = this.sessions.get(clientId);
    if (!owner) throw badRequest("连接尚未建立");
    if (!conversationId.trim()) throw badRequest("会话 id 不能为空");
    const already = owner.get(conversationId);
    if (already) {
      owner.switchConversation(conversationId);
      return already;
    }
    for (const [id, session] of this.sessions) {
      if (id !== clientId && session.get(conversationId)) {
        throw new AppError("conflict", "该对话正由另一个连接使用");
      }
    }
    const entry = this.catalog?.get(conversationId);
    if (!entry) throw new AppError("not_found", "没有这条历史对话");
    if (this.opening.has(conversationId)) {
      throw new AppError("conflict", "该对话正在被打开");
    }
    this.opening.add(conversationId);
    try {
      const conv = await owner.newConversation({ resumeFrom: entry.sessionFile });
      if (conv.id !== conversationId) {
        owner.dropConversation(conv.id);
        throw new AppError("internal", "恢复后的会话标识与索引不一致");
      }
      return conv;
    } catch (err) {
      if (err instanceof AppError) {
        // 文件已经没了就别再留在列表里。其它拒绝（目录不对、工厂缺失）保留索引。
        if (err.code === "forbidden" && !existsSync(entry.sessionFile)) {
          this.catalog?.remove(conversationId);
        }
        throw err;
      }
      getLogger().warn("打开历史会话失败", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new AppError("internal", "无法打开该会话", { cause: err });
    } finally {
      this.opening.delete(conversationId);
    }
  }

  /**
   * 真删除一条对话：内存卸掉、索引去掉、磁盘会话文件删掉。
   *
   * 与 closeConversation 的区别在于后者会 rememberConversation，会话仍留在索引里，
   * 所以“删了但列表里又出现一条磁盘态”不是 bug而是 close 的本意。要真消失只能走这里。
   *
   * 安全：删文件前必过 `assertSessionFileAllowed`（与打开时同一道闸，fail-closed）。
   * 宁可删不成也不能删到会话目录外面；索引条目缺失时只卸内存，不猜路径。
   */
  deleteConversation(clientId: string, conversationId: string): void {
    const owner = this.sessions.get(clientId);
    if (!owner) throw badRequest("连接尚未建立");
    if (!conversationId?.trim()) throw badRequest("会话 id 不能为空");

    const live = owner.get(conversationId);
    const entry = this.catalog?.get(conversationId);
    if (!live && !entry) throw new AppError("not_found", "没有这条对话");

    // 正在生成回复的会话不能拆：dispose 会把回合中间的写入扫在脚下。
    if (live?.toSummary(false).streaming) throw badRequest("该对话正在生成回复，先中止再删除");
    // 与 close 一致：至少留一条可用对话，否则客户端会落在空列表上。
    if (live && owner.conversationCount() === 1) throw badRequest("这是最后一条对话，先新建一条再删它");

    const file = entry?.sessionFile;
    if (file) assertSessionFileAllowed(file, this.allowedSessionRoots);

    if (live) owner.dropConversation(conversationId);
    if (file && existsSync(file)) rmSync(file);
    this.catalog?.remove(conversationId);
    // 只改索引没动内存时（磁盘态条目）上面的 drop 不会推列表，这里统一补一次。
    owner.refreshConversations();
  }

  /** Attach a client id to a fresh ClientSession (disposes any previous one). */
  async attach(clientId: string, push: (msg: ServerMessage) => void): Promise<ClientSession> {
    const existing = this.sessions.get(clientId);
    if (existing) existing.dispose();
    const session = new ClientSession({
      clientId,
      agent: this.agent,
      cfg: this.cfg,
      cwd: this.cwd,
      push,
      keepRecent: this.keepRecent,
      toolTimeoutMs: this.toolTimeoutMs,
      maxOpenConversations: this.maxOpenConversations,
      allowedSessionRoots: this.allowedSessionRoots,
      persistedConversations: () => this.catalog?.list() ?? [],
      rememberConversation: (conv) => this.remember(conv),
      planMode: this.options.planMode,
    });
    this.sessions.set(clientId, session);
    await session.attach();
    return session;
  }

  get(clientId: string): ClientSession | undefined {
    return this.sessions.get(clientId);
  }

  /** All live client sessions (used to route server-initiated events such as approvals). */
  all(): ClientSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Aggregate live counts for metrics/health.
   * Derived on demand rather than tracked incrementally so it can never drift.
   */
  stats(): { sessions: number; conversations: number } {
    let conversations = 0;
    for (const session of this.sessions.values()) conversations += session.conversationCount();
    return { sessions: this.sessions.size, conversations };
  }

  /**
   * Switch the model across every client session and the shared agent session.
   *
   * This is the only correct entry point for a model switch in a multi-conversation server.
   * Calling `agent.switchModel()` directly would change just the shared session, leaving every
   * conversation on the old model — and since `agent.model` reads from that session, the
   * reported model would disagree with what conversations are actually running.
   */
  async setModel(ref: string): Promise<Model<any>> {
    // Change the shared session first so `agent.model` is correct even with zero clients.
    const model = await this.agent.switchModel(ref);
    const sessions = [...this.sessions.values()];
    if (sessions.length === 0) return model;

    // Fan out sequentially rather than in Promise.all: a rejection must not leave the
    // remaining sessions silently on the old model with no report.
    const failures: unknown[] = [];
    for (const session of sessions) {
      try {
        await session.setModel(ref);
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length === sessions.length) throw failures[0];
    if (failures.length > 0) {
      getLogger().warn("部分客户端会话切换模型失败", {
        failed: failures.length,
        total: sessions.length,
      });
    }
    return model;
  }

  /**
   * 沿官方 `scopedModels` 轮换模型：先推进共享 session（单一真源），再把新模型
   * 扇出到每个客户端的所有对话。无轮换列表 / SDK 不提供时返回 undefined。
   */
  async cycleModel(direction?: "forward" | "backward"): Promise<Model<any> | undefined> {
    const next = await this.agent.cycleModel(direction);
    if (!next) return undefined;
    for (const session of this.sessions.values()) {
      await session.applyModel(next);
    }
    return next;
  }

  /**
   * REST侧主动压缩：作用到**所有**连接的当前对话。
   *
   * REST 没有「哪个连接」的上下文，所以语义只能是全局的。逐个会话串行压缩而不是
   * `Promise.all`：压缩要调 LLM，同时发起会撞上速率限制，而且一个失败不该让
   * 其余的静默不出结果——失败会被收集并在最后一起报出。
   */
  async compactAcrossClients(instructions?: string): Promise<{
    ok: boolean;
    compacted: number;
    reason?: string;
    results: Array<{ clientId: string; ok: boolean; reason?: string; tokensBefore?: number; tokensAfter?: number }>;
  }> {
    const sessions = [...this.sessions.values()];
    if (sessions.length === 0) {
      return { ok: false, compacted: 0, reason: "当前没有活动连接", results: [] };
    }
    const results: Array<{
      clientId: string; ok: boolean; reason?: string; tokensBefore?: number; tokensAfter?: number;
    }> = [];
    for (const session of sessions) {
      try {
        const outcome = await session.compact(instructions);
        results.push({ clientId: session.clientId, ...outcome });
      } catch (err) {
        results.push({
          clientId: session.clientId,
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const compacted = results.filter((r) => r.ok).length;
    return {
      ok: compacted > 0,
      compacted,
      reason: compacted === 0 ? results[0]?.reason ?? "没有可压缩的对话" : undefined,
      results,
    };
  }

  private requireClient(clientId: string): ClientSession {
    const owner = this.sessions.get(clientId);
    if (!owner) throw badRequest("连接尚未建立");
    return owner;
  }

  /**
   * 已打开的对话改名会写进会话文件。还没打开的只改索引，
   * 之后 open 会留下这个标题，不会被第一条消息重新推导盖掉。
   */
  renameConversation(clientId: string, conversationId: string, title: string): string {
    const next = normalizeConversationTitle(title);
    if (!conversationId.trim()) throw badRequest("会话 id 不能为空");
    const owner = this.requireClient(clientId);
    const live = owner.get(conversationId);
    if (live) {
      const applied = live.rename(next);
      this.remember(live);
      return applied;
    }
    const entry = this.catalog?.get(conversationId);
    if (!entry) throw new AppError("not_found", "没有这条对话");
    this.catalog?.upsert({ ...entry, title: next, updatedAt: Date.now() });
    return next;
  }

  /** 没打开的对话不静默加载。回退会改模型接下来看到的上下文，必须是用户正在看的那条。 */
  async rollbackConversation(
    clientId: string,
    conversationId: string,
    entryId: string,
    opts?: { summarize?: boolean; instructions?: string },
  ): Promise<void> {
    const conv = this.requireLoaded(clientId, conversationId);
    await conv.rollbackTo(entryId, opts);
    this.remember(conv);
  }

  editConversation(clientId: string, conversationId: string, entryId: string): { entryId: string; text: string } {
    const conv = this.requireLoaded(clientId, conversationId);
    const edited = conv.editMessage(entryId);
    this.remember(conv);
    return edited;
  }

  /** 给已打开对话的某条条目打/清官方标签。 */
  setLabel(clientId: string, conversationId: string, entryId: string, label?: string): void {
    const conv = this.requireLoaded(clientId, conversationId);
    conv.setLabel(entryId, label);
  }

  /**
   * 分叉写一个新文件，再按现有的打开流程加载。
   * 路径来自索引或已打开对话的会话文件，不接受客户端传来的路径。
   */
  async forkConversation(clientId: string, conversationId: string, entryId?: string): Promise<Conversation> {
    if (!conversationId.trim()) throw badRequest("会话 id 不能为空");
    const owner = this.requireClient(clientId);
    const live = owner.get(conversationId);
    if (live?.streaming()) {
      throw new AppError("conflict", "对话正在生成，先停掉再分叉");
    }
    const stored = live?.toStored() ?? this.catalog?.get(conversationId);
    if (!stored) throw new AppError("not_found", "没有这条对话，或它还没落盘");
    if (!this.catalog) throw badRequest("没有会话索引，无法登记分叉");
    const forked = forkSessionFile(stored.sessionFile, entryId, this.allowedSessionRoots);
    this.catalog.upsert({
      sessionId: forked.sessionId,
      sessionFile: forked.sessionFile,
      title: forkedConversationTitle(live?.title ?? stored.title),
      updatedAt: Date.now(),
      messageCount: forked.messageCount,
    });
    return this.openConversation(clientId, forked.sessionId);
  }

  private requireLoaded(clientId: string, conversationId: string): Conversation {
    if (!conversationId.trim()) throw badRequest("会话 id 不能为空");
    const owner = this.requireClient(clientId);
    const conv = owner.get(conversationId);
    if (!conv) throw badRequest("这条对话还没打开，先发 open_conversation");
    return conv;
  }

  private remember(conv: Conversation): void {
    if (!this.catalog) return;
    const entry = conv.toStored();
    if (!entry) return;
    try {
      this.catalog.upsert(entry);
    } catch (err) {
      getLogger().warn("会话索引更新失败", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  detach(clientId: string): void {
    const session = this.sessions.get(clientId);
    if (session) {
      session.dispose();
      this.sessions.delete(clientId);
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}

/** Build a SessionHub over an assembled agent. */
export function createSessionHub(
  agent: BuiltAgent,
  cfg: RuntimeConfig,
  cwd?: string,
  keepRecent?: () => number,
  maxOpenConversations?: number,
  toolTimeoutMs?: () => number,
  allowedSessionRoots?: readonly string[],
  catalog?: SessionCatalog,
  options?: { planMode?: PlanModeController },
): SessionHub {
  return new SessionHub(
    agent, cfg, cwd, keepRecent, maxOpenConversations, toolTimeoutMs, allowedSessionRoots, catalog,
    options,
  );
}
