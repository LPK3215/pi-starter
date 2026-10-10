/**
 * 日志查看面板（自绘，沿用 pi-panels 的既有 UI 体系：shadcn Button/Input + 原生 select/checkbox + 主题 token）。
 *
 * 承载形态：顶栏常驻按钮打开，面板作为主区 flex 行的**右侧停靠列**参与布局（挤占而非浮层），
 * 因此打开时不遮挡对话工作区；单页应用里 1 次点击即可打开。
 *
 * 数据来源：全部经后端 REST（/logs、/logs/stats）逐项筛选与分页，**不在前端做假筛选**。
 * 敏感字段后端写盘时已脱敏，这里看到的和导出的都是打码值。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  queryAllForExport,
  queryLogs,
  queryStats,
  type LogEntry,
  type LogQueryFilters,
  type LogTemplateStat,
} from "@/pi/logClient";

const PAGE = 200;
/** 后端级别即脚手架级别（debug/info/warn/error/silent）；无独立 CRITICAL，error 为最高且最醒目。 */
const LEVELS = ["debug", "info", "warn", "error"] as const;

function levelMeta(level?: string) {
  switch (level) {
    case "error":
      return { dot: "bg-destructive", row: "border-l-2 border-l-destructive bg-destructive/10", badge: "bg-destructive/20 text-destructive font-semibold", loud: true };
    case "warn":
      return { dot: "bg-warning", row: "border-l-2 border-l-warning/70", badge: "bg-warning/20 text-warning", loud: false };
    case "info":
      return { dot: "bg-ok", row: "", badge: "bg-muted text-muted-foreground", loud: false };
    case "debug":
      return { dot: "bg-muted-foreground", row: "", badge: "bg-muted/60 text-muted-foreground", loud: false };
    default:
      return { dot: "bg-muted-foreground", row: "", badge: "bg-muted text-muted-foreground", loud: false };
  }
}

function fmtTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

/** 从 entry 里尽量取到可读的堆栈（后端 serializeError 把 stack 放在 error.stack / 顶层）。 */
function extractStack(entry: LogEntry): string | undefined {
  const err = entry.error;
  if (err && typeof err === "object") {
    const s = (err as Record<string, unknown>).stack;
    if (typeof s === "string") return s;
  }
  if (typeof entry.stack === "string") return entry.stack;
  return undefined;
}

interface DraftFilters extends LogQueryFilters {
  levels: string[];
  modulesText: string;
  from: string;
  to: string;
}

const EMPTY_DRAFT: DraftFilters = { levels: [], modulesText: "", from: "", to: "", requestId: "", q: "", order: "desc" };

/** 把草稿转成后端查询参数（原生筛选，非前端过滤）。 */
function toQuery(draft: DraftFilters, cursor?: string): LogQueryFilters {
  const modules = draft.modulesText.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    from: draft.from || undefined,
    to: draft.to || undefined,
    level: draft.levels.length > 0 ? draft.levels : undefined,
    module: modules.length > 0 ? modules : undefined,
    requestId: draft.requestId || undefined,
    q: draft.q || undefined,
    order: draft.order,
    limit: PAGE,
    cursor,
  };
}

export function LogPanel({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState<DraftFilters>(EMPTY_DRAFT);
  const [applied, setApplied] = useState<LogQueryFilters>(toQuery(EMPTY_DRAFT));
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [autoRefresh, setAutoRefresh] = useState(false);
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [context, setContext] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<LogTemplateStat[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 卸载后不再 setState（面板关闭即卸载，见 App.tsx）。 */
  const aliveRef = useRef(true);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 只让**最新**一次列表请求写结果与 loading。 */
  const requestSeq = useRef(0);
  /** 用户主动「加载更多」是否在途：轮询要避让，否则会把它 abort 掉。 */
  const appendInFlight = useRef(false);
  /** 只让**最新**一次「选中条目」的链路请求写 context。 */
  const selectedSeq = useRef(0);
  /** 只让**最新**一次「错误统计」请求写 stats / error。 */
  const statsSeq = useRef(0);

  // 卸载清理：取消在途请求 + 清掉"已复制"计时器。
  // 原先只靠"下一次查询"顺手 abort，关闭面板时 in-flight fetch 会继续跑并在卸载后 setState。
  useEffect(() => {
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    };
  }, []);

  const runQuery = useCallback(
    async (query: LogQueryFilters, append: boolean) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const seq = (requestSeq.current += 1);
      if (append) appendInFlight.current = true;
      setLoading(true);
      setError(null);
      try {
        const page = await queryLogs(query, ctrl.signal);
        // 已被更新的一次请求取代：整份丢掉，否则旧响应会盖掉新筛选的结果。
        if (!aliveRef.current || seq !== requestSeq.current) return;
        setEntries((prev) => (append ? [...prev, ...page.entries] : page.entries));
        setNextCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } catch (err) {
        if (aliveRef.current && seq === requestSeq.current && (err as Error).name !== "AbortError") {
          setError((err as Error).message);
        }
      } finally {
        if (append) appendInFlight.current = false;
        // 只有最新一次请求能关 loading：旧请求的 finally 会在新请求 `setLoading(true)` 之后
        // 才跑到（abort 的 rejection 是微任务），把刚点亮的指示器提前熄掉。
        if (aliveRef.current && seq === requestSeq.current) setLoading(false);
      }
    },
    [],
  );

  // applied 变化即重查第一页。
  useEffect(() => {
    void runQuery(applied, false);
  }, [applied, runQuery]);

  // 自动刷新：仅在开关打开且处于跟随态时轮询第一页（面板卸载即随 effect cleanup 停止，关闭后面板不轮询）。
  useEffect(() => {
    if (!autoRefresh || !follow) return;
    const id = setInterval(() => {
      // 用户点了「加载更多」就先让路：`runQuery` 开头会 abort 在途请求，轮询撞上来会把它
      // 静默丢掉（append 分支永不执行，表现为"点了没反应"）。
      if (appendInFlight.current) return;
      void runQuery(applied, false);
    }, 2000);
    return () => clearInterval(id);
  }, [autoRefresh, follow, applied, runQuery]);

  // 跟随最新：滚回顶部才算跟随；手动向上翻 → 暂停。
  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setFollow(el.scrollTop <= 4);
  };
  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = 0;
  }, [entries, follow]);

  const apply = () => setApplied(toQuery(draft));
  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setApplied(toQuery(EMPTY_DRAFT));
  };

  const selectEntry = useCallback(async (entry: LogEntry) => {
    setSelected(entry);
    setContext([]);
    const seq = (selectedSeq.current += 1);
    const rid = entry.requestId;
    if (typeof rid === "string" && rid) {
      try {
        const chain = await queryLogs({ requestId: rid, order: "asc", limit: 500 });
        // 快速先后点两条不同 requestId 的记录时，先发后到的响应不能覆盖后选的那条——
        // 否则"同请求链路"显示的是上一条记录的链路。
        if (aliveRef.current && seq === selectedSeq.current) setContext(chain.entries);
      } catch {
        /* 上下文拉取失败不影响主详情 */
      }
    }
  }, []);

  const flashCopied = (key: string) => {
    setCopied(key);
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
  };
  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(key);
    } catch {
      setError("复制失败：浏览器拒绝了剪贴板访问");
    }
  };

  const toggleLevel = (lv: string) =>
    setDraft((d) => ({ ...d, levels: d.levels.includes(lv) ? d.levels.filter((x) => x !== lv) : [...d.levels, lv] }));

  const loadStats = async () => {
    const seq = (statsSeq.current += 1);
    try {
      const s = await queryStats({ ...applied, level: applied.level?.length ? applied.level : ["error"] });
      // 与 runQuery 同一口径：卸载后不再 setState；快速连点「错误统计」时先发后到的旧响应
      // 也不能覆盖新统计（包括它的 catch 写入的 error）。
      if (aliveRef.current && seq === statsSeq.current) setStats(s.stats);
    } catch (err) {
      if (aliveRef.current && seq === statsSeq.current) setError((err as Error).message);
    }
  };

  const doExport = async (format: "jsonl" | "txt") => {
    setError(null);
    try {
      const { entries: all, truncated } = await queryAllForExport({ ...applied, order: "asc" }, 20000);
      // 卸载（用户关掉面板）后既不再 setState，也不该突然弹出下载。
      if (!aliveRef.current) return;
      const body =
        format === "jsonl"
          ? all.map((e) => JSON.stringify(e)).join("\n")
          : all.map(entryLine).join("\n");
      download(`pi-logs-${Date.now()}.${format === "jsonl" ? "jsonl" : "txt"}`, body);
      if (truncated) setError(`结果超过导出上限（2 万条），已截断。请缩小时间范围。`);
    } catch (err) {
      if (aliveRef.current) setError((err as Error).message);
    }
  };

  const errorCount = useMemo(() => entries.filter((e) => e.level === "error").length, [entries]);

  return (
    <aside className="flex w-[440px] shrink-0 flex-col border-s border-border bg-sidebar text-sm">
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">日志</span>
        <span className="text-xs text-muted-foreground">
          {entries.length} 条{errorCount > 0 && <span className="ml-1 text-destructive">· {errorCount} 错误</span>}
        </span>
        <Button variant="ghost" size="xs" className="ml-auto" onClick={onClose}>
          关闭
        </Button>
      </div>

      {/* 筛选区 */}
      <div className="space-y-2 border-b border-border bg-card p-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            起
            <Input type="datetime-local" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            止
            <Input type="datetime-local" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          关键字（后端整行匹配）
          <Input
            value={draft.q ?? ""}
            placeholder="request id / 消息 / 任意字段"
            onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && apply()}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            request_id
            <Input value={draft.requestId ?? ""} onChange={(e) => setDraft({ ...draft, requestId: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            模块（逗号分隔）
            <Input
              value={draft.modulesText}
              placeholder="http, conversation, ws"
              onChange={(e) => setDraft({ ...draft, modulesText: e.target.value })}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">级别</span>
          {LEVELS.map((lv) => (
            <label key={lv} className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={draft.levels.includes(lv)} onChange={() => toggleLevel(lv)} />
              {lv}
            </label>
          ))}
          <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            排序
            <select
              className="rounded border border-border bg-card px-1 py-0.5 text-xs"
              value={draft.order}
              onChange={(e) => setDraft({ ...draft, order: e.target.value as "asc" | "desc" })}
            >
              <option value="desc">新→旧</option>
              <option value="asc">旧→新</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" onClick={apply}>
            查询
          </Button>
          <Button size="xs" variant="outline" onClick={reset}>
            清空
          </Button>
          <Button size="xs" variant="outline" onClick={loadStats}>
            错误统计
          </Button>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            自动刷新
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            跟随最新
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" onClick={() => copyText("loaded", entries.map((e) => JSON.stringify(e)).join("\n"))}>
            {copied === "loaded" ? "已复制" : "复制本页"}
          </Button>
          <Button size="xs" variant="outline" onClick={() => doExport("jsonl")}>
            导出 JSONL
          </Button>
          <Button size="xs" variant="outline" onClick={() => doExport("txt")}>
            导出 TXT
          </Button>
        </div>
      </div>

      {error && <div className="border-b border-destructive/40 bg-destructive/10 px-3 py-1 text-xs text-destructive">{error}</div>}
      {stats && (
        <div className="border-b border-border bg-muted/30 px-3 py-2 text-xs">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-muted-foreground">按模板聚合（{stats.length}）</span>
            <button className="hover:underline" onClick={() => setStats(null)}>
              收起
            </button>
          </div>
          <ul className="max-h-32 space-y-0.5 overflow-y-auto">
            {stats.map((s) => (
              <li key={s.template} className="flex items-center gap-2">
                <span className={cn("size-1.5 shrink-0 rounded-full", levelMeta("error").dot)} />
                <span className="min-w-0 flex-1 truncate" title={s.template}>
                  {s.template}
                </span>
                <span className="font-mono text-destructive">×{s.count}</span>
                <span className="font-mono text-muted-foreground">{fmtTime(s.lastSeen)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 列表 */}
      <div ref={listRef} onScroll={onListScroll} className="min-h-0 flex-1 overflow-y-auto">
        {loading && entries.length === 0 && <div className="p-3 text-xs text-muted-foreground">加载中…</div>}
        {!loading && entries.length === 0 && <div className="p-3 text-xs text-muted-foreground">没有符合条件的日志。</div>}
        <ul>
          {entries.map((e, i) => {
            const m = levelMeta(e.level);
            const isSel = selected && selected.ts === e.ts && selected.msg === e.msg && selected.requestId === e.requestId;
            return (
              <li key={`${e.ts}-${i}`}>
                <button
                  onClick={() => void selectEntry(e)}
                  className={cn(
                    "flex w-full items-start gap-2 border-b border-border/60 px-3 py-1.5 text-left text-xs hover:bg-muted/60",
                    m.row,
                    isSel && "bg-accent/15",
                  )}
                >
                  <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", m.dot)} />
                  <span className="w-14 shrink-0 font-mono text-muted-foreground">{fmtTime(e.ts)}</span>
                  <span className={cn("shrink-0 rounded px-1 py-0.5 font-mono text-[10px] uppercase", m.badge)}>
                    {e.level ?? "?"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <span className="truncate">{String(e.component ?? "-")}</span>
                      {e.requestId && <span className="truncate font-mono opacity-70">#{String(e.requestId).slice(0, 8)}</span>}
                    </span>
                    <span className="block truncate">{String(e.msg ?? "")}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {hasMore && (
          <div className="p-2 text-center">
            <Button
              size="xs"
              variant="outline"
              disabled={loading}
              onClick={() => nextCursor && void runQuery(toQuery({ ...toDraftFromApplied(applied) }, nextCursor), true)}
            >
              {loading ? "加载中…" : "加载更多"}
            </Button>
          </div>
        )}
      </div>

      {/* 详情 */}
      {selected && (
        <div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-border bg-card p-3 text-xs">
          <div className="mb-2 flex items-center gap-2">
            <span className={cn("rounded px-1.5 py-0.5 font-mono uppercase", levelMeta(selected.level).badge)}>
              {selected.level ?? "?"}
            </span>
            <span className="font-mono text-muted-foreground">{selected.ts}</span>
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => copyText("sel", JSON.stringify(selected, null, 2))}>
              {copied === "sel" ? "已复制" : "复制本条"}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setSelected(null)}>
              收起
            </Button>
          </div>

          <Detail label="消息" value={String(selected.msg ?? "")} />
          {extractStack(selected) && <pre className="mt-1 max-h-40 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] whitespace-pre-wrap text-destructive">{extractStack(selected)}</pre>}
          <details className="mt-2">
            <summary className="cursor-pointer text-muted-foreground">完整字段</summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] whitespace-pre-wrap">
              {JSON.stringify(selected, null, 2)}
            </pre>
          </details>

          {selected.requestId && (
            <div className="mt-2">
              <div className="mb-1 text-muted-foreground">同请求链路（{context.length} 条 · request_id #{String(selected.requestId).slice(0, 8)}）</div>
              <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                {context.map((c, i) => (
                  <li key={`${c.ts}-${i}`} className="flex items-center gap-2">
                    <span className={cn("size-1.5 shrink-0 rounded-full", levelMeta(c.level).dot)} />
                    <span className="font-mono text-muted-foreground">{fmtTime(c.ts)}</span>
                    <span className="truncate">{String(c.msg ?? "")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{value}</span>
    </div>
  );
}

/** 纯文本导出的一行格式（与后端 JSONL 同源字段，已脱敏）。 */
function entryLine(e: LogEntry): string {
  const parts = [e.ts ?? "", (e.level ?? "?").toUpperCase(), e.component ?? "-", e.requestId ? `#${e.requestId}` : "-", e.msg ?? ""];
  const extra = Object.entries(e)
    .filter(([k]) => !["ts", "level", "component", "requestId", "msg"].includes(k))
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return `${parts.filter(Boolean).join(" ")}${extra.length ? " " + extra.join(" ") : ""}`;
}

/** 加载更多时复用 applied：把已应用的后端参数还原成草稿形状再拼 cursor。 */
function toDraftFromApplied(q: LogQueryFilters): DraftFilters {
  return {
    from: q.from ?? "",
    to: q.to ?? "",
    levels: q.level ?? [],
    modulesText: (q.module ?? []).join(","),
    requestId: q.requestId ?? "",
    q: q.q ?? "",
    order: q.order,
  };
}

function download(name: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器（Firefox/Safari 对大 Blob 更敏感）来不及把 URL 变成下载，
  // 表现为下载被取消或空文件；等这一轮事件循环过去再释放。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
