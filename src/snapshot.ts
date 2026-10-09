/**
 * pi-starter · 快照发射器（snapshot-driven）
 *
 * 服务端是唯一事实源：每次事件后按节流窗口推一份 UiState 快照。
 * - 常见「仅追加」走 O(n) 指针等同性判定发 snapshot_delta；
 * - 中途变更 / 截断 / 切对话 / forceFull 回落全量 snapshot。
 *
 * 无 IO、无 WebSocket 依赖：通过注入的 buildState/emit 回调工作，便于复用与单测。
 */

import type { ServerMessage, UiMessage, UiState } from "./protocol.js";

export interface SnapshotEmitterOptions {
  /** Current conversation id, used to detect conversation switches. */
  convId: () => string;
  /**
   * Build the authoritative state (messages array must use stable object references).
   *
   * `rev` is deliberately excluded: the revision chain is owned by this emitter (`++this.rev`),
   * so a builder-supplied value would only ever be overwritten — and a hard-coded `rev: 0` in
   * the builder read like a real revision while being dead. The emitter injects it in both
   * branches instead.
   */
  buildState: () => Omit<UiState, "rev">;
  /** Push a message to the transport. */
  emit: (msg: ServerMessage) => void;
  /** Normal throttle window (ms). */
  intervalMs: number;
  /** Wider checkpoint window while deltas are actively streaming (ms). */
  streamingIntervalMs: number;
}

export class SnapshotEmitter {
  private rev = 0;
  private emittedRev = 0;
  private emittedMessages: UiMessage[] | null = null;
  private emittedConvId = "";
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDeltaAt = 0;
  private disposed = false;

  constructor(private readonly opts: SnapshotEmitterOptions) {}

  /** Mark that a streaming delta just fired; widens the next checkpoint window. */
  noteDelta(): void {
    this.lastDeltaAt = Date.now();
  }

  /** Emit immediately, clearing any pending throttle. */
  flushSnapshot(forceFull = false): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.emitSnapshotNow(forceFull);
  }

  /** Schedule a throttled snapshot; coalesces repeated calls within the window. */
  scheduleSnapshot(): void {
    if (this.disposed || this.throttleTimer) return;
    const streaming = Date.now() - this.lastDeltaAt < this.opts.streamingIntervalMs;
    const window = streaming ? this.opts.streamingIntervalMs : this.opts.intervalMs;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.emitSnapshotNow(false);
    }, window);
    this.throttleTimer.unref?.();
  }

  /** Decide between snapshot_delta (append-only) and a full snapshot. */
  emitSnapshotNow(forceFull = false): void {
    if (this.disposed) return;
    const state = this.opts.buildState();
    const cur = state.messages;
    const prev = this.emittedMessages;
    const convId = this.opts.convId();

    let incremental =
      !forceFull &&
      prev !== null &&
      this.emittedConvId === convId &&
      prev.length <= cur.length;

    if (incremental && prev) {
      for (let i = 0; i < prev.length; i++) {
        if (prev[i] !== cur[i]) {
          incremental = false;
          break;
        }
      }
    }

    const rev = ++this.rev;

    if (incremental && prev) {
      const light = stripMessages(state, rev);
      this.opts.emit({
        type: "snapshot_delta",
        conversationId: convId,
        rev,
        baseRev: this.emittedRev,
        appended: cur.slice(prev.length),
        state: light,
      });
    } else {
      this.opts.emit({ type: "snapshot", state: { ...state, rev } });
    }

    this.emittedRev = rev;
    this.emittedMessages = cur;
    this.emittedConvId = convId;
  }

  dispose(): void {
    this.disposed = true;
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
  }
}

/** Drop messages/streamingMessage and stamp rev for the delta light-state. */
function stripMessages(state: Omit<UiState, "rev">, rev: number) {
  const { messages: _messages, streamingMessage: _streaming, ...rest } = state;
  return { ...rest, rev };
}
