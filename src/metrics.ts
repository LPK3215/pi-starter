/**
 * pi-starter · 运行时指标
 *
 * 零依赖的进程内计数器。存在的理由：没有它就无法回答「现在有多少连接、
 * 出了多少错、快照丢了多少次」，而这些恰恰是长跑服务最先出问题的信号。
 *
 * 设计取舍：不做 Prometheus 文本格式（避免为一个端点引入依赖），
 * 而是同时提供 JSON（人看 / 脚本读）与 Prometheus 文本（可直接被采集）。
 *
 * 指标分两类，语义不同、不要混淆：
 *   - **Gauge**  当前值（连接数、对话数）—— 涨上去不一定是故障，要结合上下文看；
 *   - **Counter** 累计值（错误数、丢弃数）—— 只增不减，看的是趋势与速率。
 */

export type MetricKind = "gauge" | "counter";

export interface MetricDefinition {
  name: string;
  kind: MetricKind;
  help: string;
}

export const METRICS = {
  wsConnections: {
    name: "pi_ws_connections",
    kind: "gauge",
    help: "Current live WebSocket connections",
  },
  wsConnectionsTotal: {
    name: "pi_ws_connections_total",
    kind: "counter",
    help: "WebSocket connections accepted since start",
  },
  clientSessions: {
    name: "pi_client_sessions",
    kind: "gauge",
    help: "Current client sessions (one per attached client)",
  },
  conversations: {
    name: "pi_conversations",
    kind: "gauge",
    help: "Current open conversations across all clients",
  },
  promptsTotal: {
    name: "pi_prompts_total",
    kind: "counter",
    help: "Prompts dispatched to the agent",
  },
  toolCallsTotal: {
    name: "pi_tool_calls_total",
    kind: "counter",
    help: "Tool executions started",
  },
  toolErrorsTotal: {
    name: "pi_tool_errors_total",
    kind: "counter",
    help: "Tool executions that ended with an error",
  },
  snapshotsDroppedTotal: {
    name: "pi_snapshots_dropped_total",
    kind: "counter",
    help: "Snapshots dropped due to backpressure (client self-heals via rev chain)",
  },
  snapshotsSentTotal: {
    name: "pi_snapshots_sent_total",
    kind: "counter",
    help: "Snapshot frames successfully written to a socket",
  },
  slowClientsDroppedTotal: {
    name: "pi_slow_clients_dropped_total",
    kind: "counter",
    help: "Connections terminated after sustained snapshot backpressure",
  },
  protocolErrorsTotal: {
    name: "pi_protocol_errors_total",
    kind: "counter",
    help: "Malformed or unknown inbound frames rejected",
  },
  dispatchErrorsTotal: {
    name: "pi_dispatch_errors_total",
    kind: "counter",
    help: "Command handlers that threw",
  },
  rateLimitedTotal: {
    name: "pi_rate_limited_total",
    kind: "counter",
    help: "Requests rejected by the rate limiter",
  },
  approvalsPending: {
    name: "pi_approvals_pending",
    kind: "gauge",
    help: "Approval requests currently awaiting a human decision",
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricName = keyof typeof METRICS;

/** 进程启动时刻，用于计算 uptime。 */
const startedAt = Date.now();

/**
 * Metrics registry.
 *
 * Gauges support add/sub (deltas) because connection counts move by ±1; counters only inc.
 * Unknown metric names throw in dev but are ignored in production paths — a typo in a
 * metric name must never take down a request, so callers use the safe helpers below.
 */
export class Metrics {
  private readonly values = new Map<string, number>();

  /** Increment a counter. Negative deltas are rejected (counters must be monotonic). */
  inc(name: MetricName, delta = 1): void {
    if (delta < 0) return;
    const key = METRICS[name].name;
    this.values.set(key, (this.values.get(key) ?? 0) + delta);
  }

  /** Adjust a gauge by a signed delta. */
  addGauge(name: MetricName, delta: number): void {
    const key = METRICS[name].name;
    const next = (this.values.get(key) ?? 0) + delta;
    // A gauge must never go negative; a decrement below zero means double-decrement.
    this.values.set(key, Math.max(0, next));
  }

  /** Set a gauge to an absolute value (e.g. recomputed from a live collection). */
  setGauge(name: MetricName, value: number): void {
    this.values.set(METRICS[name].name, Math.max(0, value));
  }

  get(name: MetricName): number {
    return this.values.get(METRICS[name].name) ?? 0;
  }

  /** Snapshot of all metrics as { name: value }. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const def of Object.values(METRICS)) out[def.name] = this.values.get(def.name) ?? 0;
    return out;
  }

  /** Prometheus text exposition format (v0.0.4), directly scrapable. */
  toPrometheus(): string {
    const lines: string[] = [];
    for (const def of Object.values(METRICS)) {
      lines.push(`# HELP ${def.name} ${def.help}`);
      lines.push(`# TYPE ${def.name} ${def.kind}`);
      lines.push(`${def.name} ${this.values.get(def.name) ?? 0}`);
    }
    lines.push("# HELP pi_uptime_seconds Process uptime in seconds");
    lines.push("# TYPE pi_uptime_seconds gauge");
    lines.push(`pi_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`);
    return `${lines.join("\n")}\n`;
  }

  /** Runtime info that is useful in /health but is not a metric. */
  static runtimeInfo(): { uptimeSeconds: number; nodeVersion: string; pid: number } {
    return {
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      nodeVersion: process.version,
      pid: process.pid,
    };
  }
}

/** Shared registry. Library consumers may create their own instance for isolation. */
export const metrics = new Metrics();
