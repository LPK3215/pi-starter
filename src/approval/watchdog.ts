/**
 * pi-starter · 工具执行看门狗
 *
 * 问题：`tool_execution_start` 之后如果工具永远不返回（例如 bash 卡在交互式提示、
 * 某个 MCP 服务器半死、网络工具无响应），该对话会**永久挂起**——没有任何信号，
 * 用户只能重启进程。
 *
 * 方案：每次工具执行开始时 arm 一个定时器，超时则 `session.abort()`。
 *
 * 设计取舍（与 ApprovalGate 的 fail-safe 一致）：
 *   1. **超时即中止**，不重试——挂死的工具重试大概率同样挂死，反而放大伤害；
 *   2. 定时器**刻意不 unref()**：它必须能触发，否则事件循环空闲时看门狗形同虚设
 *      （这正是 ApprovalGate 里踩过的坑）；
 *   3. **可豁免**：需要人类介入的工具（如 ask_user_question）不应被误杀，
 *      由 `exempt` 判定跳过；
 *   4. 结束时**必须清理**，否则定时器泄漏，且会误伤后续同 id 的调用。
 *
 * 纯逻辑（arm/disarm/判定）不依赖 SDK 便于单测；`session.abort` 通过回调注入。
 */

/** 默认超时：20 分钟。足够长的 LLM 工具调用，又不至于让用户等到放弃。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 20 * 60 * 1000;

export interface ToolWatchdogOptions {
  /**
   * Abort the running turn. Injected so this module stays SDK-free and unit-testable.
   * Must be safe to call when nothing is running.
   */
  abort: () => void | Promise<void>;
  /** Timeout in ms. Default DEFAULT_TOOL_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Tools that must not be killed by the watchdog.
   * A tool waiting on a human can legitimately exceed any timeout.
   */
  exempt?: (toolName: string) => boolean;
  /** Called right before aborting, for logging. */
  onTimeout?: (toolName: string, toolCallId: string, timeoutMs: number) => void;
}

export class ToolWatchdog {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly startedAt = new Map<string, number>();
  private readonly timeoutMs: number;
  private readonly exempt: (toolName: string) => boolean;
  private disposed = false;

  /** Count of timeouts observed (exposed for metrics/tests). */
  timeouts = 0;

  constructor(private readonly opts: ToolWatchdogOptions) {
    const raw = opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    // A non-positive timeout would abort instantly; ignore it and keep the default.
    this.timeoutMs = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOOL_TIMEOUT_MS;
    this.exempt = opts.exempt ?? (() => false);
  }

  /** Arm a watchdog for a started tool call. Re-arming the same id restarts the timer. */
  arm(toolCallId: string, toolName: string): void {
    if (this.disposed) return;
    // Defensive: never let a leaked id grow this map without bound.
    if (!this.timers.has(toolCallId) && this.timers.size >= 512) {
      const oldest = this.timers.keys().next();
      if (!oldest.done) this.disarm(oldest.value);
    }
    this.disarm(toolCallId);
    if (this.exempt(toolName)) return;

    this.startedAt.set(toolCallId, Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(toolCallId);
      this.startedAt.delete(toolCallId);
      this.timeouts += 1;
      this.opts.onTimeout?.(toolName, toolCallId, this.timeoutMs);
      // Never let an abort failure escape into the timer callback.
      void Promise.resolve(this.opts.abort()).catch(() => undefined);
    }, this.timeoutMs);
    // Deliberately NOT unref'd: this timer must fire to be a watchdog.
    this.timers.set(toolCallId, timer);
  }

  /** Clear the watchdog for a finished tool call. */
  disarm(toolCallId: string): void {
    const timer = this.timers.get(toolCallId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(toolCallId);
    }
    this.startedAt.delete(toolCallId);
  }

  /** Elapsed ms for an in-flight call, or undefined when not tracked. */
  elapsed(toolCallId: string): number | undefined {
    const at = this.startedAt.get(toolCallId);
    return at === undefined ? undefined : Date.now() - at;
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  /**
   * Abort everything and refuse further arms.
   * Used on shutdown so a hung turn does not keep the process alive.
   */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.startedAt.clear();
  }
}
