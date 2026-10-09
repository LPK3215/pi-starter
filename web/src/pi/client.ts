/**
 * pi-starter WS 客户端（前端侧协议对端）
 *
 * 职责：把后端的 B 类推送（ServerMessage）收敛成一份可订阅的只读快照，
 * 把 A 类命令（ClientMessage）封成类型化方法。不做任何 UI 渲染。
 *
 * 关键约定（逐条来自后端 src/protocol.ts 与 src/transport/ws.ts）：
 * - `hello` 必须是首帧；服务端保证 `ready` 是它回的第一帧，之后才是 conversations + snapshot。
 * - 快照是权威事实源；`snapshot_delta` 靠 `rev`/`baseRev` 串成修订链，链断了就 `get_state` 自愈。
 * - `message_delta` 是两次快照之间的增量，快照到达时以快照为准重置本地缓冲，避免重复计数。
 * - 断线重连后必须重新 `hello` + `get_state`（服务端不给未 attach 的连接排队业务帧）。
 */

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type UiApproval,
  type UiCapabilities,
  type UiConversation,
  type UiExtensionRequest,
  type UiMessage,
  type UiModel,
  type UiExtensionResponse,
  type UiState,
} from "@pi/protocol";

/** 一次工具调用的前端视图（由 tool_status / tool_delta 聚合而成）。 */
export interface ToolView {
  toolCallId: string;
  toolName: string;
  phase: "start" | "end";
  isError?: boolean;
  durationMs?: number;
  /** 工具流式中间输出，截断保留尾部，避免长输出撑爆内存。 */
  output: string;
}

export type ConnectionStatus = "connecting" | "ready" | "offline";

/** 给 useSyncExternalStore 用的不可变快照。 */
export interface PiSnapshot {
  status: ConnectionStatus;
  serverVersion: string;
  /** 客户端与后端 PROTOCOL_VERSION 不一致（ready 里回带的版本）。 */
  protocolMismatch: boolean;
  capabilities: UiCapabilities | null;
  /** 当前对话的权威快照（未 attach 完成前为 null）。 */
  state: UiState | null;
  /** 快照之外累积的流式增量文本（快照到达后被快照覆盖）。 */
  streamText: string;
  streamThinking: string;
  /**
   * 本轮工具调用轨迹（进行中的同时会挂在流式尾消息上，由官方 ToolGroup 渲染）。
   *
   * 只在 run_start 与切会话时清空，**不在 run_end 清**：后端快照不持久化工具历史，
   * 所以它是“本次连接内最近一轮”的视图。抹掉的话，瞬时工具（几毫秒完事）的轨迹条
   * 整个人都看不见；试过按消息归档（toolsByEntry），定稿后实际渲染不出来，已删除。
   */
  tools: ToolView[];
  /** 轮次是否活跃：run_start 置真，run_end（非 willRetry）置假。 */
  runActive: boolean;
  /** 当前 ReAct 迭代序号（turn_start 带）。 */
  turnIndex: number;
  conversations: UiConversation[];
  models: { models: UiModel[]; current: string };
  /** 服务端 notice / error 帧，UI 显示为提示条。 */
  notices: { level: "info" | "warn" | "error"; text: string; at: number }[];
  /** 待应答的 HITL 反问队列（extension_ui_request）。 */
  uiRequests: UiExtensionRequest[];
}

const EMPTY_SNAPSHOT: PiSnapshot = {
  status: "connecting",
  serverVersion: "",
  protocolMismatch: false,
  capabilities: null,
  state: null,
  streamText: "",
  streamThinking: "",
  tools: [],
  runActive: false,
  turnIndex: 0,
  conversations: [],
  models: { models: [], current: "" },
  notices: [],
  uiRequests: [],
};

/** tool_delta 单个工具最多保留的字符数（尾部）。 */
const TOOL_OUTPUT_CAP = 4000;

/**
 * 协议里有、但本项目前端**刻意不消费**的帧，静默忽略不算漂移：
 * - `settings_state`：前端不调 `get_settings` / `set_settings`（控制面只做模型/思考/计划模式）。
 * - `knowledge_hits`：前端不调 `search_knowledge`。
 * - `turn_end`：只有一个 `turnIndex` 进度值，当前 UI 没有消费者（`turn_start` 已在维护它）。
 */
const IGNORED_FRAMES = new Set(["settings_state", "knowledge_hits", "turn_end"]);

const CLIENT_ID_KEY = "pi-starter.clientId";

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function persistentClientId(): string {
  try {
    const saved = localStorage.getItem(CLIENT_ID_KEY);
    if (saved) return saved;
    const fresh = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, fresh);
    return fresh;
  } catch {
    return "";
  }
}

export class PiWsClient {
  private ws: WebSocket | null = null;
  private snap: PiSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  /** 快照链的当前修订号；null 表示还没拿到权威快照。 */
  private rev: number | null = null;
  private attempt = 0;
  private closedByUser = false;
  /** 重连退避的定时器句柄：`disconnect()` 必须能取消它，否则断开后还会再开一条 socket。 */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 已发出切/建会话命令、正在等对应的权威快照。 */
  private awaitingSnapshot = false;
  /** 切换目标会话 id；`new_conversation` 时还没分配，为 null。 */
  private pendingConversationId: string | null = null;
  /** 被丢弃的「非当前会话」帧数（排障用：出现即说明存在并发生成的后台会话）。 */
  private foreignFrames = 0;
  /** 已告警过的未知帧类型（去重）。 */
  private readonly warnedFrames = new Set<string>();

  /** 已丢弃的非当前会话帧数。 */
  get droppedForeignFrames(): number {
    return this.foreignFrames;
  }

  /**
   * 该会话作用域帧是否属于**当前正在显示的会话**。
   *
   * 后端每条已打开对话都 `push` 到*同一个* socket（`ClientSession.emit` 不按 active 过滤，
   * 见 `src/session-hub.ts`），所以后台还在生成的会话 A 会持续发 `message_delta` /
   * `snapshot(_delta)`。不按 `conversationId` 过滤的后果是：A 的流式文本被拼进 B 的视图、
   * A 的工具轨迹混进 B 的列表、A 的全量快照整个替换掉 B 的消息。
   *
   * 还没有权威快照（`state === null`）时无法判定归属：
   * - 刚发过切/建会话命令（`awaitingSnapshot`）：只认切换目标，避免抢跑的后台帧先建立身份；
   * - 首连（没有等待）：放行，让第一份快照建立身份。
   */
  private belongsToView(conversationId: string | undefined): boolean {
    if (conversationId === undefined) return true; // 全局帧（conversations / models / notice…）
    const current = this.snap.state?.conversationId;
    if (current === undefined) {
      if (!this.awaitingSnapshot) return true;
      return this.pendingConversationId === null || this.pendingConversationId === conversationId;
    }
    return current === conversationId;
  }

  /** 丢弃一个非当前会话的帧并计数。 */
  private dropForeign(conversationId: string, frame: string): void {
    this.foreignFrames += 1;
    // 只在第一条上记日志：后台会话流式期间这类帧是高频的，逐条打会刷屏。
    if (this.foreignFrames === 1) {
      console.info(`[pi] 丢弃非当前会话的帧（当前 ${this.snap.state?.conversationId ?? "-"}，收到 ${conversationId}，帧 ${frame}）`);
    }
  }

  /** 供 useSyncExternalStore 使用：引用稳定，变更时才换新对象。 */
  getSnapshot = (): PiSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  connect(): void {
    // 幂等：React StrictMode 的双挂载、以及重连退避期间的重复调用都不该开出第二条 socket。
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    this.closedByUser = false;
    this.open();
  }

  disconnect(): void {
    this.closedByUser = true;
    this.cancelReconnect();
    this.ws?.close();
    this.ws = null;
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private open(): void {
    // 退避到期时再确认一次：等待期间可能已经 `disconnect()` 了，
    // 否则会建出一条无人管理的僵尸 socket（`closedByUser` 仍为 true，它的 close 又不再重连）。
    if (this.closedByUser) return;
    this.patch({ status: "connecting" });
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.attempt = 0;
      // 首帧固定 hello；带 clientId 让服务端复用同一会话身份（重连不丢对话）。
      this.send({
        type: "hello",
        clientId: persistentClientId() || undefined,
        protocolVersion: PROTOCOL_VERSION,
        locale: navigator.language,
      });
    });
    ws.addEventListener("message", (ev) => this.onRaw(String(ev.data)));
    ws.addEventListener("close", () => {
      if (this.closedByUser) return;
      this.patch({ status: "offline", runActive: false });
      const delay = Math.min(30000, 500 * 2 ** this.attempt++);
      this.cancelReconnect();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.open();
      }, delay);
    });
    ws.addEventListener("error", () => ws.close());
  }

  private onRaw(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    this.handle(msg);
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "ready": {
        this.patch({
          status: "ready",
          serverVersion: msg.serverVersion,
          capabilities: msg.capabilities,
          protocolMismatch:
            msg.clientProtocolVersion !== undefined &&
            msg.clientProtocolVersion !== msg.protocolVersion,
        });
        // 重连场景：服务端 attach 会推 conversations + snapshot，但显式再要一次更稳。
        this.send({ type: "get_state" });
        this.send({ type: "list_models" });
        this.send({ type: "get_capabilities" });
        break;
      }
      case "snapshot": {
        if (!this.belongsToView(msg.state.conversationId)) {
          this.dropForeign(msg.state.conversationId, "snapshot");
          return;
        }
        // 收到了在等的那份（或首连的）权威快照：清空等待标记。
        this.awaitingSnapshot = false;
        this.pendingConversationId = null;
        this.rev = msg.state.rev;
        // 快照权威：流式缓冲以快照里的 streamingMessage 为准。
        //
        // 思维链必须与文本同样**回填**：只回填文本、把 streamThinking 置空的话，
        // 下一条 thinking 增量会在空串上累加（`"" + delta`），快照之前累积的思维链
        // 整段丢失——表现为思维链在流式中"闪断"，只剩最后一帧之后的尾巴。
        this.patch({
          state: msg.state,
          conversations: msg.state.conversations,
          streamText: msg.state.streamingMessage?.text ?? "",
          streamThinking: msg.state.streamingMessage?.thinking ?? "",
          runActive: msg.state.isStreaming,
          uiRequests: this.uiRequestsFor(msg.state),
        });
        break;
      }
      case "snapshot_delta": {
        // 非当前会话的增量**直接丢弃**（服务端切会话时会自己推全量 snapshot）。
        //
        // 这里以前调的是 `resetConversationView()`——注释写"丢弃"，实现却是把**当前**视图
        // 清空。于是"看 B 时后台 A 在流式"会让 B 的消息被反复抹掉，比不过滤更糟。
        if (!this.belongsToView(msg.conversationId)) {
          this.dropForeign(msg.conversationId, "snapshot_delta");
          return;
        }
        if (this.rev !== null && msg.baseRev !== this.rev) {
          // 修订链断裂（背压丢帧等），请求全量快照自愈。
          this.send({ type: "get_state" });
          return;
        }
        const base = this.snap.state;
        const appended = [...(base?.messages ?? []), ...msg.appended];
        const merged: UiState = {
          ...(base ?? msg.state),
          ...msg.state,
          messages: appended.map((m) => ({ ...m })),
          streamingMessage: base?.streamingMessage ?? null,
        };
        this.rev = msg.rev;
        this.patch({ state: merged, conversations: merged.conversations });
        break;
      }
      case "message_delta": {
        if (!this.belongsToView(msg.conversationId)) {
          this.dropForeign(msg.conversationId, "message_delta");
          return;
        }
        if (msg.channel === "thinking") {
          this.patch({ streamThinking: this.snap.streamThinking + msg.delta });
        } else {
          this.patch({ streamText: this.snap.streamText + msg.delta });
        }
        break;
      }
      case "tool_status": {
        if (!this.belongsToView(msg.conversationId)) {
          this.dropForeign(msg.conversationId, "tool_status");
          return;
        }
        const tools = [...this.snap.tools];
        const idx = tools.findIndex((t) => t.toolCallId === msg.toolCallId);
        if (msg.phase === "start") {
          tools.push({ toolCallId: msg.toolCallId, toolName: msg.toolName, phase: "start", output: "" });
        } else if (idx >= 0) {
          tools[idx] = { ...tools[idx]!, phase: "end", isError: msg.isError, durationMs: msg.durationMs };
        } else {
          tools.push({
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            phase: "end",
            isError: msg.isError,
            durationMs: msg.durationMs,
            output: "",
          });
        }
        this.patch({ tools });
        break;
      }
      case "tool_delta": {
        if (!this.belongsToView(msg.conversationId)) {
          this.dropForeign(msg.conversationId, "tool_delta");
          return;
        }
        this.patch({
          tools: this.snap.tools.map((t) =>
            t.toolCallId === msg.toolCallId
              ? { ...t, output: (t.output + msg.delta).slice(-TOOL_OUTPUT_CAP) }
              : t,
          ),
        });
        break;
      }
      case "run_start":
        if (!this.belongsToView(msg.conversationId)) {
          this.dropForeign(msg.conversationId, "run_start");
          return;
        }
        this.patch({ runActive: true, tools: [], turnIndex: 0 });
        break;
      case "run_end":
        if (!this.belongsToView(msg.conversationId)) {
          this.dropForeign(msg.conversationId, "run_end");
          return;
        }
        // willRetry 表示 SDK 会自动重试，本轮没真结束，保持 running。
        // 工具轨迹**不清空**：留到下一轮 run_start 才清，否则几毫秒完事的工具根本看不见。
        this.patch({ runActive: msg.willRetry === true });
        break;
      case "turn_start":
        if (!this.belongsToView(msg.conversationId)) {
          this.dropForeign(msg.conversationId, "turn_start");
          return;
        }
        this.patch({ turnIndex: msg.turnIndex });
        break;
      case "conversations":
        this.patch({ conversations: msg.items });
        break;
      case "models":
        this.patch({ models: { models: msg.models, current: msg.current } });
        break;
      case "capabilities":
        this.patch({ capabilities: msg.capabilities });
        break;
      case "approval_request":
        // 审批卡片以快照 pendingApproval 为准；这帧只保证已连接时即时可见。
        this.patch({
          state: this.snap.state ? { ...this.snap.state, pendingApproval: msg.request } : this.snap.state,
        });
        break;
      case "extension_ui_request":
        this.patch({ uiRequests: [...this.snap.uiRequests, msg.request] });
        break;
      case "notice":
      case "error": {
        const level = msg.type === "error" ? "error" : msg.level;
        const text = msg.type === "error" ? msg.message : msg.text;
        // 出错过就放弃"正在等某会话快照"的坚持：切会话失败时不会再有快照到来，
        // 而 `belongsToView` 在等待期间会过滤掉所有其它会话的帧——不清掉就会永久黑屏。
        // （代价是无关的错误会提前放弃等待；此时 state 仍为 null，行为等同首连。）
        if (msg.type === "error") {
          this.awaitingSnapshot = false;
          this.pendingConversationId = null;
        }
        // 只留最近 3 条：重连恢复、限流之类提示会连续来，堆成一屏就没法看了。
        this.patch({ notices: [...this.snap.notices.slice(-2), { level, text, at: Date.now() }] });
        break;
      }
      case "pong":
        break;
      default:
        // 协议新增帧不能无声消失（排障时"后端明明推了、前端毫无反应"最难查）。
        // 已知但本项目不消费的帧不算漂移，见 IGNORED_FRAMES。
        if (!IGNORED_FRAMES.has((msg as { type: string }).type)) {
          this.warnUnknownFrame((msg as { type: string }).type);
        }
        break;
    }
  }

  /** 每个未知帧类型只告警一次，避免坏帧刷屏。 */
  private warnUnknownFrame(type: string): void {
    if (this.warnedFrames.has(type)) return;
    this.warnedFrames.add(type);
    console.warn(`[pi] 收到未知的服务端帧类型 "${type}"，已忽略（可能是前端与后端版本不一致）`);
  }

  /**
   * 清空当前会话视图。切/建会话时必须走这里：
   * 只重置 rev 不重置 state，会让新会话的 snapshot_delta 拼到旧会话的 messages 上。
   */
  private resetConversationView(): void {
    this.rev = null;
    this.patch({ state: null, streamText: "", streamThinking: "", tools: [], runActive: false });
  }

  /**
   * 反问不随快照持久化（后端明确标注未做快照持久化），
   * 所以重连后按快照里已无请求处理，只保留本次连接内收到的。
   */
  private uiRequestsFor(_state: UiState): UiExtensionRequest[] {
    return this.snap.uiRequests;
  }

  private patch(part: Partial<PiSnapshot>): void {
    this.snap = { ...this.snap, ...part };
    for (const l of this.listeners) l();
  }

  /** 发送一条命令；返回是否真的发出去了（离线时为 false，调用方据此决定要不要改本地视图）。 */
  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // 以前静默 return：离线时用户点发送，消息直接消失且没有任何反馈。
      this.notifyOffline();
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** 离线提示只加一条（`get_state` 之类的连发不该刷出一屏提示条）。 */
  private notifyOffline(): void {
    const text = "尚未连接服务端，操作未发送";
    if (this.snap.notices.at(-1)?.text === text) return;
    this.patch({ notices: [...this.snap.notices.slice(-2), { level: "warn", text, at: Date.now() }] });
  }

  /* ────────────── 类型化命令面（A 类） ────────────── */

  /**
   * 发一轮。`replaceEntryId` = 原子"替换并重发"：先把该用户消息移出路径，再用 `text` 发一条新的。
   * 官方的编辑 / 重新生成（`onEdit` / `onReload`）都落在这一个入口上。
   */
  prompt(text: string, images?: { mimeType: string; data: string }[], replaceEntryId?: string) {
    this.send({ type: "prompt", text, images, replaceEntryId });
  }
  abort() {
    this.send({ type: "abort" });
  }
  steer(text: string) {
    this.send({ type: "steer", text });
  }
  followUp(text: string) {
    this.send({ type: "follow_up", text });
  }
  compactContext(instructions?: string) {
    this.send({ type: "compact_context", instructions });
  }
  newConversation() {
    // 发送失败（离线）时**不动本地视图**：否则用户看到消息被清空、却什么也没发生。
    if (!this.send({ type: "new_conversation" })) return;
    this.awaitingSnapshot = true;
    this.pendingConversationId = null; // 新会话 id 由服务端分配，快照到达时才知道
    this.resetConversationView();
  }
  openConversation(conversationId: string) {
    if (!this.send({ type: "open_conversation", conversationId })) return;
    this.awaitingSnapshot = true;
    this.pendingConversationId = conversationId;
    this.resetConversationView();
  }
  switchConversation(conversationId: string) {
    if (!this.send({ type: "switch_conversation", conversationId })) return;
    this.awaitingSnapshot = true;
    this.pendingConversationId = conversationId;
    this.resetConversationView();
  }
  closeConversation(conversationId: string) {
    this.send({ type: "close_conversation", conversationId });
  }
  /**
   * 真删除（磁盘会话文件 + 索引条目一起没）。与 close 不同：close 后它会以磁盘态
   * 重新出现在列表里。服务端拒删时回 error 帧，会落在顶部提示条上。
   */
  deleteConversation(conversationId: string) {
    this.send({ type: "delete_conversation", conversationId });
  }
  renameConversation(conversationId: string, title: string) {
    this.send({ type: "rename_conversation", conversationId, title });
  }
  editMessage(entryId: string) {
    const conversationId = this.snap.state?.conversationId;
    if (conversationId) this.send({ type: "edit_message", conversationId, entryId });
  }
  rollback(entryId: string) {
    const conversationId = this.snap.state?.conversationId;
    if (conversationId) this.send({ type: "rollback_conversation", conversationId, entryId });
  }
  forkConversation(entryId?: string) {
    const conversationId = this.snap.state?.conversationId;
    if (conversationId) this.send({ type: "fork_conversation", conversationId, entryId });
  }
  setModel(modelId: string) {
    this.send({ type: "set_model", modelId });
  }
  setThinking(level: string) {
    this.send({ type: "set_thinking", level });
  }
  setPlanMode(enabled: boolean) {
    this.send({ type: "set_plan_mode", enabled });
  }
  setToolEnabled(name: string, enabled: boolean) {
    this.send({ type: "set_tool_enabled", name, enabled });
  }
  searchKnowledge(query: string) {
    this.send({ type: "search_knowledge", query });
  }
  approvalResponse(
    approval: UiApproval,
    decision: "allow" | "deny" | "modify",
    scope?: "once" | "category" | "all",
    modifiedArgs?: Record<string, unknown>,
  ) {
    this.send({
      type: "approval_response",
      requestId: approval.requestId,
      decision,
      scope,
      modifiedArgs,
    });
    this.patch({
      state: this.snap.state ? { ...this.snap.state, pendingApproval: null } : this.snap.state,
    });
  }
  respondUi(request: UiExtensionRequest, response: UiExtensionResponse) {
    this.send({ type: "extension_ui_response", response });
    this.patch({ uiRequests: this.snap.uiRequests.filter((r) => r.id !== request.id) });
  }

  /** 收起提示条。notice/error 帧是一次性告知，不自己过期的话只会堆在顶上。 */
  clearNotices(): void {
    if (this.snap.notices.length === 0) return;
    this.patch({ notices: [] });
  }
}

/** 按请求方法构造应答载荷：select/input/editor 回 value，confirm 回 confirmed，取消回 cancelled。 */
export function toUiResponsePayload(
  request: UiExtensionRequest,
  value: string | boolean | null,
): UiExtensionResponse {
  if (value === null) return { id: request.id, cancelled: true };
  if (request.method === "confirm") return { id: request.id, confirmed: value === true };
  return { id: request.id, value: String(value) };
}

/** 快照消息 + 本地流式缓冲 → 渲染用消息列表。 */
export function projectMessages(snap: PiSnapshot): UiMessage[] {
  const state = snap.state;
  if (!state) return [];
  const messages = [...state.messages];
  if (state.isStreaming) {
    // 流式中的文本与思维链都**以本地累加为准**：快照里的 streamingMessage 只是
    // 该快照生成那一刻的快照值，比它晚到的 message_delta 全在本地缓冲里。
    // 写成优先取 streamingMessage.text 会把快照之后的增量丢掉（实测：带工具轮的
    // 最终答复实时只显示“现在是”，刷新后才是全句）。
    const text = snap.streamText || state.streamingMessage?.text || "";
    const thinking = snap.streamThinking || state.streamingMessage?.thinking;
    if (text || thinking) {
      messages.push({
        role: "assistant",
        text,
        ...(thinking ? { thinking } : {}),
      });
    }
  }
  // 空内容消息不占气泡（以前会渲染成“（本轮无文本输出）”那种丑占位）。
  // 失败/中止的轮次要留下来，否则用户只看到“模型没说话”而不是“请求失败了”。
  const isFailureOnly = (m: UiMessage) =>
    m.role === "assistant" &&
    !m.text &&
    !m.thinking &&
    (m.calls?.length ?? 0) === 0 &&
    (m.stopReason === "error" || m.stopReason === "aborted");
  const kept: UiMessage[] = [];
  for (const m of messages) {
    const visible =
      m.role === "user" || !!m.text || !!m.thinking || (m.calls?.length ?? 0) > 0 || isFailureOnly(m);
    if (!visible) continue;
    // 上游持续故障时一轮会留下多条失败记录（重试各落一条），连排四五条失败气泡没信息量。
    const prev = kept.at(-1);
    if (isFailureOnly(m) && prev && isFailureOnly(prev)) {
      kept[kept.length - 1] = m; // 只留最新一条
      continue;
    }
    kept.push(m);
  }
  return kept;
}

export const piClient = new PiWsClient();
