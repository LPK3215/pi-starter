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

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { BuiltAgent } from "./agent.js";
import type { RuntimeConfig } from "./config.js";
import { SnapshotEmitter } from "./snapshot.js";
import { computeSoftCap, contextUsageRatio, estimateTokens, planContextTrim, type TrimPlan } from "./context/budget.js";
import { getLogger } from "./log.js";
import { ToolWatchdog } from "./approval/watchdog.js";
import { metrics } from "./metrics.js";
import type {
  ServerMessage,
  UiApproval,
  UiConversation,
  UiMessage,
  UiState,
} from "./protocol.js";

type Session = BuiltAgent["session"];

/** 消息投影缓存：保证「仅追加」判定能靠对象引用等同性完成。 */
type ProjectionCache = WeakMap<AgentMessage, UiMessage | null>;

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

/** Project an SDK AgentMessage to a UI message, or null when it is not a chat message. */
function projectMessage(message: AgentMessage, cache: ProjectionCache): UiMessage | null {
  const role = (message as { role?: string }).role;
  if (role !== "user" && role !== "assistant") return null;
  const hit = cache.get(message);
  if (hit !== undefined) return hit;
  const ui: UiMessage = {
    role,
    text: extractText((message as { content?: unknown }).content),
    timestamp: (message as { timestamp?: number }).timestamp,
  };
  cache.set(message, ui);
  return ui;
}

/** Derive a conversation title from the first user message. */
function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New conversation";
  return clean.length > 40 ? `${clean.slice(0, 40)}...` : clean;
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
}

export class Conversation {
  readonly id: string;
  readonly clientId: string;
  title = "New conversation";
  deltaSeq = 0;
  streamingText = "";
  lastActiveAt = Date.now();
  promptedSinceActive = false;
  pendingApproval: UiApproval | null = null;

  private push: (msg: ServerMessage) => void;
  private readonly unsubscribe: () => void;
  private readonly cache: ProjectionCache = new WeakMap();
  /** Per-message token counts, keyed by the stable projected UiMessage reference. */
  private readonly tokenCache = new WeakMap<UiMessage, number>();
  private readonly toolStartTimes = new Map<string, number>();
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
    this.keepRecent = opts.keepRecent ?? (() => 6);
    this.id = opts.session.sessionId;
    const log = getLogger().child({ component: "conversation", conversationId: this.id });
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
        // Always disarm, including on error: a leaked timer would later abort a healthy turn.
        this.watchdog.disarm(event.toolCallId);
        if (event.isError) metrics.inc("toolErrorsTotal");
        this.push({
          type: "tool_status",
          conversationId: this.id,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          phase: "end",
          isError: event.isError,
          durationMs: startedAt !== undefined ? Date.now() - startedAt : undefined,
        });
        break;
      }
      case "agent_start": {
        this.streamingText = "";
        this.promptedSinceActive = true;
        break;
      }
      case "message_end": {
        this.streamingText = "";
        this.refreshTitleFromSession();
        break;
      }
      case "queue_update": {
        // Steering / follow-up queues changed; snapshot carries them.
        break;
      }
      case "compaction_start": {
        this.push({ type: "notice", level: "info", text: `Compaction started (${event.reason})` });
        break;
      }
      case "compaction_end": {
        this.push({
          type: "notice",
          level: event.aborted ? "warn" : "info",
          text: event.aborted ? "Compaction aborted" : "Compaction finished",
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
      default:
        break;
    }

    this.lastActiveAt = Date.now();

    // Snapshot checkpoint policy: boundaries flush immediately, everything else throttles.
    if (
      event.type === "agent_end" ||
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

  private refreshTitleFromSession(): void {
    if (this.title !== "New conversation") return;
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

  /** Projected chat messages, using the stable-reference projection cache. */
  private currentMessages(): UiMessage[] {
    const messages: UiMessage[] = [];
    for (const message of this.session.messages) {
      const ui = projectMessage(message, this.cache);
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
        this.streamingText && session.isStreaming
          ? { role: "assistant", text: this.streamingText }
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
      conversations: this.listConversations(),
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

  prompt(text: string): Promise<void> {
    if (this.title === "New conversation" && text.trim()) this.title = deriveTitle(text);
    this.lastActiveAt = Date.now();
    return this.session.prompt(text);
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
   * Per-tool timeout (ms) for each conversation's watchdog, read lazily so a settings change
   * applies to newly created conversations. 0 (or omitted) disables the watchdog.
   */
  toolTimeoutMs?: () => number;
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
  async newConversation(): Promise<Conversation> {
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

    const session = factory ? await factory() : this.agent.session;
    const conv = new Conversation({
      clientId: this.clientId,
      session,
      fallbackModel: this.agent.model,
      cwd: this.cwd,
      cfg: this.cfg,
      push: (msg) => this.emit(msg),
      listConversations: () => this.listConversations(),
      keepRecent: this.keepRecent,
      toolTimeoutMs: this.toolTimeoutMs(),
      ownsSession: Boolean(factory),
    });
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
    return [...this.convs.values()]
      .map((conv) => conv.toSummary(conv.id === this.activeId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Number of open conversations (for metrics). */
  conversationCount(): number {
    return this.convs.size;
  }

  private emitConversations(): void {
    this.emit({ type: "conversations", items: this.listConversations() });
  }

  /* ─────────────── 命令转发 ─────────────── */

  async prompt(text: string): Promise<void> {
    const conv = this.active ?? (await this.newConversation());
    await conv.prompt(text);
  }

  async abort(): Promise<void> {
    await this.active?.abort();
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

  setThinking(level: string): void {
    this.active?.setThinking(level);
  }

  /** Apply a tool set to every conversation (the tool registry is client-wide). */
  applyToolSet(toolNames: readonly string[]): void {
    for (const conv of this.convs.values()) conv.applyToolSet(toolNames);
  }

  requestApproval(conversationId: string, request: UiApproval): void {
    this.convs.get(conversationId)?.requestApproval(request);
  }

  dispose(): void {
    for (const conv of this.convs.values()) conv.dispose();
    this.convs.clear();
    this.activeId = "";
  }
}

/* ────────────────────────── SessionHub ────────────────────────── */

export class SessionHub {
  private readonly sessions = new Map<string, ClientSession>();

  constructor(
    private readonly agent: BuiltAgent,
    private readonly cfg: RuntimeConfig,
    private readonly cwd: string = process.cwd(),
    private readonly keepRecent: () => number = () => 6,
    private readonly maxOpenConversations: number = DEFAULT_MAX_OPEN_CONVERSATIONS,
    private readonly toolTimeoutMs: () => number = () => 0,
  ) {}

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
): SessionHub {
  return new SessionHub(agent, cfg, cwd, keepRecent, maxOpenConversations, toolTimeoutMs);
}
