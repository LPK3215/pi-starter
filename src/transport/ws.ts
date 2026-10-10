/**
 * pi-starter · WebSocket 传输层（双向 + 快照驱动 + 多路分级）
 *
 * 承接 pi-web-ui 的三大核心设计，但**收敛成单个可复用模块**（pi-web-ui 把它塞在 3576 行的 index.ts 里）：
 *
 *   1. 快照驱动：服务端是唯一事实源；客户端只按 `snapshot` / `snapshot_delta` 渲染，
 *      重连只需 `get_state` 重发全量。
 *   2. 多路传输分级：`snapshot*` 是权威状态，背压下**可丢弃**（客户端靠 rev 链断裂自愈）；
 *      `message_delta` / `tool_status` 是实时增量，**绕过背压永远可达**。
 *   3. 安全边界：默认只绑 loopback；升级前做 **Origin/Host 同权威校验**，防 DNS rebinding 与跨站 WS。
 *
 * 额外改进：
 *   - `serializeShared` 用 WeakMap 按对象身份缓存 stringify，N 个标签页共享一次序列化；
 *   - 未 attach 完成的命令进 pending 队列，attach 后按序回放，避免握手竞态丢命令；
 *   - 所有可调参数走 RuntimeConfig（.env 可覆盖），默认值全部偏保守。
 */

import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  CLIENT_MESSAGE_TYPES,
  isClientMessage,
  type ClientMessage,
  type ServerMessage,
  type UiApproval,
  type UiCapabilities,
  type UiExtensionRequest,
  type UiExtensionResponse,
  THINKING_LEVELS,
  isThinkingLevel,
} from "../protocol.js";
import type { RuntimeConfig } from "../config.js";
import type { BuiltAgent } from "../agent.js";
import type { ClientSession, SessionHub } from "../session-hub.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SettingsService } from "../settings.js";
import { searchKnowledge } from "../knowledge/index.js";
import { parsePromptImages } from "../prompt-images.js";
import { Metrics, metrics as defaultMetrics } from "../metrics.js";
import { buildCapabilityBase } from "../capabilities.js";
import { toUiModel } from "../models.js";
import { getLogger } from "../log.js";
import { AppError, clientErrorMessage } from "../errors.js";

/** 把毫秒耗时收成 3 位小数，用于日志（避免浮点噪声刷屏）。 */
function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/** 运行期依赖（由 server 入口装配后传入）。 */
export interface WsRuntime {
  agent: BuiltAgent;
  hub: SessionHub;
  cfg: RuntimeConfig;
  registry: ToolRegistry;
  settings: SettingsService;
  /** 待人类决策的审批请求出口（可选；不装审批时留空）。 */
  gate?: {
    resolve(
      requestId: string,
      response: { decision: string; scope?: string; modifiedArgs?: Record<string, unknown> },
    ): boolean;
    /** Conversation key that owns a pending request, so the response clears the right one. */
    conversationOf?(requestId: string): string | undefined;
  };
  /**
   * HITL 反问桥的应答入口（可选；不装时收到 extension_ui_response 回提示帧）。
   * 与 gate 同形：官方 `ctx.ui` 发出的请求按 id 挂起，客户端应答时由这里唤醒。
   */
  uiBridge?: {
    resolve(id: string, response: UiExtensionResponse): boolean;
  };
  serverVersion: string;
  /** 指标注册表，缺省用全局单例。 */
  metrics?: Metrics;
  /**
   * 业务方注册的自定义命令（扩展点）。
   *
   * 内置命令**不可被覆盖**（覆盖会让协议行为变得不可预测）；只有不在
   * `CLIENT_MESSAGE_TYPES` 里的 type 才会走这里查表。
   */
  commands?: Record<string, WsCommandSpec>;
  /** Embedder-supplied slash commands appended to the built-in four. */
  slashCommands?: UiCapabilities["commands"];
}

/** 业务方命令的处理上下文。 */
export interface WsCommandContext<TPayload = unknown> {
  /** 已 attach 的会话；未完成 attach 时为 undefined（命令仍会被调用）。 */
  session: ClientSession | undefined;
  /** 本连接的客户 id（未 attach 时为空串）。 */
  clientId: string;
  /** 回一帧给发起方。 */
  send: (msg: ServerMessage) => void;
  /**
   * 本帧的完整 payload（含 `type`）。用 `defineCommand<P>()` 声明命令时它就是 `P`，
   * 否则为 `unknown`，需要业务方自行断言。
   */
  payload: TPayload;
  /** 与内核命令同一份运行期依赖，业务方需要时可取 settings/registry/agent。 */
  runtime: WsRuntime;
}

/** 一个业务方自定义命令。 */
export interface WsCommandSpec<TPayload = unknown> {
  /** 人类可读描述，出现在能力目录里。 */
  describe?: string;
  /** 处理逻辑。抛错会被接住并回 error 帧，不会杀连接。 */
  handler: (ctx: WsCommandContext<TPayload>) => void | Promise<void>;
}

/** 自定义命令表。key 必须避开 `CLIENT_MESSAGE_TYPES` 里的全部内置名。 */
export type WsCommandRegistry = Record<string, WsCommandSpec<any>>;

/**
 * 声明一个带类型的自定义命令。
 *
 * 协议单源是封闭联合，所以业务方命令的类型只能自己声明；这个辅助函数让它**跟着 handler
 * 走**——写一次 `defineCommand<{a:number}>()`，`payload` 在 handler 里就是有类型的，
 * 不必每次手动断言。
 *
 * ```ts
 * const commands = {
 *   biz_sum: defineCommand<{ a: number; b: number }>({
 *     describe: "求和",
 *     handler: ({ payload, send }) =>
 *       send({ type: "notice", level: "info", text: String(payload.a + payload.b) }),
 *   }),
 * };
 * ```
 */
export function defineCommand<TPayload>(spec: {
  describe?: string;
  handler: (ctx: WsCommandContext<TPayload>) => void | Promise<void>;
}): WsCommandSpec<TPayload> {
  return spec;
}

/** 内置命令判别集合：由协议单源派生，避免第二份手写清单。 */
const BUILTIN_COMMAND_TYPES: ReadonlySet<string> = new Set<string>(CLIENT_MESSAGE_TYPES);

/** 列出已注册的自定义命令名（用于能力目录与冲突检测）。 */
export function customCommandNames(commands: WsCommandRegistry | undefined): string[] {
  return commands ? Object.keys(commands).sort() : [];
}

export interface WsServer {
  /** Broadcast an approval request to every connected client. */
  notifyApproval(request: UiApproval): void;
  /** Broadcast a HITL question (official extension_ui_request) to every connected client. */
  notifyUiRequest(request: UiExtensionRequest): void;
  /** Number of live connections. */
  readonly connectionCount: number;
  /**
   * 注册一个在 `close()` 时运行的清理函数。
   *
   * 业务方通过 `commands` 注册的处理器若持有定时器、子进程或缓存，需要跟着传输层一起回收。
   */
  addDisposer(fn: () => void): void;
  /** Graceful shutdown: stop heartbeat, close sockets, release the upgrade listener. */
  close(): Promise<void>;
}

/**
 * Built-in slash commands advertised to the client.
 *
 * These are *advertisements*: the client renders the menu and decides how to trigger them.
 * Embedders can append their own via `WsRuntime.slashCommands`.
 */
const DEFAULT_COMMANDS: UiCapabilities["commands"] = [
  { name: "/new", description: "Start a new conversation" },
  { name: "/model", description: "Switch the active model" },
  { name: "/abort", description: "Abort the current run" },
  { name: "/state", description: "Force a full state refresh" },
];

/** WeakMap-backed stringify cache: identical objects serialize once across tabs. */
const wireCache = new WeakMap<object, string>();

export function serializeShared(msg: ServerMessage): string {
  const hit = wireCache.get(msg);
  if (hit !== undefined) return hit;
  const wire = JSON.stringify(msg);
  wireCache.set(msg, wire);
  return wire;
}

/**
 * Same-authority check: the Origin host must equal the request Host (hostname + port).
 * Missing Origin (non-browser clients such as the CLI) is allowed.
 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  if (!host) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return originHost === host;
}

/** Build the capability catalog sent to clients. */
function buildCapabilities(runtime: WsRuntime): UiCapabilities {
  return {
    // 工具 / 技能 / 知识库与 REST `GET /capabilities` 共用同一整形函数（见 capabilities.ts），
    // 只有提示词模板 / 斜杠命令 / 计划模式默认值这三项是 WS 通道特有的。
    ...buildCapabilityBase({
      builtinTools: runtime.agent.builtinTools,
      tools: runtime.registry.catalog(),
      skills: runtime.agent.skills,
      knowledge: runtime.agent.knowledge,
    }),
    promptTemplates: runtime.agent.promptTemplates.map((t) => ({
      name: t.name,
      description: t.description,
    })),
    commands: [...DEFAULT_COMMANDS, ...(runtime.slashCommands ?? [])],
    planModeDefault: runtime.settings.get().planMode,
  };
}

/**
 * `hello` 之前允许排队的帧数上限。
 *
 * 客户端抢跑（握手帧还没到就先发命令）是常见现象，所以需要排队；但排多少必须有界——
 * `maxPayload` 只限制单帧字节数，不限帧数，一个永不发 `hello` 的连接可以持续灌小帧把
 * 内存堆满，而且这些命令在 `flushPending()` 之后仍会被依次执行。
 */
const MAX_PENDING_BEFORE_HELLO = 64;

/** One live WebSocket connection + its session binding. */
class ClientConn {
  clientId = "";
  attached = false;
  private cs: ClientSession | undefined;
  private readonly pending: ClientMessage[] = [];
  private snapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Consecutive snapshots dropped due to backpressure, reset on any successful send.
   * A client that stays saturated across many retries is not going to catch up — it keeps
   * its whole receive buffer alive while we keep rebuilding snapshots. Terminating it is
   * the only way to actually release the memory.
   */
  private consecutiveDrops = 0;

  constructor(
    private readonly ws: WebSocket,
    private readonly runtime: WsRuntime,
    private readonly metrics: Metrics,
  ) {}

  /** Outbound sink with backpressure-aware snapshot dropping. */
  readonly send = (msg: ServerMessage): void => {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const droppable = msg.type === "snapshot" || msg.type === "snapshot_delta";
    if (droppable && this.ws.bufferedAmount > this.runtime.cfg.backpressureBytes) {
      // Dropped: the client self-heals via the rev chain (get_state on gap).
      this.metrics.inc("snapshotsDroppedTotal");
      this.consecutiveDrops += 1;
      // 0 (or a misconfigured negative) disables termination — never kill on the first drop.
      const dropLimit = this.runtime.cfg.maxConsecutiveSnapshotDrops;
      if (dropLimit > 0 && this.consecutiveDrops >= dropLimit) {
        this.metrics.inc("slowClientsDroppedTotal");
        getLogger()
          .child({ component: "ws", clientId: this.clientId || "unattached" })
          .warn("客户端持续背压，断开连接", {
            consecutiveDrops: this.consecutiveDrops,
            bufferedBytes: this.ws.bufferedAmount,
          });
        // clearQueued + terminate releases the receive buffer immediately; a plain close
        // would keep buffering while the close handshake drags on.
        this.ws.terminate();
        return;
      }
      this.scheduleSnapshotRetry();
      return;
    }
    try {
      this.ws.send(serializeShared(msg));
      if (msg.type === "snapshot" || msg.type === "snapshot_delta") {
        this.metrics.inc("snapshotsSentTotal");
        // A successful write proves the client is draining; forgive earlier drops.
        this.consecutiveDrops = 0;
      }
    } catch {
      /* socket died mid-send; the close handler cleans up */
    }
  };

  private scheduleSnapshotRetry(): void {
    if (this.snapshotRetryTimer) return;
    this.snapshotRetryTimer = setTimeout(() => {
      this.snapshotRetryTimer = null;
      this.cs?.getState();
    }, this.runtime.cfg.snapshotRetryMs);
    this.snapshotRetryTimer.unref?.();
  }

  /** Entry point for every inbound frame. */
  handle(msg: ClientMessage): void {
    if (!this.attached && msg.type !== "hello") {
      // 握手前的帧要排队（客户端可能抢跑），但队列必须有界：`maxPayload` 只限制单帧大小，
      // 不限帧数——一个不发 hello 的连接可以持续灌小帧把内存堆满，且这些命令在
      // `flushPending()` 后仍会被依次执行。超限直接断开，语义上等同于握手失败。
      if (this.pending.length >= MAX_PENDING_BEFORE_HELLO) {
        getLogger()
          .child({ component: "ws", clientId: this.clientId || "unattached" })
          .warn("握手前 pending 队列超限，断开连接", {
            pending: this.pending.length,
            limit: MAX_PENDING_BEFORE_HELLO,
            command: msg.type,
          });
        this.metrics.inc("protocolErrorsTotal");
        // 1008 = policy violation。直接 terminate：握手都没完成，没有需要保留的接收缓冲。
        this.pending.length = 0;
        this.ws.terminate();
        return;
      }
      this.pending.push(msg);
      return;
    }
    void this.dispatch(msg);
  }

  private async dispatch(msg: ClientMessage): Promise<void> {
    const { runtime } = this;
    // Per-command correlation id + access line, so a full WS request can be pulled by request_id.
    const requestId = randomUUID();
    const startedAt = performance.now();
    const cmdLog = getLogger().child({
      component: "ws",
      clientId: this.clientId || "unattached",
      requestId,
    });
    cmdLog.debug("ws command received", { command: msg.type });

    // Extension point: business-registered commands. Built-ins are decided by the union in
    // protocol.ts, so a custom type can never shadow one — that keeps protocol behaviour
    // predictable no matter what the embedder registers.
    if (!BUILTIN_COMMAND_TYPES.has(msg.type)) {
      try {
        await this.runCustom(msg.type, msg);
      } finally {
        cmdLog.info("ws command completed", { command: msg.type, durationMs: roundMs(performance.now() - startedAt) });
      }
      return;
    }

    try {
      switch (msg.type) {
        case "hello": {
          const previousClientId = this.clientId;
          this.clientId = msg.clientId?.trim() || randomUUID();
          // 同一 socket 二次 `hello`（换了 clientId）必须先卸掉旧身份：`hub.attach` 只 dispose
          // **同 id** 的旧会话，旧 id 的 ClientSession 及其会话订阅会永远留在 `hub.sessions` 里；
          // 而 socket 关闭时的 `dispose()` 只按最后的 clientId 清理，那些旧会话就成了无界泄漏。
          if (previousClientId && previousClientId !== this.clientId) {
            runtime.hub.detach(previousClientId);
            this.cs = undefined;
          }
          // `ready` MUST be the first frame: attaching a conversation immediately emits
          // `conversations` + `snapshot`, and a strict client cannot interpret those before
          // it knows its clientId, protocol version and capabilities.
          this.send({
            type: "ready",
            clientId: this.clientId,
            protocolVersion: runtime.cfg.protocolVersion,
            clientProtocolVersion: msg.protocolVersion,
            serverVersion: runtime.serverVersion,
            engine: "pi",
            capabilities: buildCapabilities(runtime),
          });
          this.cs = await runtime.hub.attach(this.clientId, this.send);
          this.attached = true;
          // Align the live session with the registry (settings may have disabled extra tools).
          this.cs.applyToolSet(runtime.registry.enabledNames());
          // Apply the persisted thinking level so a reconnect restores the chosen level.
          const level = runtime.settings.get().thinkingLevel;
          if (isThinkingLevel(level)) this.cs?.setThinking(level);
          this.flushPending();
          break;
        }
        case "ping":
          this.send({ type: "pong" });
          break;
        case "get_state":
          this.cs?.getState();
          break;
        case "prompt":
          if (!msg.text?.trim()) {
            this.send({ type: "error", message: "prompt text is required" });
            break;
          }
          this.metrics.inc("promptsTotal");
          await this.cs?.prompt(msg.text, parsePromptImages(msg.images), msg.replaceEntryId);
          break;
        case "steer":
          if (!msg.text?.trim()) {
            this.send({ type: "error", message: "steer text is required" });
            break;
          }
          // Steering is only meaningful mid-run. When idle, steer() reports that as a
          // conflict rather than queueing a message that would never be delivered.
          await this.cs?.steer(msg.text, parsePromptImages(msg.images));
          break;
        case "follow_up":
          if (!msg.text?.trim()) {
            this.send({ type: "error", message: "follow_up text is required" });
            break;
          }
          await this.cs?.followUp(msg.text, parsePromptImages(msg.images));
          break;
        case "abort_compaction":
          this.cs?.abortCompaction();
          break;
        case "abort":
          await this.cs?.abort();
          break;
        case "compact_context": {
          // Failures come back as an outcome object, not an exception: this is a user-initiated
          // action, and "上下文还很小，压不划算" is information the UI should show, not an error.
          const outcome = await this.cs?.compact(msg.instructions);
          if (outcome && !outcome.ok && outcome.reason) {
            this.metrics.inc("dispatchErrorsTotal");
            this.send({ type: "notice", level: "warn", text: outcome.reason });
          }
          break;
        }
        case "draft_update":
          // Drafts are client-local for now; accepted for forward compatibility.
          break;
        case "new_conversation":
          await this.cs?.newConversation();
          break;
        case "open_conversation": {
          if (!this.cs || !this.clientId) {
            this.send({ type: "error", message: "not attached" });
            break;
          }
          if (!msg.conversationId?.trim()) {
            this.send({ type: "error", message: "conversationId is required" });
            break;
          }
          try {
            await runtime.hub.openConversation(this.clientId, msg.conversationId);
          } catch (err) {
            const message = clientErrorMessage(err, "无法打开该会话");
            this.send({ type: "error", message });
          }
          break;
        }
        case "switch_conversation":
          if (!this.cs?.switchConversation(msg.conversationId)) {
            this.send({ type: "error", message: `unknown conversation ${msg.conversationId}` });
          }
          break;
        case "close_conversation":
          if (!this.cs?.closeConversation(msg.conversationId)) {
            this.send({ type: "notice", level: "warn", text: "cannot close the last conversation" });
          }
          break;
        case "delete_conversation":
          // 与 close 不同：这条会真删磁盘会话文件，失败必须明确回帧而不是静默。
          try {
            if (!this.clientId) throw new AppError("bad_request", "not attached");
            runtime.hub.deleteConversation(this.clientId, msg.conversationId);
          } catch (err) {
            const message = clientErrorMessage(err, "无法删除该会话");
            this.send({ type: "error", message });
          }
          break;
        case "list_conversations":
          this.send({ type: "conversations", items: this.cs?.listConversations() ?? [] });
          break;
        case "rename_conversation":
        case "rollback_conversation":
        case "edit_message":
        case "set_label":
        case "fork_conversation": {
          if (!this.cs || !this.clientId) {
            this.send({ type: "error", message: "not attached" });
            break;
          }
          if (!msg.conversationId?.trim()) {
            this.send({ type: "error", message: "conversationId is required" });
            break;
          }
          try {
            if (msg.type === "rename_conversation") {
              if (typeof msg.title !== "string") {
                this.send({ type: "error", message: "title is required" });
                break;
              }
              runtime.hub.renameConversation(this.clientId, msg.conversationId, msg.title);
              this.send({ type: "conversations", items: this.cs.listConversations() });
            } else if (msg.type === "rollback_conversation") {
              if (!msg.entryId?.trim()) {
                this.send({ type: "error", message: "entryId is required" });
                break;
              }
              await runtime.hub.rollbackConversation(this.clientId, msg.conversationId, msg.entryId, {
                summarize: msg.summarize,
                instructions: msg.instructions,
              });
            } else if (msg.type === "edit_message") {
              if (!msg.entryId?.trim()) {
                this.send({ type: "error", message: "entryId is required" });
                break;
              }
              runtime.hub.editConversation(this.clientId, msg.conversationId, msg.entryId);
            } else if (msg.type === "set_label") {
              if (!msg.entryId?.trim()) {
                this.send({ type: "error", message: "entryId is required" });
                break;
              }
              runtime.hub.setLabel(this.clientId, msg.conversationId, msg.entryId, msg.label);
            } else {
              await runtime.hub.forkConversation(this.clientId, msg.conversationId, msg.entryId);
            }
          } catch (err) {
            const message = clientErrorMessage(err, "无法修改该会话");
            this.send({ type: "error", message });
          }
          break;
        }
        case "list_models": {
          const models = await runtime.agent.listModels();
          this.send({
            type: "models",
            models: models.map(toUiModel),
            current: `${runtime.agent.model.provider}/${runtime.agent.model.id}`,
          });
          break;
        }
        case "set_model": {
          if (typeof msg.modelId !== "string" || !msg.modelId.trim()) {
            this.send({ type: "error", message: "set_model 需要非空的 modelId（`provider/modelId`）" });
            break;
          }
          try {
            // Route through the hub so every conversation AND the shared session switch
            // together; a client-side switch must not leave other conversations stale.
            await runtime.hub.setModel(msg.modelId);
            const models = await runtime.agent.listModels();
            const current = runtime.agent.model;
            this.send({
              type: "models",
              models: models.map(toUiModel),
              current: `${current.provider}/${current.id}`,
            });
          } catch (err) {
            this.send({ type: "error", message: clientErrorMessage(err, "切换模型失败") });
          }
          break;
        }
        case "set_thinking":
          // Validate before casting: the SDK narrows ThinkingLevel, so an arbitrary client
          // string would otherwise be forced through an unchecked cast.
          if (!isThinkingLevel(msg.level)) {
            this.send({
              type: "error",
              message: `invalid thinking level ${msg.level}, expected one of ${THINKING_LEVELS.join(" | ")}`,
            });
            break;
          }
          this.cs?.setThinking(msg.level);
          runtime.settings.patch({ thinkingLevel: msg.level });
          break;
        case "cycle_model": {
          try {
            const next = await runtime.hub.cycleModel();
            if (!next) {
              this.send({ type: "error", message: "没有可用的模型轮换列表（需配 scopedModels / PI_SCOPED_MODELS）" });
              break;
            }
            const models = await runtime.agent.listModels();
            this.send({
              type: "models",
              models: models.map(toUiModel),
              current: `${next.provider}/${next.id}`,
            });
          } catch (err) {
            this.send({ type: "error", message: clientErrorMessage(err, "轮换模型失败") });
          }
          break;
        }
        case "cycle_thinking": {
          const level = this.cs?.cycleThinking();
          if (typeof level === "string" && isThinkingLevel(level)) {
            runtime.settings.patch({ thinkingLevel: level });
          }
          break;
        }
        case "get_capabilities":
          this.send({ type: "capabilities", capabilities: buildCapabilities(runtime) });
          break;
        case "set_tool_enabled": {
          // 显式校验而不是靠 `undefined` 落到 else 分支：漏传/传错 `enabled` 会**静默禁用**该工具
          // 并回 ok，而 REST 同输入返回 400。两条通道对同一动作的安全语义必须一致。
          if (typeof msg.name !== "string" || typeof msg.enabled !== "boolean") {
            this.send({ type: "error", message: "set_tool_enabled 需要 { name: string, enabled: boolean }" });
            break;
          }
          const ok = runtime.registry.setEnabled(msg.name, msg.enabled);
          if (!ok) {
            this.send({ type: "error", message: `unknown tool ${msg.name}` });
            break;
          }
          // Apply to the live sessions, not just the registry, so the toggle really takes effect.
          this.cs?.applyToolSet(runtime.registry.enabledNames());
          this.send({ type: "capabilities", capabilities: buildCapabilities(runtime) });
          break;
        }
        case "search_knowledge": {
          const hits = searchKnowledge(runtime.agent.knowledge, msg.query).map((hit) => ({
            name: hit.name,
            title: hit.title,
            score: hit.score,
            snippet: hit.snippet,
          }));
          this.send({ type: "knowledge_hits", query: msg.query, hits });
          break;
        }
        case "approval_response": {
          // Resolve BEFORE clearing: the gate drops the pending entry on resolve, so the
          // owning conversation must be captured first.
          const ownerKey = runtime.gate?.conversationOf?.(msg.requestId);
          const handled = runtime.gate?.resolve(msg.requestId, {
            decision: msg.decision,
            scope: msg.scope,
            modifiedArgs: msg.modifiedArgs,
          });
          if (!handled) {
            // The gate no longer tracks this id (already answered by another tab, or timed out).
            // Do NOT bail out here: the conversation may still hold a stale card in its snapshot,
            // and leaving it would trap the UI behind an approval no client can dismiss.
            this.send({ type: "notice", level: "warn", text: "no pending approval for that id" });
          }
          // Clear the approval on the conversation that raised it. Falling back to the active
          // conversation keeps single-conversation clients working when no owner is reported.
          const owner = ownerKey ? this.cs?.get(ownerKey) : undefined;
          if (owner) owner.clearApproval();
          else this.cs?.active?.clearApproval();
          break;
        }
        case "extension_ui_response": {
          // 按 id 唤醒官方 ctx.ui 挂起的对话框。未知 id = 已超时/已被其它标签页答过/伪造。
          const handled = runtime.uiBridge?.resolve(msg.response.id, msg.response);
          if (!handled) {
            this.send({ type: "notice", level: "warn", text: "no pending ui request for that id" });
          }
          break;
        }
        case "get_settings":
          this.send({ type: "settings_state", settings: runtime.settings.get() });
          break;
        case "set_plan_mode": {
          // The plan-mode gate lives in an extension keyed by the SDK session id, so this
          // command must resolve a real conversation first: toggling "the mode" without a
          // conversation would silently do nothing.
          const target = msg.conversationId?.trim()
            ? this.cs?.get(msg.conversationId)
            : this.cs?.active;
          if (!target) {
            this.send({ type: "error", message: "no conversation to set plan mode on" });
            break;
          }
          const next = target.setPlanMode(msg.enabled);
          this.send({
            type: "notice",
            level: "info",
            text: next ? "计划模式已开启：只规划，不实施" : "计划模式已关闭",
          });
          this.send({ type: "capabilities", capabilities: buildCapabilities(runtime) });
          break;
        }
        case "set_settings": {
          try {
            const settings = runtime.settings.patch(msg.settings);
            // Settings that change live behaviour must be pushed into the running sessions,
            // otherwise accepting them would be a no-op until restart.
            const disabled = new Set(settings.disabledTools);
            for (const name of runtime.registry.list().map((spec) => spec.name)) {
              runtime.registry.setEnabled(name, !disabled.has(name));
            }
            this.cs?.applyToolSet(runtime.registry.enabledNames());
            // Some settings cannot be hot-applied: the skill/knowledge catalogs are baked into
            // the system prompt when the agent is assembled. Accepting the change and staying
            // silent would be the worst outcome — it looks applied and isn't. Say so instead.
            const restartOnly = (["builtinKnowledge", "builtinSkills", "promptTemplate"] as const).filter(
              (key) => key in msg.settings,
            );
            if (restartOnly.length > 0) {
              this.send({
                type: "notice",
                level: "info",
                text: `${restartOnly.join(" / ")} 需要重启服务后生效（它们在组装时写进系统提示词，无法热切换）`,
              });
            }
            this.send({ type: "settings_state", settings });
          } catch (err) {
            this.send({ type: "error", message: clientErrorMessage(err, "更新设置失败") });
          }
          break;
        }
      }
    } catch (err) {
      // Never let one bad command kill the connection: report and keep serving.
      this.metrics.inc("dispatchErrorsTotal");
      // 日志记**原始** message（logger 会做值级脱敏），推给客户端的必须是脱敏后的文案：
      // 未经标记的 AppError 与未知 SDK 异常都可能带绝对路径、连接串等内部信息。
      const raw = err instanceof Error ? err.message : String(err);
      cmdLog.error("ws command failed", {
        command: msg.type,
        error: raw,
        durationMs: roundMs(performance.now() - startedAt),
      });
      this.send({ type: "error", message: clientErrorMessage(err) });
    } finally {
      cmdLog.info("ws command completed", { command: msg.type, durationMs: roundMs(performance.now() - startedAt) });
    }
  }

  /**
   * 运行一个业务方注册的命令。
   *
   * 未注册时**必须**明确报错：旧实现落到`switch` 的default 静默丢弃，前端会一直
   * 等一个永远不会来的响应，排查成本极高。
   */
  private async runCustom(type: string, raw: unknown): Promise<void> {
    const spec = this.runtime.commands?.[type];
    if (!spec) {
      this.metrics.inc("protocolErrorsTotal");
      getLogger()
        .child({ component: "ws", clientId: this.clientId || "unattached" })
        .warn("未注册的命令", { command: type });
      this.send({
        type: "error",
        message: `unknown command: ${type}${this.suggest(type)}`,
      });
      return;
    }
    try {
      await spec.handler({
        session: this.cs,
        clientId: this.clientId,
        send: (m) => this.send(m),
        payload: raw as never,
        runtime: this.runtime,
      });
    } catch (err) {
      // A failing business command must not take the connection down.
      this.metrics.inc("dispatchErrorsTotal");
      const raw = err instanceof Error ? err.message : String(err);
      getLogger()
        .child({ component: "ws", clientId: this.clientId || "unattached" })
        .error("自定义命令处理失败", { command: type, error: raw });
      // 业务命令是**可控边界**：`defineCommand` 的作者自己决定抛什么、给用户看什么
      // （扩展契约，由 `extensions.test.ts` 锁定）。所以这里保留原有文案转发，
      // 只把「脚手架自己生成的内部 AppError」脱敏——那才是会漏路径/连接串的一类。
      this.send({
        type: "error",
        message: err instanceof AppError ? err.clientMessage() : raw,
      });
    }
  }

  /** 未注册时给出"你是不是想发X"式的提示，避免最常见的手写错误被当成未知命令。 */
  private suggest(type: string): string {
    const names = customCommandNames(this.runtime.commands);
    if (names.length === 0) return "";
    const hit = names.find((n) => n.startsWith(type.slice(0, 3)) || type.startsWith(n.slice(0, 3)));
    return hit ? ` (did you mean "${hit}"?)` : ` (registered: ${names.join(", ")})`;
  }

  private flushPending(): void {
    const queued = this.pending.splice(0, this.pending.length);
    for (const msg of queued) this.handle(msg);
  }

  onMessage(data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    } catch {
      this.metrics.inc("protocolErrorsTotal");
      this.send({ type: "error", message: "invalid JSON frame" });
      return;
    }
    if (!isClientMessage(parsed)) {
      this.metrics.inc("protocolErrorsTotal");
      this.send({ type: "error", message: "unknown message type" });
      return;
    }
    this.handle(parsed);
  }

  dispose(): void {
    if (this.snapshotRetryTimer) {
      clearTimeout(this.snapshotRetryTimer);
      this.snapshotRetryTimer = null;
    }
    if (this.clientId) this.runtime.hub.detach(this.clientId);
  }
}

/** Attach the WS endpoint to an existing HTTP server. */
export function attachWebSocket(server: HttpServer, runtime: WsRuntime): WsServer {
  const wss = new WebSocketServer({
    noServer: true,
    // Compress large snapshots only; tiny messages skip the deflate cost.
    perMessageDeflate: { threshold: 16 * 1024 },
    // Cap inbound frames: client -> server messages are small commands, so a 1 MiB ceiling
    // stops a hostile or buggy client from forcing a huge JSON.parse allocation.
    maxPayload: 1024 * 1024,
  });
  const conns = new Set<ClientConn>();
  const disposers: Array<() => void> = [];
  const metrics = runtime.metrics ?? defaultMetrics;
  metrics.setGauge("wsConnections", conns.size);

  const onUpgrade = (req: import("node:http").IncomingMessage, socket: import("node:net").Socket, head: Buffer): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== runtime.cfg.wsPath) {
      socket.destroy();
      return;
    }
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };
  server.on("upgrade", onUpgrade);

  wss.on("connection", (ws: WebSocket) => {
    const conn = new ClientConn(ws, runtime, metrics);
    conns.add(conn);
    metrics.inc("wsConnectionsTotal");
    const state = ws as WebSocket & { __piAlive?: boolean };
    state.__piAlive = true;
    ws.on("message", (data: RawData) => conn.onMessage(data));
    ws.on("pong", () => {
      state.__piAlive = true;
    });
    ws.on("close", () => {
      conn.dispose();
      conns.delete(conn);
      // Derive the gauge from the live set so it can never drift from reality.
      metrics.setGauge("wsConnections", conns.size);
    });
    ws.on("error", () => {
      /* handled by close */
    });
  });

  // Heartbeat: terminate sockets that missed a pong cycle, so dead tabs do not leak sessions.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const state = ws as WebSocket & { __piAlive?: boolean };
      if (state.__piAlive === false) {
        ws.terminate();
        continue;
      }
      state.__piAlive = false;
      try {
        ws.ping();
      } catch {
        /* socket already gone */
      }
    }
  }, runtime.cfg.heartbeatIntervalMs);
  heartbeat.unref?.();

  return {
    notifyApproval(request: UiApproval): void {
      for (const conn of conns) conn.send({ type: "approval_request", request });
    },
    notifyUiRequest(request: UiExtensionRequest): void {
      for (const conn of conns) conn.send({ type: "extension_ui_request", request });
    },
    get connectionCount(): number {
      return conns.size;
    },
    addDisposer(fn: () => void): void {
      disposers.push(fn);
    },
    async close(): Promise<void> {
      clearInterval(heartbeat);
      // Embedder cleanup runs first — it may still want to push a final frame.
      for (const fn of disposers.splice(0, disposers.length)) {
        try {
          fn();
        } catch (err) {
          getLogger().warn("WS 扩展清理失败，已跳过", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      server.off("upgrade", onUpgrade);
      for (const conn of conns) conn.dispose();
      conns.clear();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
