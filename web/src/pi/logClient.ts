/**
 * pi-starter 前端 · 日志查询 REST 客户端
 *
 * 后端日志检索是 REST（`GET /logs`、`GET /logs/stats`，见 src/http/log-routes.ts）；
 * 对话/模型/设置等仍走 WS，本文件是前端唯一一处 REST 调用，专职查日志。
 *
 * 约定：
 * - 所有筛选/分页参数逐项映射到后端接口，**不在前端做假筛选或只筛已加载数据**；
 * - 生产环境前端由后端同源静态托管，`/logs` 直接可达；开发环境由 vite 代理 /logs→后端。
 * - 返回的 entry 字段就是后端脱敏+截断后的 JSONL 原样，敏感值已是 `[redacted]`。
 */

/** 一条日志记录：后端 JSONL 的行，字段动态，已脱敏。 */
export type LogEntry = Record<string, unknown> & {
  ts?: string;
  level?: string;
  msg?: string;
  component?: string;
  requestId?: string;
};

export interface LogQueryFilters {
  /** ISO 字符串或 epoch ms（后端两者都接受）。 */
  from?: string;
  to?: string;
  /** 级别集合（后端逗号分隔）。 */
  level?: string[];
  /** 模块（后端按 component 字段匹配，逗号分隔）。 */
  module?: string[];
  requestId?: string;
  /** 关键字（后端整行大小写不敏感子串匹配）。 */
  q?: string;
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string;
}

export interface LogPage {
  ok: boolean;
  count: number;
  order: "asc" | "desc";
  hasMore: boolean;
  nextCursor?: string;
  entries: LogEntry[];
}

export interface LogTemplateStat {
  template: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  levels: string[];
  modules: string[];
  sampleRequestId?: string;
}

export interface LogStats {
  ok: boolean;
  groupedBy: string;
  count: number;
  stats: LogTemplateStat[];
}

/** 只在 query 上挂非空值，避免把空串当筛选条件发给后端。 */
function toSearchParams(filters: LogQueryFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (filters.from) p.set("from", filters.from);
  if (filters.to) p.set("to", filters.to);
  if (filters.level && filters.level.length > 0) p.set("level", filters.level.join(","));
  if (filters.module && filters.module.length > 0) p.set("module", filters.module.join(","));
  if (filters.requestId) p.set("requestId", filters.requestId);
  if (filters.q) p.set("q", filters.q);
  if (filters.order) p.set("order", filters.order);
  if (filters.limit) p.set("limit", String(filters.limit));
  if (filters.cursor) p.set("cursor", filters.cursor);
  return p;
}

async function getJson<T>(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const qs = params.toString();
  const url = qs ? `${path}?${qs}` : path;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!res.ok) {
    throw new Error(`日志接口返回 ${res.status}（${path}）`);
  }
  return (await res.json()) as T;
}

/** 拉一页日志。 */
export function queryLogs(filters: LogQueryFilters, signal?: AbortSignal): Promise<LogPage> {
  return getJson<LogPage>("/logs", toSearchParams(filters), signal);
}

/** 按模板聚合的错误统计。 */
export function queryStats(filters: LogQueryFilters, signal?: AbortSignal): Promise<LogStats> {
  return getJson<LogStats>("/logs/stats", toSearchParams(filters), signal);
}

/**
 * 导出用：按当前筛选翻遍所有分页拿**完整**结果（不是只导已加载页）。
 * 有硬上限防止无限拉取；触顶时返回 truncated=true 由调用方如实提示。
 */
export async function queryAllForExport(
  filters: LogQueryFilters,
  maxEntries = 20000,
  signal?: AbortSignal,
): Promise<{ entries: LogEntry[]; truncated: boolean }> {
  const collected: LogEntry[] = [];
  let cursor: string | undefined;
  const pageFilters: LogQueryFilters = { ...filters, limit: 1000 };
  for (;;) {
    const page = await queryLogs({ ...pageFilters, cursor }, signal);
    collected.push(...page.entries);
    // 先判"还有没有下一页"再判上限：结果总数**恰好等于**上限且已无下一页时，
    // 一条都没被丢掉，回 truncated=false。原实现把 `>=` 探在 hasMore 之前，
    // 这种情况会谎报"已截断"，让用户白去缩小时间范围。
    if (!page.hasMore || !page.nextCursor) {
      return collected.length <= maxEntries
        ? { entries: collected, truncated: false }
        : { entries: collected.slice(0, maxEntries), truncated: true }; // 确实超出上限、确实丢了
    }
    if (collected.length >= maxEntries) return { entries: collected.slice(0, maxEntries), truncated: true };
    cursor = page.nextCursor;
  }
}
