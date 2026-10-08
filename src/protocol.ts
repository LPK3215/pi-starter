/**
 * pi-starter · 协议单源（★ single source of truth）
 *
 * 定义 client ↔ server 的**全部**消息类型与快照结构。新增字段只改这里，
 * 前后端各自 `import type`，杜绝协议散落在翻译表里（pi-web-ui 的 protocol.ts 同思路，
 * 但按「垂直 Agent 脚手架」裁剪：去掉编码助手专属的终端 / SCM / 插件市场 / DSH 双引擎命令）。
 *
 * 三类消息闭环：
 *   A. ClientMessage  客户端 → 服务端命令（dispatch）
 *   B. ServerMessage  服务端 → 客户端推送（快照 + delta + 应答）
 *   C. UiState        服务端唯一事实源（客户端只按它渲染）
 *
 * 版本协商：客户端 `hello.protocolVersion` ↔ 服务端 `ready.protocolVersion`，
 * 不一致时服务端在 ready 里回带自身版本，客户端自行决定降级或断开。
 */

/** 当前线协议版本。改动不兼容字段时 +1。 */
export const PROTOCOL_VERSION = 1;

/* ────────────────────────── 快照结构（C 类） ────────────────────────── */

/** Light projection of a conversation message for UI rendering. */
export interface UiMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
  /**
   * 会话树上这条消息的 id。回退、编辑、分叉都用它，不传文件路径。
   * 没有会话树的旧快照可以没有这个字段。
   */
  entryId?: string;
}

/** Model descriptor carried in the snapshot. */
export interface UiModel {
  provider: string;
  id: string;
  name: string;
}

/**
 * Context-budget state derived from the same estimator the trim planner uses.
 * Lets the client show "context 82% full, compaction recommended" without duplicating the maths.
 */
export interface UiContext {
  /** Estimated tokens currently held by the conversation. */
  tokens: number;
  /** Soft cap (context window − reserve). 0 when the model window is unknown. */
  softCap: number;
  /** tokens / softCap clamped to [0,1]; 0 when softCap is unknown. */
  usage: number;
  /** Whether a trim/compaction is warranted right now. */
  overBudget: boolean;
}

/** Token / cost statistics carried in the snapshot. */
export interface UiStats {
  input: number;
  output: number;
  total: number;
  cost: number;
  /** 上下文软上限（模型窗口 - reserve），0 表示未知。 */
  softCap: number;
  /** 估算的当前上下文占用 token，用于 UI 进度条。 */
  contextTokens: number;
  /** 上下文预算状态（含进度比例与是否超限），与裁剪器同源。 */
  context: UiContext;
}

/** Pending message queues surfaced to the client. */
export interface UiQueue {
  steering: string[];
  followUp: string[];
}

/** A tool surfaced to the client (metadata only, schema 不进快照). */
export interface UiTool {
  name: string;
  description: string;
  /** 来源：builtin（SDK）/ custom（脚手架登记）/ dynamic（运行时装配）。 */
  source: "builtin" | "custom" | "dynamic";
  /** 能力标签，供 UI 分组与策略匹配（如 fs.write / net / shell）。 */
  capabilities: string[];
  /** 是否当前激活。 */
  enabled: boolean;
}

/** Approval request awaiting a human decision. */
export interface UiApproval {
  requestId: string;
  toolName: string;
  /** 命中的规则 id（内置为 `builtin:<id>`）。 */
  ruleId: string;
  reason: string;
  /** 触发审批的字段摘录（command / path / params）。 */
  preview: string;
}

/** Conversation summary for the cross-conversation list. */
export interface UiConversation {
  id: string;
  title: string;
  active: boolean;
  streaming: boolean;
  messageCount: number;
  updatedAt: number;
  /**
   * 在磁盘上、当前连接还没加载。为 true 时 `switch_conversation` 不会切过去，
   * 要发 `open_conversation`（只带 id，不带文件路径）。
   */
  dormant?: boolean;
}

/**
 * Server-authored authoritative state snapshot.
 * The client renders from this; on reconnect it requests a fresh full snapshot.
 */
export interface UiState {
  clientId: string;
  cwd: string;
  sessionId: string;
  conversationId: string;
  /** Monotonic revision counter for the snapshot chain. */
  rev: number;
  messages: UiMessage[];
  /**
   * True when `messages` was capped to the most recent MAX_SNAPSHOT_MESSAGES entries.
   * Lets the UI show "load older" instead of silently pretending the history ends here.
   * The server always retains the full history.
   */
  messagesTruncated?: boolean;
  /** Total chat message count on the server, even when `messages` is capped. */
  totalMessages?: number;
  /** Partial assistant message currently streaming, or null when idle. */
  streamingMessage: UiMessage | null;
  isStreaming: boolean;
  model: UiModel;
  thinkingLevel: string;
  /** 当前激活的工具名（供旧客户端兼容；新客户端读 capabilities.tools）。 */
  tools: string[];
  queue: UiQueue;
  stats: UiStats;
  /** 待人类决策的审批请求，null 表示无。 */
  pendingApproval: UiApproval | null;
  /**
   * 本对话是否处于计划模式（只规划、不实施）。
   *
   * 权威值在快照里而不是让客户端自己记：模式是**服务端**在 `tool_call` 上强制的，
   * 客户端猜错就会显示出「可以写」而实际被拒的状态。
   */
  planMode: boolean;
  /** 运行中对话列表（含自身）。 */
  conversations: UiConversation[];
}

/** Light state used by `snapshot_delta` (messages are carried separately). */
export type UiStateLight = Omit<UiState, "messages" | "streamingMessage">;

/* ────────────────────────── A 类：客户端命令 ────────────────────────── */

/** 审批决策三态。 */
export type ApprovalDecision = "allow" | "deny" | "modify";

/** 审批放行范围：once 仅本次 / category 同档位 / all 本对话全部。 */
export type ApprovalScope = "once" | "category" | "all";

/** Client → server commands. */
export type ClientMessage =
  // 连接与状态
  | { type: "hello"; clientId?: string; protocolVersion?: number; locale?: string }
  | { type: "get_state" }
  | { type: "ping" }
  // 对话运行
  | { type: "prompt"; text: string }
  | { type: "abort" }
  /**
   * 主动压缩上下文。
   *
   * 之前只有 SDK 自动触发的被动 notice（`compaction_start` / `compaction_end`），
   * 客户端看得见「压缩发生了」却**无法主动发起**——上下文快满时只能等模型自己决定。
   * `instructions` 用来告诉它该保留什么（"保留所有文件路径与最终结论"）。
   */
  | { type: "compact_context"; instructions?: string }
  | { type: "draft_update"; text: string }
  // 会话编排
  | { type: "new_conversation" }
  | { type: "open_conversation"; conversationId: string }
  | { type: "switch_conversation"; conversationId: string }
  | { type: "close_conversation"; conversationId: string }
  | { type: "list_conversations" }
  | { type: "rename_conversation"; conversationId: string; title: string }
  | { type: "rollback_conversation"; conversationId: string; entryId: string }
  | { type: "edit_message"; conversationId: string; entryId: string }
  | { type: "fork_conversation"; conversationId: string; entryId?: string }
  // 模型与思考
  | { type: "list_models" }
  | { type: "set_model"; modelId: string }
  | { type: "set_thinking"; level: string }
  // 能力目录
  | { type: "get_capabilities" }
  | { type: "set_tool_enabled"; name: string; enabled: boolean }
  | { type: "search_knowledge"; query: string }
  // 审批
  | {
      type: "approval_response";
      requestId: string;
      decision: ApprovalDecision;
      scope?: ApprovalScope;
      /** decision = modify 时改写后的工具入参（JSON）。 */
      modifiedArgs?: Record<string, unknown>;
    }
  // 运行模式
  | { type: "set_plan_mode"; enabled: boolean; conversationId?: string }
  // 设置
  | { type: "get_settings" }
  | { type: "set_settings"; settings: Record<string, unknown> };

/* ────────────────────────── B 类：服务端推送 ────────────────────────── */

/** Server → client messages. */
export type ServerMessage =
  | {
      type: "ready";
      clientId: string;
      protocolVersion: number;
      serverVersion: string;
      /** 客户端 hello 携带的版本，便于前端提示「需刷新」。 */
      clientProtocolVersion?: number;
      engine: string;
      capabilities: UiCapabilities;
    }
  | { type: "snapshot"; state: UiState }
  | {
      type: "snapshot_delta";
      conversationId: string;
      rev: number;
      baseRev: number;
      appended: UiMessage[];
      state: UiStateLight;
    }
  | {
      type: "message_delta";
      conversationId: string;
      seq: number;
      channel: "text" | "thinking";
      delta: string;
    }
  | {
      type: "tool_status";
      conversationId: string;
      toolCallId: string;
      toolName: string;
      phase: "start" | "end";
      isError?: boolean;
      durationMs?: number;
    }
  /** 一轮开始（agent_start）。与 run_end 成对，让客户端无需轮询 isStreaming。 */
  | { type: "run_start"; conversationId: string }
  /**
   * 一轮结束（agent_end）——**本轮唯一的权威结束信号**。
   *
   * 以往内核不发这个帧，客户端只能靠快照里的 `isStreaming` 轮询推断轮次是否结束，
   * 既拿不到 stopReason，也无法区分「正常结束」与「SDK 将要自动重试」。
   * SDK 的 `agent_end` 本身不带 stopReason，由messages 里最后一条 assistant 消息推导。
   */
  | {
      type: "run_end";
      conversationId: string;
      /** 最后一条 assistant 消息的停止原因（SDK 未提供时留空）。 */
      stopReason?: string;
      /** SDK 将自动重试——此时这一轮并未真正终结，不应显示为「已完成」。 */
      willRetry?: boolean;
      /** 中止（用户主动 abort）——与「正常结束」区分开。 */
      aborted?: boolean;
    }
  /** 工具的流式中间输出（tool_execution_update）。长工具运行期间靠它证明「还在动」。 */
  | {
      type: "tool_delta";
      conversationId: string;
      seq: number;
      toolCallId: string;
      toolName: string;
      delta: string;
    }
  /**
   * 一次 ReAct 迭代开始（SDK `turn_start`）。
   *
   * 与 `run_start` 的区别：一次 `prompt()` 里可能有**多轮**迭代（模型调用工具后继续想），
   * `run_start` 只在整轮开始时来一次。客户端要画「正在第几步」的进度条就得靠它。
   *
   * `turnIndex` 是**本连接内自增**的序号：SDK 投给会话订阅的事件里没有轮次下标
   * （`turn_start` 只有 `type`），所以这里由服务端自己数，避免编造一个「看起来像 SDK 的」值。
   */
  | { type: "turn_start"; conversationId: string; turnIndex: number }
  /**
   * 一次 ReAct 迭代结束（SDK `turn_end`）。
   *
   * 带 `stopReason` 与本轮工具调用数，便于客户端在多轮场景里显示「第 N 步结束、调了 M 个工具」。
   * 停止原因同样来自最后一条 assistant 消息——SDK 的 `turn_end` 不直接带这个字段。
   */
  | {
      type: "turn_end";
      conversationId: string;
      turnIndex: number;
      /** 最后一条 assistant 消息的停止原因（SDK 未提供时留空）。 */
      stopReason?: string;
      /** 本轮执行的工具结果条数。 */
      toolResults?: number;
    }
  | { type: "conversations"; items: UiConversation[] }
  /**
   * 编辑用户消息之后，原文交回输入框。服务端不自动再发一轮。
   * 这条消息和它后面的内容已经离开当前路径。
   */
  | { type: "edit_ready"; conversationId: string; entryId: string; text: string }
  | { type: "models"; models: UiModel[]; current: string }
  | { type: "capabilities"; capabilities: UiCapabilities }
  | { type: "settings_state"; settings: Record<string, unknown> }
  | { type: "knowledge_hits"; query: string; hits: UiKnowledgeHit[] }
  | { type: "approval_request"; request: UiApproval }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "pong" }
  | { type: "error"; message: string };

/** 能力目录：工具 / 技能 / 知识库 / 斜杠命令。 */
export interface UiCapabilities {
  builtinTools: string;
  tools: UiTool[];
  skills: { name: string; description: string }[];
  knowledge: { name: string; title: string; description: string }[];
  commands: { name: string; description: string }[];
  /**
   * 新会话的默认计划模式档位（settings.planMode）。
   * 单个对话的实际档位看快照里的 `planMode`——这里是默认值，不是当前值。
   */
  planModeDefault: boolean;
}

export interface UiKnowledgeHit {
  name: string;
  title: string;
  score: number;
  snippet: string;
}

/* ────────────────────────── 类型守卫 ────────────────────────── */

/** Narrow an unknown payload to a ClientMessage (only checks the discriminant). */
export function isClientMessage(value: unknown): value is ClientMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** All known client command discriminants (for dispatch exhaustiveness checks). */
export const CLIENT_MESSAGE_TYPES = [
  "hello",
  "get_state",
  "ping",
  "prompt",
  "abort",
  "draft_update",
  "new_conversation",
  "open_conversation",
  "switch_conversation",
  "close_conversation",
  "list_conversations",
  "rename_conversation",
  "rollback_conversation",
  "edit_message",
  "fork_conversation",
  "list_models",
  "set_model",
  "set_thinking",
  "get_capabilities",
  "set_tool_enabled",
  "search_knowledge",
  "approval_response",
  "set_plan_mode",
  "get_settings",
  "set_settings",
  "compact_context",
] as const satisfies readonly ClientMessage["type"][];

/** Compile-time guard: every ClientMessage discriminant is listed above. */
type _ClientTypesCovered = Exclude<ClientMessage["type"], (typeof CLIENT_MESSAGE_TYPES)[number]>;
const _assertAllClientTypesListed: _ClientTypesCovered extends never ? true : never = true;
void _assertAllClientTypesListed;
