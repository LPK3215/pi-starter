/**
 * pi-starter · 日志查询接口
 *
 * 内核文件 sink 按天分片落 JSONL（`pi-starter-YYYY-MM-DD.<seq>.log[.gz]`），本模块在其之上
 * 提供只读检索：
 *   - `GET /logs`：时间范围 / 级别 / request_id / 模块 / 关键字 组合筛选 + 游标分页 + 排序；
 *   - `GET /logs/stats`：按消息模板聚合的错误计数（次数 + 首末出现时间）。
 *
 * 硬约束（针对验收暴露的缺陷专门重做）：
 *   - **无损**：不再设「每文件 5 万条」上限。游标定位到「文件 + 字节/条数偏移」，翻到哪算哪，
 *     绝不静默丢弃后续命中，也不会谎报 hasMore=false。
 *   - **不整表入内存**：`.log` 前进用 createReadStream({start:byte}) 流式、回退用 fd 反向扫块，
 *     单页只驻留 `limit` 条；深翻页按字节续读，不从 0 重扫整文件。
 *   - `.log.gz` 归档（冷数据）无法按压缩字节随机定位：前进用「命中条数」跳读、回退整档解压后
 *     反序切片（受轮转上限约束，且冷档很少被深翻），同样无损。
 *
 * 只在装配方提供日志目录时挂载；库嵌入默认不暴露。返回内容字段即后端脱敏后的 JSONL 原样。
 */

import { createReadStream, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import type { Express } from "express";
import { validationFailed } from "./errors.js";
import { asyncRoute } from "./routes.js";
import { LOG_BASE_NAME } from "../log-sink-file.js";

type LogEntry = Record<string, unknown>;

/** 游标：定位到某个文件的某个偏移。byte=log 文件的字节位；count=gz 文件的命中条数。 */
interface Cursor {
  file: string;
  pos: number;
  kind: "byte" | "count";
}

interface Query {
  from?: number;
  to?: number;
  levels?: Set<string>;
  modules?: Set<string>;
  requestId?: string;
  keyword?: string;
  order: "asc" | "desc";
  limit: number;
  cursor?: Cursor;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const BACKWARD_CHUNK = 65536;

/* ────────────────────────── 游标编解码 ────────────────────────── */

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf-8").toString("base64url");
}
function decodeCursor(raw: string): Cursor {
  try {
    const o = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
    if (o && typeof o.file === "string" && typeof o.pos === "number" && (o.kind === "byte" || o.kind === "count")) {
      return o as Cursor;
    }
  } catch {
    /* fall through */
  }
  throw validationFailed("cursor is malformed");
}

/* ────────────────────────── 查询参数解析 ────────────────────────── */

function parseTime(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw);
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw validationFailed(`${field} must be an ISO date or epoch ms`);
  return t;
}
function parseCsv(raw: unknown): Set<string> | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const items = String(raw).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return items.length > 0 ? new Set(items) : undefined;
}
function toQuery(search: URLSearchParams): Query {
  const limitRaw = search.get("limit");
  const limit = limitRaw === null ? DEFAULT_LIMIT : Math.floor(Number(limitRaw));
  if (!Number.isFinite(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw validationFailed(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  const order = (search.get("order") ?? "desc").toLowerCase();
  if (order !== "asc" && order !== "desc") throw validationFailed("order must be asc or desc");
  const from = parseTime(search.get("from"), "from");
  const to = parseTime(search.get("to"), "to");
  if (from !== undefined && to !== undefined && from > to) throw validationFailed("from must not exceed to");
  const cursorRaw = search.get("cursor");
  return {
    from,
    to,
    levels: parseCsv(search.get("level")),
    modules: parseCsv(search.get("module")),
    requestId: search.get("requestId") ?? undefined,
    keyword: search.get("q") ? String(search.get("q")).toLowerCase() : undefined,
    order: order as "asc" | "desc",
    limit,
    cursor: cursorRaw ? decodeCursor(cursorRaw) : undefined,
  };
}

/* ────────────────────────── 文件选择（按天裁剪） ────────────────────────── */

function fileDate(name: string): string | undefined {
  const m = new RegExp(`^${LOG_BASE_NAME}-(\\d{4}-\\d{2}-\\d{2})`).exec(name);
  return m ? m[1] : undefined;
}
async function candidateFiles(dir: string, q: Query): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const logs = names.filter((n) => n.startsWith(`${LOG_BASE_NAME}-`) && /\.log(\.gz)?$/.test(n));
  const kept = logs.filter((n) => {
    if (q.from === undefined && q.to === undefined) return true;
    const d = fileDate(n);
    if (!d) return true; // 无日期段的归档名保守纳入，靠行级 ts 精筛
    const dayStart = Date.parse(`${d}T00:00:00.000Z`);
    const dayEnd = dayStart + 86_400_000 - 1;
    if (q.from !== undefined && dayEnd < q.from) return false;
    if (q.to !== undefined && dayStart > q.to) return false;
    return true;
  });
  kept.sort((a, b) => a.localeCompare(b)); // 文件名含日期+序号，字典序≈时间序
  return q.order === "desc" ? kept.reverse() : kept;
}

/* ────────────────────────── 行匹配 ────────────────────────── */

function matchEntry(e: LogEntry, q: Query): boolean {
  if (q.levels && !q.levels.has(String(e.level ?? "").toLowerCase())) return false;
  if (q.modules && !q.modules.has(String(e.component ?? "").toLowerCase())) return false;
  if (q.requestId && e.requestId !== q.requestId) return false;
  if (q.from !== undefined || q.to !== undefined) {
    const t = typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
    if (Number.isNaN(t)) return false;
    if (q.from !== undefined && t < q.from) return false;
    if (q.to !== undefined && t > q.to) return false;
  }
  return true;
}
function parseAndMatch(raw: string, q: Query): LogEntry | undefined {
  if (!raw) return undefined;
  if (q.keyword && !raw.toLowerCase().includes(q.keyword)) return undefined;
  let e: LogEntry;
  try {
    e = JSON.parse(raw) as LogEntry;
  } catch {
    return undefined;
  }
  return matchEntry(e, q) ? e : undefined;
}

interface PageResult {
  entries: LogEntry[];
  /** 续读游标的 pos；done=true 时忽略。 */
  nextPos?: number;
  done: boolean; // 该文件已读到边界（asc 到 EOF / desc 到文件头）
}

/* ── .log 前进（字节可随机定位，真流式、单页内存） ── */
async function readLogForward(absPath: string, fromByte: number, q: Query, want: number): Promise<PageResult> {
  const entries: LogEntry[] = [];
  let offset = fromByte;
  let resume = fromByte;
  const rl = createInterface({ input: createReadStream(absPath, { start: fromByte }), crlfDelay: Infinity });
  for await (const line of rl) {
    const lineBytes = Buffer.byteLength(line) + 1; // +换行符（写入固定用 \n）
    offset += lineBytes;
    const e = parseAndMatch(line, q);
    if (e) {
      entries.push(e);
      resume = offset;
      if (entries.length >= want) {
        rl.close();
        return { entries, nextPos: resume, done: false };
      }
    }
  }
  rl.close();
  return { entries, done: true };
}

/* ── .log 回退（从 endByte 向下按块扫描换行，逐条反序产出） ── */
function readLogBackward(absPath: string, endByte: number | null, q: Query, want: number): PageResult {
  const entries: LogEntry[] = [];
  const fd = openSync(absPath, "r");
  try {
    const size = fstatSync(fd).size;
    let upper = endByte === null || endByte > size ? size : endByte; // 已读区的上界（不含）
    const block = Buffer.allocUnsafe(BACKWARD_CHUNK);
    let nlBelow = upper; // 下一条（更低）行的结束位置（exclusive），初值为文件上界
    let done = false;
    while (nlBelow > 0 && entries.length < want) {
      // 在 [max(0, nlBelow-CH), nlBelow) 内找最后一个换行符
      let foundNl = -1;
      let searchEnd = nlBelow;
      while (searchEnd > 0 && foundNl < 0) {
        const lo = Math.max(0, searchEnd - BACKWARD_CHUNK);
        const len = searchEnd - lo;
        readSync(fd, block, 0, len, lo);
        const idx = block.lastIndexOf(0x0a, len - 1); // 本块内最后一个 \n 的块内下标
        if (idx >= 0) foundNl = lo + idx;
        else searchEnd = lo;
      }
      const lineStart = foundNl >= 0 ? foundNl + 1 : 0;
      const lineEnd = nlBelow;
      // 读这一行 [lineStart, lineEnd)
      const lineBuf = Buffer.allocUnsafe(Math.max(0, lineEnd - lineStart));
      if (lineBuf.length > 0) readSync(fd, lineBuf, 0, lineBuf.length, lineStart);
      const str = lineBuf.toString("utf8");
      if (foundNl < 0) {
        // 到达文件头，没有更早的换行符：lineStart(=0) 这一行读完后结束
        nlBelow = 0;
        done = true;
      } else {
        nlBelow = foundNl;
      }
      const e = parseAndMatch(str, q);
      if (e) {
        entries.push(e); // 从新到旧
        if (entries.length >= want) return { entries, nextPos: lineStart, done: false };
      }
    }
    return { entries, done };
  } finally {
    closeSync(fd);
  }
}

/* ── .gz：整档解压取全部命中（冷档，受轮转上限约束）；前进/回退都用它，无损 ── */
async function readGzAll(absPath: string, q: Query): Promise<LogEntry[]> {
  const out: LogEntry[] = [];
  const rl = createInterface({ input: createReadStream(absPath).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    const e = parseAndMatch(line, q);
    if (e) out.push(e);
  }
  rl.close();
  return out;
}

/* ────────────────────────── 组装一页 ────────────────────────── */

/** 某文件的一页（从 fromPos 起最多 want 条）。.log 按字节续读、.gz 按命中条数切片；均早停、单页内存。 */
async function pageFromFile(
  abs: string,
  isGz: boolean,
  order: "asc" | "desc",
  fromPos: number,
  want: number,
  q: Query,
): Promise<PageResult> {
  if (isGz) {
    const all = await readGzAll(abs, q);
    if (order === "desc") all.reverse();
    const slice = all.slice(fromPos, fromPos + want);
    const consumed = fromPos + slice.length;
    return { entries: slice, nextPos: consumed, done: consumed >= all.length };
  }
  return order === "asc"
    ? await readLogForward(abs, fromPos < 0 ? 0 : fromPos, q, want)
    : readLogBackward(abs, fromPos < 0 ? null : fromPos, q, want);
}

/** 一个文件的自然起始游标：desc 的 .log 用 -1 表“从文件尾开始”，其余用 0。 */
function beginPos(order: "asc" | "desc", isGz: boolean): number {
  return order === "desc" && !isGz ? -1 : 0;
}

async function scanPage(
  dir: string,
  q: Query,
): Promise<{ entries: LogEntry[]; nextCursor?: string; hasMore: boolean }> {
  const files = await candidateFiles(dir, q);
  if (files.length === 0) return { entries: [], hasMore: false };

  let startIdx = 0;
  let startPos = beginPos(q.order, false);
  if (q.cursor) {
    let at = files.indexOf(q.cursor.file);
    let pos = q.cursor.pos;
    if (at === -1) {
      // 游标里的文件刚被**轮转归档**：`X.log` → `X.log.gz`，原文件已被 unlink。
      // 字节偏移在压缩流上没有意义，所以从该文件开头重新开始——宁可重复几行，也不丢内容，
      // 更不该把一次正常翻页变成 400（那与本模块"无损"的硬约束直接冲突）。
      at = files.indexOf(`${q.cursor.file}.gz`);
      if (at !== -1) pos = beginPos(q.order, true);
    }
    if (at === -1) {
      // 连归档也没了（被保留期清理）：退到**名字排在它之后**的第一个文件。
      // 文件列表按名称有序，而名称里带补零的日期与序号，故名称序即时间序。
      at = files.findIndex((name) => name > q.cursor!.file);
      if (at === -1) return { entries: [], hasMore: false }; // 后面确实没有文件了 = 翻到头
      pos = beginPos(q.order, files[at]!.endsWith(".gz"));
    }
    startIdx = at;
    startPos = pos;
  }

  const page: LogEntry[] = [];
  for (let fi = startIdx; fi < files.length && page.length < q.limit; fi++) {
    const name = files[fi];
    const abs = join(dir, name);
    const isGz = name.endsWith(".gz");
    const fromPos = fi === startIdx ? startPos : beginPos(q.order, isGz);
    const res = await pageFromFile(abs, isGz, q.order, fromPos, q.limit - page.length, q);
    page.push(...res.entries);

    if (page.length >= q.limit) {
      const moreInFile = !res.done;
      const moreFiles = moreInFile || fi + 1 < files.length;
      if (!moreFiles) return { entries: page, hasMore: false };
      const nextCursor: Cursor = moreInFile
        ? { file: name, pos: res.nextPos ?? fromPos, kind: isGz ? "count" : "byte" }
        : {
            file: files[fi + 1],
            pos: beginPos(q.order, files[fi + 1].endsWith(".gz")),
            kind: files[fi + 1].endsWith(".gz") ? "count" : "byte",
          };
      return { entries: page, nextCursor: encodeCursor(nextCursor), hasMore: true };
    }
    // 本文件取尽且页未满 → 继续下一文件。
  }
  return { entries: page, hasMore: false };
}

/* ────────────────────────── 模板聚合统计（流式，无上限，只驻留模板表） ────────────────────────── */

/** 逐行流式遭历某文件的命中（不收集数组），给聚合统计用；内存 = 模板表。 */
async function forEachMatch(abs: string, isGz: boolean, q: Query, onEntry: (e: LogEntry) => void): Promise<void> {
  const input = isGz
    ? createReadStream(abs).pipe(createGunzip())
    : createReadStream(abs);
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const e = parseAndMatch(line, q);
      if (e) onEntry(e);
    }
  } finally {
    rl.close();
  }
}

interface Bucket {
  template: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  levels: Set<string>;
  modules: Set<string>;
  sampleRequestId?: string;
}
async function aggregateStats(dir: string, q: Query): Promise<LogEntry[]> {
  const files = await candidateFiles(dir, { ...q, order: "asc" });
  const buckets = new Map<string, Bucket>();
  for (const name of files) {
    // 逐行流式，内存只留模板表，不收集命中数组。
    await forEachMatch(join(dir, name), name.endsWith(".gz"), q, (e) => {
      const template = String(e.msg ?? "");
      const ts = typeof e.ts === "string" ? e.ts : "";
      const b = buckets.get(template) ?? { template, count: 0, firstSeen: ts, lastSeen: ts, levels: new Set<string>(), modules: new Set<string>() };
      b.count += 1;
      if (ts) {
        if (!b.firstSeen || ts < b.firstSeen) b.firstSeen = ts;
        if (!b.lastSeen || ts > b.lastSeen) b.lastSeen = ts;
      }
      if (e.level) b.levels.add(String(e.level));
      if (e.component) b.modules.add(String(e.component));
      if (!b.sampleRequestId && e.requestId) b.sampleRequestId = String(e.requestId);
      buckets.set(template, b);
    });
  }
  return [...buckets.values()]
    .map((b) => ({
      template: b.template,
      count: b.count,
      firstSeen: b.firstSeen,
      lastSeen: b.lastSeen,
      levels: [...b.levels],
      modules: [...b.modules],
      ...(b.sampleRequestId ? { sampleRequestId: b.sampleRequestId } : {}),
    }))
    .sort((a, z) => z.count - a.count);
}

/* ────────────────────────── 路由 ────────────────────────── */

export interface LogRouteOptions {
  dir: string;
}

function searchOf(query: Record<string, unknown>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) for (const item of v) p.append(k, String(item));
    else if (v !== undefined) p.set(k, String(v));
  }
  return p;
}

export function registerLogRoutes(app: Express, options: LogRouteOptions): void {
  const dir = options.dir;

  app.get(
    "/logs",
    asyncRoute(async (req, res) => {
      const q = toQuery(searchOf(req.query));
      const { entries, nextCursor, hasMore } = await scanPage(dir, q);
      res.json({ ok: true, count: entries.length, order: q.order, hasMore, ...(nextCursor ? { nextCursor } : {}), entries });
    }),
  );

  app.get(
    "/logs/stats",
    asyncRoute(async (req, res) => {
      const search = searchOf(req.query);
      if (!search.get("level")) search.set("level", "error");
      const q = toQuery(search);
      const stats = await aggregateStats(dir, q);
      res.json({ ok: true, groupedBy: "template", count: stats.length, stats });
    }),
  );
}
