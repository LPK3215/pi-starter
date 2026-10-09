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
  /** 本轮工具调用轨迹（进行中的挂在流式尾消息上）。 */
  tools: ToolView[];
  /**
   * 已定稿的工具轨迹，按消息 entryId 归档。
   * 后端 UiMessage 不携带工具历史（只有 tool_status/tool_delta 帧描述过程），
   * 所以「哪条消息调了哪些工具」只能由前端在自己这轮收到时归档下来。
   */
  toolsByEntry: Record<string, ToolView[]>;
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
  toolsByEntry: {},
  runActive: false,
  turnIndex: 0,
  conversations: [],
  models: { models: [], current: "" },
  notices: [],
  uiRequests: [],
};

/** tool_delta 单个工具最多保留的字符数（尾部）。 */
const TOOL_OUTPUT_CAP = 4000;

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
    this.ws?.close();
    this.ws = null;
  }

  private open(): void {
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
      setTimeout(() => this.open(), delay);
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
        this.rev = msg.state.rev;
        // 快照权威：流式缓冲以快照里的 streamingMessage 为准。
        this.patch({
          state: msg.state,
          conversations: msg.state.conversations,
          streamText: msg.state.streamingMessage?.text ?? "",
          streamThinking: "",
          runActive: msg.state.isStreaming,
          tools: this.archiveSettledTools(msg.state),
          uiRequests: this.uiRequestsFor(msg.state),
        });
        break;
      }
      case "snapshot_delta": {
        // 跨会话的增量直接丢弃：服务端切会话时会自己推全量 snapshot。
        // 不拦的话，新会话的 appended 会被拼到旧会话的 messages 后面（消息串会话）。
        if (this.snap.state && this.snap.state.conversationId !== msg.conversationId) {
          this.resetConversationView();
          return;
        }
        if (this.rev !== null && msg.baseRev !== this.rev) {
          // 修订链断裂（背压丢帧等），请求全量快照自愈。
          this.send({ type: "get_state" });
          return;
        }
        const base = this.snap.state;
        // 新追加进来的 assistant 消息就是刚定稿的那一条，pending 工具归属于它。
        // （多轮 ReAct 里“调工具的轮”与“给结论的轮”是两条消息，后者不应显示前者的工具。）
        const appended = [...(base?.messages ?? []), ...msg.appended];
        let archived = false;
        msg.appended.forEach((m, i) => {
          if (m.role === "assistant" && this.snap.tools.length > 0) {
            this.archiveTo(m.entryId ?? `pos-${msg.conversationId}-${(base?.messages.length ?? 0) + i}`, this.snap.tools);
            archived = true;
          }
        });
        const merged: UiState = {
          ...(base ?? msg.state),
          ...msg.state,
          messages: appended.map((m) => ({ ...m })),
          streamingMessage: base?.streamingMessage ?? null,
        };
        this.rev = msg.rev;
        this.patch({
          state: merged,
          conversations: merged.conversations,
          tools: archived ? [] : this.snap.tools,
        });
        break;
      }
      case "message_delta": {
        if (msg.channel === "thinking") {
          this.patch({ streamThinking: this.snap.streamThinking + msg.delta });
        } else {
          this.patch({ streamText: this.snap.streamText + msg.delta });
        }
        break;
      }
      case "tool_status": {
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
        this.patch({ runActive: true, tools: [], turnIndex: 0 });
        break;
      case "run_end":
        // willRetry 表示 SDK 会自动重试，本轮没真结束，保持 running。
        this.patch({
          runActive: msg.willRetry === true,
          tools: this.snap.state ? this.archiveSettledTools(this.snap.state) : [],
        });
        break;
      case "turn_start":
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
        this.patch({ notices: [...this.snap.notices.slice(-4), { level, text, at: Date.now() }] });
        break;
      }
      case "pong":
      default:
        break;
    }
  }

  /**
   * 清空当前会话视图。切/建会话时必须走这里：
   * 只重置 rev 不重置 state，会让新会话的 snapshot_delta 拼到旧会话的 messages 上。
   */
  private resetConversationView(): void {
    this.rev = null;
    this.patch({ state: null, streamText: "", streamThinking: "", tools: [], toolsByEntry: {}, runActive: false });
  }

  /**
   * 全量快照场景下的工具归档：消息数比上一快照增长，且新尾部是已定稿的 assistant 消息时，
   * 把 pending 工具归到那条消息。返回归档后应保留的 tools（仍在流式且未归档则保留）。
   */
  private archiveSettledTools(state: UiState): ToolView[] {
    if (this.snap.tools.length === 0) return [];
    const prevCount = this.snap.state?.messages.length ?? 0;
    const tail = state.messages.at(-1);
    const grew = state.messages.length > prevCount;
    if (!tail || tail.role !== "assistant" || !grew || state.streamingMessage) return this.snap.tools;
    this.archiveTo(tail.entryId ?? `pos-${state.conversationId}-${state.messages.length - 1}`, this.snap.tools);
    return [];
  }

  private archiveTo(key: string, tools: ToolView[]): void {
    if (this.snap.toolsByEntry[key]) return;
    this.snap = { ...this.snap, toolsByEntry: { ...this.snap.toolsByEntry, [key]: tools } };
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

  send(msg: ClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  /* ────────────── 类型化命令面（A 类） ────────────── */

  prompt(text: string, images?: { mimeType: string; data: string }[]) {
    this.send({ type: "prompt", text, images });
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
    this.send({ type: "new_conversation" });
    this.resetConversationView();
  }
  openConversation(conversationId: string) {
    this.send({ type: "open_conversation", conversationId });
    this.resetConversationView();
  }
  switchConversation(conversationId: string) {
    this.send({ type: "switch_conversation", conversationId });
    this.resetConversationView();
  }
  closeConversation(conversationId: string) {
    this.send({ type: "close_conversation", conversationId });
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
  const streaming = state.streamingMessage ?? (snap.streamText ? { role: "assistant" as const, text: snap.streamText } : null);
  if (state.isStreaming && streaming) messages.push(streaming);
  return messages;
}

export const piClient = new PiWsClient();
