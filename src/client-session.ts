/**
 * pi-starter · 单个客户端连接（`ClientSession`）
 *
 * 从 `session-hub.ts` 拆出。一个 WS 连接（或一个 CLI 进程）对应一个 `ClientSession`，
 * 内部持有 N 个 `Conversation`，任一时刻只有一个 active；换活跃对话、开新对话、
 * 冷存/唤醒都用同一套 LRU 与上限（`DEFAULT_MAX_OPEN_CONVERSATIONS`）。
 *
 * 与 `Conversation` 的分工：本类管**连接级**状态（活跃对话、对话上限、目录、
 * 恢复白名单、工具超时与看门狗配置），`Conversation` 管**单个对话**的状态。
 */

import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { BuiltAgent } from "./agent.js";
import type { RuntimeConfig } from "./config.js";
import { getLogger } from "./log.js";
import { AppError, badRequest } from "./errors.js";
import { assertSessionFileAllowed, type StoredConversation } from "./sessions/store.js";
import type { PlanModeController } from "./modes/plan-mode.js";
import type { ServerMessage, UiApproval, UiConversation } from "./protocol.js";
import { Conversation, type CompactionOutcome } from "./conversation/conversation.js";

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

export class ClientSession {
  readonly clientId: string;
  private readonly convs = new Map<string, Conversation>();
  /**
   * 已拿到名额、但还在 `await` 分配中（尚未入册）的对话数。
   *
   * `addConversation()` 在「收容量」与「入册」之间有一个 `await`（会话工厂要建 loader 与
   * AgentSession）。只按 `convs.size` 判容量的话，并发调用会各自看到同一个值、各自放过自己，
   * 于是同时在线的 session 会短暂突破上限（实测恒为 cap+1）。
   *
   * 把在途算进占用（`convs.size + inFlight`）才能让容量判定反映真实占用。
   */
  private inFlight = 0;
  /** 排队等名额的请求（`acquireSlot` 的 pending resolver）。 */
  private readonly slotWaiters: Array<() => void> = [];
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
  /**
   * `listConversations()` 中「休眠对话」那一段的缓存。
   *
   * 经 `index`（索引数组引用）与 `liveKey`（在册会话 id 集合）双重校验——索引每次
   * upsert/remove 都会换一个新数组，所以在册集合或索引一变就会自然失效，不需要额外的失效钩子。
   */
  private dormantCache:
    | { index: readonly StoredConversation[]; liveKey: string; items: UiConversation[] }
    | undefined;

  constructor(options: ClientSessionOptions) {
    this.clientId = options.clientId;
    this.agent = options.agent;
    this.cfg = options.cfg;
    this.cwd = options.cwd;
    this.push = options.push;
    this.keepRecent = options.keepRecent ?? (() => 6);
    this.toolTimeoutMs = options.toolTimeoutMs ?? (() => 0);
    const cap = options.maxOpenConversations ?? DEFAULT_MAX_OPEN_CONVERSATIONS;
    if (cap === 1) {
      // cap = 1 与「永不淘汰活动会话」互相矛盾：`evictForCapacity()` 只淘汰非 active，
      // 而新建对话时唯一的那条**就是** active → 无候选可淘汰 → 插入后静默变成 2，
      // 上限形同虚设。与其悄悄超出，不如把它夹到 2（并告警），让行为可预期。
      getLogger()
        .child({ component: "session-hub", clientId: options.clientId })
        .warn("maxOpenConversations=1 与「永不淘汰活动会话」冲突，已按 2 处理", { requested: 1 });
      this.maxOpenConversations = 2;
    } else {
      this.maxOpenConversations = Number.isInteger(cap) && cap >= 2 ? cap : DEFAULT_MAX_OPEN_CONVERSATIONS;
    }
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

    // 容量必须在 `await` **之前**按「在途」占住（`acquireSlot()`）。
    //
    // 这里是本方法唯一容易写错的地方，值得写清楚。旧实现是「先 `await` 分配，再补收一次」，
    // 而补收跑在 `convs.set()` 之前——刚分配出来的那个会话还不在 `convs` 里，
    // `evictForCapacity()` 遍历不到它，所以它收不掉。并发的多个 `new_conversation`
    // （WS 的 `dispatch` 是并行的：`void this.dispatch(msg)`）会各自看到同一个 `convs.size`、
    // 各自通过检查，于是每个都在上限之外多分配一个 session。
    //
    // 实测：cap=4 时并发 12 个请求，存活 session 的峰值是 5（cap+1）；cap=8 时是 9。
    // 超出量恒为 +1 而不是无界增长，因为后续的调用会回收掉更早的那些——但「上限」这个词
    // 在那一刻就是假的，而每个 AgentSession 都带一整套 loader 与事件订阅，代价不小。
    //
    // 现在改成先取名额（把在途计入占用）、取不到就排队等，任何时刻
    // 「已入册 + 在途」都不超过 `maxOpenConversations`。
    await this.acquireSlot();
    let session: Awaited<ReturnType<NonNullable<BuiltAgent["createSession"]>>>;
    try {
      session = factory
        ? await factory(resumeFrom ? { resumeFrom } : undefined)
        : this.agent.session;
    } catch (err) {
      // 分配失败要把名额还回去，否则失败的调用会永久吃掉一个容量位。
      this.releaseSlot();
      throw err;
    }
    // 名额一直占到 `convs.set()` 之后才还：在那之前这条会话既不在 `convs` 里、
    // 又已经真的持有一个 session，正是需要被计入占用的状态。
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
    // 入册后占用由 `convs` 接管，归还在途名额（并唤醒队列里的等待者）。
    this.releaseSlot();
    this.emitConversations();
    conv.getState();
    return conv;
  }

  /**
   * 取一个并发名额。
   *
   * 判定的是 `convs.size + inFlight`——已入册的会话，加上「已拿到名额但还在 `await`
   * 分配中」的会话。后者虽然不在 `convs` 里，却注定要占一个位置，不算进去就会并发超编
   * （实测原实现下 cap+1）。
   *
   * 没名额就**排队等**：被唤醒后重新判定（`while` 而不是 `if`），因为名额可能被
   * 更早被唤醒的那个抢先拿走。这是本类唯一的异步准入点，也是「上限在任何并发下都成立」
   * 的根据。
   *
   * 为什么不把名额「直接派发」给队首：派发需要保证「名额一定被领走」，而领走之后
   * 分配失败还要归还，一旦某次归还时队首已经不再需要名额，就会把名额丢掉、让后面的人
   * 永久挂住。改成「归还即广播 + 每个等待者自己重试」，从结构上就不存在丢失名额的路径。
   */
  private async acquireSlot(): Promise<void> {
    while (!this.tryTakeSlot()) {
      await new Promise<void>((resolve) => {
        this.slotWaiters.push(resolve);
      });
    }
  }

  /**
   * 试取一个名额：够空间就占住并返回 true，否则返回 false（调用方去排队）。
   *
   * 先回收再判定：回收要靠 `evictForCapacity()`，而它淘汰的是非活动会话，
   * 所以「有没有位置」这件事必须先腾出来才能算准。
   */
  private tryTakeSlot(): boolean {
    this.evictForCapacity();
    if (this.convs.size + this.inFlight >= this.maxOpenConversations) return false;
    this.inFlight += 1;
    return true;
  }

  /**
   * 归还一个名额（分配失败，或已入册接管了这份占用），并广播唤醒全部等待者。
   *
   * 必须唤醒：否则排队的请求会一直等一个已经发生过的释放。
   * 一次唤醒所有人而不是只唤醒队首，是为了避免「被唤醒的那个发现名额被抢走后
   * 需要重新排队，而它身后的人再也没人叫」——`acquireSlot()` 的 `while` 会自己重试，
   * 多余被叫醒的那些发现没名额就继续等，不会空转成死循环。
   */
  private releaseSlot(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
    const waiters = this.slotWaiters.splice(0, this.slotWaiters.length);
    for (const resolve of waiters) resolve();
  }

  /**
   * Close least-recently-active conversations until the client is back within the cap。
   *
   * 只按 `convs` 回收（不含在途名额）：在途的会话还没入册、也不该被当成淘汰候选，
   * 它们占的位置由 `tryTakeSlot()` 的判定负责。
   *
   * Deliberately evicts rather than refusing: the client asked for a new chat and an error
   * would be worse UX than silently retiring a cold background conversation. The active
   * conversation is never evicted, and we never drop below one.
   */
  private evictForCapacity(): void {
    while (this.convs.size + this.inFlight >= this.maxOpenConversations) {
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
          inFlight: this.inFlight,
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
    // 休眠项只由「索引内容 + 在册会话 id」决定，与各会话的实时状态无关。而快照每个周期都会
    // 重建整份列表、索引上限又是 500 条——把这一段的 filter+map 结果按这两个输入缓存起来，
    // 周期内就不必反复分配几百个对象。（在册的 `live` 部分每周期都会变，不能缓存。）
    const index = this.persistedConversations();
    const liveKey = live
      .map((item) => item.id)
      .sort()
      .join("\n");
    let dormant: UiConversation[];
    if (this.dormantCache && this.dormantCache.index === index && this.dormantCache.liveKey === liveKey) {
      dormant = this.dormantCache.items;
    } else {
      const liveIds = new Set(live.map((item) => item.id));
      dormant = index
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
      this.dormantCache = { index, liveKey, items: dormant };
    }
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

  async prompt(text: string, images?: ImageContent[], replaceEntryId?: string): Promise<void> {
    const conv = this.active ?? (await this.newConversation());
    await conv.prompt(text, images, replaceEntryId);
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
    let failed = 0;
    for (const conv of this.convs.values()) {
      try {
        await conv.setModel(model);
      } catch (err) {
        // 静默吞掉会让 UI 显示「已轮换」、部分后台对话却仍跑旧模型，且没有任何可见信号。
        failed += 1;
        getLogger()
          .child({ component: "session-hub", clientId: this.clientId })
          .warn("轮换模型时某条对话切换失败", {
            conversationId: conv.id,
            error: err instanceof Error ? err.message : String(err),
          });
      }
    }
    if (failed > 0) this.notify("warn", `模型轮换未完全生效：${failed} 条对话切换失败`);
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
    this.dormantCache = undefined;
    // 还挂着等的请求要唤醒：连接都拆了，没人会再释放名额，让它们挂在这里等于泄漏
    // 一批 pending Promise（`addConversation` 会让它们各自重新判定，然后因为容量为 0
    // 而立刻拿到名额开始分配——但那时会话已经被拆掉，调用方拿到什么都没意义）。
    // 所以这里只做唤醒，避免无界挂起；调用方的生命周期由它自己的 await 决定。
    this.inFlight = 0;
    const waiters = this.slotWaiters.splice(0, this.slotWaiters.length);
    for (const resolve of waiters) resolve();
  }
}
