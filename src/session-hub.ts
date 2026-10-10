/**
 * pi-starter · 会话编排入口（`SessionHub`）
 *
 * 分层（借鉴 pi-web-ui，但按脚手架定位收窄）：
 *   SessionHub    每个客户端 id 一个 ClientSession，负责 open/close 与并发去重
 *   ClientSession 内含 N 个 Conversation，任一时刻一个 active
 *   Conversation  绑定一个 AgentSession 订阅，负责事件翻译 + 快照调度
 *
 * 本文件现在只留**入口与装配**：`SessionHub` 本体 + 两个工厂。三层的实现分别在
 * `./client-session.js`、`./conversation/conversation.js`、`./conversation/messages.js`，
 * 本模块把原先从 `session-hub.ts` 导出的名字**原样再导出**，所以既有 `import ... from
 * "./session-hub.js"` 的调用方无需改动。
 *
 * 相对 pi-web-ui 的改进：
 *   1. pi-web-ui 的 agent-service.ts 是 15398 行的单体；本方案按三层拆分，Conversation
 *      不直接持有 WebSocket，只认注入的 push 回调。
 *   2. 多对话通过注入的 createSession 工厂实现；工厂缺席时**自动降级为单对话模式**
 *      （复用 agent.session），保证 CLI / 旧调用方零改动。
 *   3. 上下文占用不依赖 SDK 私有字段，直接用 context/budget 的估算，与裁剪器同源，
 *      UI 进度条与真实裁剪阈值永远一致。
 */

import { existsSync, rmSync } from "node:fs";
import { resolve as resolveAbsPath } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { BuiltAgent } from "./agent.js";
import type { RuntimeConfig } from "./config.js";
import { getLogger } from "./log.js";
import { AppError, badRequest } from "./errors.js";
import { assertSessionFileAllowed, type SessionCatalog, type StoredConversation } from "./sessions/store.js";
import { forkSessionFile, forkedConversationTitle, normalizeConversationTitle } from "./sessions/edit.js";
import type { PlanModeController } from "./modes/plan-mode.js";
import type { ServerMessage } from "./protocol.js";
import { Conversation } from "./conversation/conversation.js";
import { ClientSession, DEFAULT_MAX_OPEN_CONVERSATIONS } from "./client-session.js";

export { Conversation, MIN_COMPACTABLE_TOKENS, type CompactionOutcome, type ConversationOptions, type Session } from "./conversation/conversation.js";
export { ClientSession, DEFAULT_MAX_OPEN_CONVERSATIONS, type ClientSessionOptions } from "./client-session.js";
export { MAX_SNAPSHOT_MESSAGES } from "./conversation/messages.js";

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

/**
 * `createSessionHub` 的具名参数形式。
 *
 * 位置参数形式（见下方重载）有 8 个可选参数 + 1 个 options，作者自己在注释里承认
 * 「再加第 9 个会让调用方无法分辨传错顺序与少传一个」。具名形式从签名上消除这一类错误，
 * 且新增字段不再需要改动调用方。
 */
export interface CreateSessionHubOptions {
  /** 会话工作目录。默认 `process.cwd()`。 */
  cwd?: string;
  /** 惰性读取「上下文保留最近多少轮」（设置热更新靠它）。 */
  keepRecent?: () => number;
  /** 单连接最多同时打开的对话数（超出按 LRU 淘汰）。 */
  maxOpenConversations?: number;
  /** 惰性读取工具看门狗超时（毫秒）。 */
  toolTimeoutMs?: () => number;
  /** 允许恢复 / 打开的会话文件根（fail-closed：空数组 = 不允许打开既有文件）。 */
  allowedSessionRoots?: readonly string[];
  /** 会话索引（重启后列出磁盘上的对话）。 */
  catalog?: SessionCatalog;
  /** 计划模式控制器；不传则该装配没有计划模式。 */
  planMode?: PlanModeController;
}

/** 推荐入口：具名参数装配 `SessionHub`。 */
export function createSessionHubFromOptions(
  agent: BuiltAgent,
  cfg: RuntimeConfig,
  options: CreateSessionHubOptions = {},
): SessionHub {
  return new SessionHub(
    agent,
    cfg,
    options.cwd,
    options.keepRecent,
    options.maxOpenConversations,
    options.toolTimeoutMs,
    options.allowedSessionRoots,
    options.catalog,
    options.planMode ? { planMode: options.planMode } : undefined,
  );
}

/**
 * Build a SessionHub over an assembled agent.
 *
 * @deprecated 8 个位置参数极易传错顺序（`maxOpenConversations` 与 `toolTimeoutMs` 相邻、
 * 类型还不同，传错往往只在运行期才暴露）。新代码请用 {@link createSessionHubFromOptions}；
 * 本函数保留仅为兼容既有嵌入方，内部直接转调具名形式。
 */
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
  return createSessionHubFromOptions(agent, cfg, {
    cwd,
    keepRecent,
    maxOpenConversations,
    toolTimeoutMs,
    allowedSessionRoots,
    catalog,
    planMode: options?.planMode,
  });
}
