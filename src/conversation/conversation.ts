/**
 * pi-starter · 单个对话（`Conversation`）
 *
 * 从 `session-hub.ts` 拆出。一个 `Conversation` 绑定一个 SDK `Session` 订阅，负责两件事：
 *   1. **事件翻译**：`onEvent` 把 SDK 事件流折成手写的流式状态（文本 / 思考 / 工具耗时 / 压缩）；
 *   2. **快照调度**：按节流窗口把 `UiState` 推给注入的 `push` 回调，不直接持有 WebSocket。
 *
 * 设计要点（与 README 的「Context & compaction」一节对应）：
 *   - 上下文占用直接用 `context/budget` 的估算，不读 SDK 私有字段，保证进度条与真实裁剪阈值同源；
 *   - 消息投影走 `conversation/messages.ts` 的纯函数，靠弱引用缓存维持「仅追加」的引用稳定性；
 *   - 会话树操作（改名 / 回滚 / 编辑 / 分叉 / 标签）在 SDK 会话文件上落地，失败以结构化结果回给 UI。
 */

import { existsSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { BuiltAgent } from "../agent.js";
import type { RuntimeConfig } from "../config.js";
import { SnapshotEmitter } from "../snapshot.js";
import { computeSoftCap, contextUsageRatio, estimateTokens, planContextTrim, type TrimPlan } from "../context/budget.js";
import { getLogger, type Logger } from "../log.js";
import { AppError, badRequest } from "../errors.js";
import { editUserMessage, normalizeConversationTitle, rollbackSession } from "../sessions/edit.js";
import type { StoredConversation } from "../sessions/store.js";
import type { PlanModeController } from "../modes/plan-mode.js";
import { ToolWatchdog } from "../approval/watchdog.js";
import { metrics } from "../metrics.js";
import {
  sdkAbortCompaction,
  sdkAgentState,
  sdkCompact,
  sdkCycleModel,
  sdkCycleThinkingLevel,
  sdkNavigateTree,
  sdkRenameSession,
  sdkSessionManager,
} from "../sdk-adapter.js";
import type { ServerMessage, UiApproval, UiConversation, UiMessage, UiState } from "../protocol.js";
import {
  MAX_SNAPSHOT_MESSAGES,
  deriveTitle,
  extractPartialText,
  extractText,
  projectMessage,
  summarizePrompt,
  type ProjectionCache,
  type ProjectionSig,
  type ToolResults,
} from "./messages.js";

export type Session = BuiltAgent["session"];

/**
 * Tools that legitimately outlive any timeout because they wait on a human.
 * Killing these would break the interaction rather than protect it.
 *
 * 原先定义在 `ClientSession` 那一段，但唯一的消费方是 `Conversation` 构造工具看门狗，
 * 拆分时随消费方一起搬到这里。
 */
export const WATCHDOG_EXEMPT_TOOLS = new Set(["ask_user_question", "ask_user", "request_user_input"]);

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
  /**
   * `getSessionStats()` 的缓存。
   *
   * 快照每个周期都要读它，而 SDK 的实现是 `sessionManager.getEntries()` —— 每次都会
   * `fileEntries.filter(...)` **全量复制再全量扫描**一遍会话条目，成本随会话变长而增长。
   * 统计值只在「条目变了」时才会变，所以按事件作废、周期内复用（见 `onEvent`）。
   */
  private sessionStats: ReturnType<Session["getSessionStats"]> | undefined;
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
    // 高频事件只有流式增量两类，它们不会新增会话条目、也不改 usage，所以统计值不变。
    // 其余事件一律作废 `sessionStats`，让下一次 `buildState()` 重新取一份（保守方向：
    // 宁可多算一次，也不会显示出过期的 token / cost）。
    if (event.type !== "message_update" && event.type !== "tool_execution_update") {
      this.sessionStats = undefined;
    }
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
        // 有界：正常配对的 tool_execution_end 会删掉它，但 abort 打断工具时 end 帧可能永远
        // 不来，条目就按 toolCallId 在会话内泄漏。与 toolDurations 同一口径（500，丢最早）。
        if (this.toolStartTimes.size >= 500) {
          const oldest = this.toolStartTimes.keys().next().value;
          if (oldest !== undefined) this.toolStartTimes.delete(oldest);
        }
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
  planTrim(messages: readonly UiMessage[] = this.currentMessages(), estimatedTokens?: number): TrimPlan {
    const model = this.session.model ?? this.fallbackModel;
    const softCap = computeSoftCap(model.contextWindow ?? 0);
    return planContextTrim({
      messages,
      maxTokens: softCap,
      keepRecent: this.keepRecent(),
      // 调用方持有逐条 token 缓存时把它传进来，避免这里按字符重算全量（热路径）。
      ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    });
  }

  /* ─────────────── 快照构建（C 类） ─────────────── */

  /**
   * 当前路径的会话条目：一次遍历同时取回「消息对象 → 条目 id」与「条目上的官方标签」。
   *
   * `SessionManager.buildContextEntries()` 每次都会先 `getEntries()` 过滤整个会话文件，
   * 再走一遍树——**并不便宜**。快照构建（`buildState`）两个结果都要用，合并成一趟就省掉
   * 了每周期第二遍「全文件过滤 + 树遍历」。`getLabel` 只是 `labelsById` 的 Map 查询，
   * 顺带调用可忽略不计。
   */
  private contextIndex(): {
    ids: Map<AgentMessage, string>;
    labels: { entryId: string; label: string }[];
  } {
    const ids = new Map<AgentMessage, string>();
    const labels: { entryId: string; label: string }[] = [];
    const manager = this.sessionManager();
    if (!manager) return { ids, labels };
    for (const entry of manager.buildContextEntries()) {
      if (entry.type === "message") ids.set(entry.message, entry.id);
      const label = manager.getLabel(entry.id);
      if (label) labels.push({ entryId: entry.id, label });
    }
    return { ids, labels };
  }

  /** 当前路径上，消息对象 → 会话条目 id。没有会话树时为空。 */
  private entryIds(): Map<AgentMessage, string> {
    return this.contextIndex().ids;
  }

  private sessionManager(): SessionManager | undefined {
    // 私有形状访问统一走 sdk-adapter（一处升级、一处改）。
    return sdkSessionManager(this.session);
  }

  private requireManager(): SessionManager {
    const manager = this.sessionManager();
    if (!manager) throw badRequest("当前会话不能编辑历史");
    return manager;
  }

  /** 树变了之后，让模型看到的消息和快照跟着走。只 branch() 而不换这份数组，界面还是旧的后半段。 */
  private adoptTree(manager: SessionManager): void {
    const state = sdkAgentState(this.session);
    if (!state) throw new AppError("internal", "当前会话不能同步消息");
    state.messages = manager.buildSessionContext().messages;
    this.cache = new WeakMap();
    this.projectionSig = new WeakMap();
    this.tokenCache = new WeakMap();
    this.sessionStats = undefined;
    this.streamingText = "";
    this.streamingThinking = "";
    this.getState();
  }

  /**
   * 会话统计（token / cost / 消息计数），按事件失效、周期内复用。
   *
   * 直接调 `session.getSessionStats()` 的代价见 `sessionStats` 字段的注释——它是 SDK 里
   * 唯一「每次调用都全量过滤一遍会话文件」的读接口，而快照每个周期都要读它。
   */
  private stats(): ReturnType<Session["getSessionStats"]> {
    if (!this.sessionStats) this.sessionStats = this.session.getSessionStats();
    return this.sessionStats;
  }

  /**
   * Projected chat messages, using the stable-reference projection cache.
   *
   * `ids` 可由调用方传入（`buildState` 就是），避免同一周期为了拿条目 id 再走一遍会话树。
   */
  private currentMessages(ids?: Map<AgentMessage, string>): UiMessage[] {
    const entryIds = ids ?? this.entryIds();
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
      const ui = projectMessage(message, this.cache, entryIds.get(message), results, this.projectionSig);
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

  private buildState(): Omit<UiState, "rev"> {
    const session = this.session;
    // 一趟会话树遍历同时拿到「消息→条目 id」与「官方标签」，投影与标签共用，不再各走一遍。
    const { ids, labels } = this.contextIndex();
    const allMessages = this.currentMessages(ids);
    const totalMessageCount = allMessages.length;
    const messages = this.boundedMessages(allMessages);
    const model = session.model ?? this.fallbackModel;
    const stats = this.stats();
    const contextTokens = this.estimateTokensCached(messages);
    const softCap = computeSoftCap(model.contextWindow ?? 0);
    // `messages` 只是 `allMessages` 的尾部切片：未截断时两者就是**同一个数组**，本轮的总 token
    // 上面已经用同一个 `estimateTokensCached` 算过，不必为「是否超预算」再全量累加一遍。
    const totalTokens =
      messages.length < totalMessageCount ? this.estimateTokensCached(allMessages) : contextTokens;

    return {
      clientId: this.clientId,
      cwd: this.cwd,
      sessionId: session.sessionId,
      conversationId: this.id,
      // 不在这里给 rev：revision 链由 SnapshotEmitter 独占（`++this.rev`），
      // 本函数返回类型也刻意去掉了 rev，避免出现一个看似生效、实则被覆盖的死字段。
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
          // 复用本次已投影好的 `allMessages`，避免每个快照周期再全量投影一遍（原先这里
          // 会再调一次 `currentMessages()`，等于每周期做两遍投影 + 两遍会话树遍历）。
          // 注意这里刻意用**未截断**的 `allMessages`：预算是真实上下文的属性，不该被
          // 「快照最多 500 条」这个 UI 投影上限掩盖。但判断 trim 不必逐字符重算——
          // 逐条缓存与 `estimateConversationTokens` 是同一套公式，直接把总数传进去。
          //
          // `planContextTrim` 在 `estimated <= maxTokens` 时会立刻返回 `trimmed: false`，
          // 所以先用同一个总数短路：没超预算时连那份马上被丢弃的 drop/keep 计划数组都不必
          // 构造。判定仍然只有 `planContextTrim` 一个事实源。
          overBudget: totalTokens > softCap && this.planTrim(allMessages, totalTokens).trimmed,
        },
      },
      pendingApproval: this.pendingApproval,
      planMode: this.isPlanMode(),
      conversations: this.listConversations(),
      labels,
    };
  }

  /**
   * Sum token estimates, reusing per-message counts.
   *
   * UiMessage references are stable (projection cache), so this costs O(消息条数) 次 WeakMap
   * 查询 —— 而不是每次都按**字符**重算（O(总字符数)）。这一层循环很便宜；
   * 快照周期里真正随会话变长的外部成本是 SDK 的 `getSessionStats()`（见 `sessionStats`）。
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

  async prompt(text: string, images?: ImageContent[], replaceEntryId?: string): Promise<void> {
    if (replaceEntryId) {
      // 原子"替换并重发"（官方 onEdit / onReload 的落点）：先把该用户消息移出当前路径，
      // 再走下面正常的一轮。生成中拒绝——树状态会和正在跑的那一轮打架。
      if (this.session.isStreaming) {
        throw new AppError("conflict", "对话正在生成，先停掉再重发", { expose: true });
      }
      const manager = this.requireManager();
      editUserMessage(manager, replaceEntryId);
      this.adoptTree(manager);
    }
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
    const stats = this.stats();
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
    const abortFn = sdkAbortCompaction(this.session);
    if (!abortFn) return;
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
    const fn = sdkCycleModel(this.session);
    if (!fn) return undefined;
    const result = await fn.call(this.session);
    this.getState();
    return result?.model;
  }

  /** 轮换思考档（官方 `session.cycleThinkingLevel`）。 */
  cycleThinking(): string | undefined {
    const fn = sdkCycleThinkingLevel(this.session);
    if (!fn) return undefined;
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
    return this.contextIndex().labels;
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
    const compactFn = sdkCompact(session);
    if (!compactFn) {
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
    this.sessionStats = undefined;
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
    // 优先官方 setSessionName，退回落 sessionManager.appendSessionInfo —— 两条私有路径
    // 都收在 sdk-adapter.sdkRenameSession 里，这里不再自行按形状试错。
    sdkRenameSession(this.session, next);
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
    const navigate = sdkNavigateTree(this.session);
    if (opts?.summarize && navigate) {
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
