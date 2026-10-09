/**
 * pi-starter · 结构化日志的文件 sink
 *
 * 在 `src/log.ts` 已有的 Logger（级别 / 脱敏 / 异常序列化 / JSONL）之上补一层**落盘**能力，
 * 而不是引入第二套日志栈：本模块只实现 `LogSink` 契约 `(line: string) => void`，
 * 由 `configureLog({ sink: createCompositeSink([stdout, file]) })` 组合进现有 logger。
 *
 * 提供的能力：
 *   - **按天分片**：活跃文件 `pi-starter-YYYY-MM-DD.log`，跨天自动切新文件；
 *   - **按大小轮转**：超过 `maxBytes` 时把当前文件改名归档并 gzip，重开同名活跃文件；
 *   - **压缩归档**：轮转下来的片段异步 gzip 成 `.log.gz`，成功即删原文件；
 *   - **保留天数**：超过 `retentionDays` 的 `.log` / `.log.gz` 在轮转与启动时清理；
 *   - **非阻塞 + 性能预算**：写走 `fs.WriteStream`（异步），内部缓冲超过
 *     `maxPendingBytes` 直接丢弃并计数，绝不反压拖慢主流程；
 *   - **写失败自告警一次**：流 error 只 console 一条 warn，之后静默降级，
 *     绝不把异常抛回调用方。
 *
 * 落盘目录默认工程根 `./logs`，可用 `PI_LOG_DIR` 覆盖；目录不进版本库、不进发布包。
 * 每条一行 JSON，字段沿用 log.ts 的 `{ ts, level, msg, ... }` 命名法。
 */

import { createWriteStream, mkdirSync, readdirSync, type WriteStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { gzip } from "node:zlib";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { LogSink } from "./log.js";

const gzipAsync = promisify(gzip);

/** 归档/活跃文件名前缀（供查询接口按同一规则匹配）。 */
export const LOG_BASE_NAME = "pi-starter";

/** 单日内缓冲未落盘字节的上限：超过即丢弃新行并计数，作为写入性能预算。 */
const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;

export interface FileSinkOptions {
  /** 日志目录（相对路径按进程 cwd 解析）。 */
  dir: string;
  /** 文件名前缀，默认 `pi-starter`。 */
  baseName?: string;
  /** 单文件字节上限，超过即轮转。0 = 不按大小轮转。 */
  maxBytes?: number;
  /** 保留天数，超期删除。0 = 不清理。 */
  retentionDays?: number;
  /** 内部待刷缓冲上限（字节），超过丢行。默认 8 MiB。 */
  maxPendingBytes?: number;
  /** 自身告警出口（默认 console.warn）。 */
  onSelfWarn?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface FileSinkStats {
  /** 当前活跃文件已写字节。 */
  activeBytes: number;
  /** 已轮转（含归档）次数。 */
  rotated: number;
  /** 因背压/错误丢弃的行数。 */
  dropped: number;
  /** 最近一次自身错误信息。 */
  lastError?: string;
}

/** 把 Date 转成分片日期键（UTC，与 ISO ts 对齐）。 */
function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 活跃文件名已改为分段序号命名（`<base>-<date>.<seq>.log`），不再单独构造。 */

export interface RotatingFileSink {
  /** 交给 `Logger` 的 sink 函数。 */
  sink: LogSink;
  stats(): FileSinkStats;
  /** 当前活跃文件的绝对路径（用于查询接口定位目录）。 */
  dir(): string;
  /** 关闭活跃流并 flush；停机链调用。 */
  dispose(): Promise<void>;
}

/**
 * 创建按天/按大小轮转 + gzip 归档 + 保留清理的文件 sink。
 *
 * 目录不可创建（权限/磁盘）时不抛错：置为降级态，写全部丢弃并告警一次，主流程无感。
 */
export function createRotatingFileSink(options: FileSinkOptions): RotatingFileSink {
  const base = options.baseName ?? LOG_BASE_NAME;
  const dir = resolve(options.dir);
  const maxBytes = Math.max(0, options.maxBytes ?? 0);
  const retentionDays = Math.max(0, options.retentionDays ?? 0);
  const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  const onSelfWarn =
    options.onSelfWarn ?? ((message, fields) => console.warn(message, fields ?? ""));

  let stream: WriteStream | null = null;
  let currentDate = "";
  let currentSeq = 0;
  let currentPath = "";
  let activeBytes = 0;
  let rotated = 0;
  let dropped = 0;
  let lastError: string | undefined;
  // 只有第一次失败告警，之后静默降级；否则一条坏盘会把进程刷屏并拖慢。
  let warned = false;
  let disposed = false;

  function warnOnce(message: string, err: unknown): void {
    lastError = err instanceof Error ? err.message : String(err);
    if (warned) return;
    warned = true;
    onSelfWarn(message, { error: lastError, dir });
  }

  function ensureDir(): boolean {
    try {
      mkdirSync(dir, { recursive: true });
      return true;
    } catch (err) {
      warnOnce("log file sink cannot create directory", err);
      return false;
    }
  }

  /** 活跃分段文件绝对路径：`<base>-<date>.<seq>.log`（序号递增，绝不重命名正在写的文件）。 */
  function segmentPath(key: string, seqNum: number): string {
    return join(dir, `${base}-${key}.${pad(seqNum)}.log`);
  }

  function openSegment(key: string, seqNum: number): void {
    currentDate = key;
    currentSeq = seqNum;
    activeBytes = 0;
    currentPath = segmentPath(key, seqNum);
    try {
      stream = createWriteStream(currentPath, { flags: "a" });
      stream.on("error", (err) => {
        warnOnce("log file sink write stream error", err);
        stream = null;
      });
    } catch (err) {
      warnOnce("log file sink cannot open stream", err);
      stream = null;
    }
  }

  /**
   * 关闭当前分段流：flush 之后（'close' 事件）才异步 gzip 归档。
   * Windows 下绝不能重命名/删除仍被占用的文件，所以归档一定挂在 close 之后。
   */
  function closeAndArchiveCurrent(): void {
    const s = stream;
    const path = currentPath;
    stream = null;
    if (s) {
      s.once("close", () => void archive(path));
      s.end();
    }
  }

  /** 归档一个已关闭的分段：gzip → 删原文件。失败只告警，保留原文件。 */
  async function archive(absPath: string): Promise<void> {
    try {
      const raw = await readFileBuffer(absPath);
      const zipped = await gzipAsync(raw);
      const tmpGz = `${absPath}.gz.tmp`;
      const fh = await open(tmpGz, "w");
      await fh.writeFile(zipped);
      await fh.close();
      await renameNoThrow(tmpGz, `${absPath}.gz`);
      await unlink(absPath).catch(() => undefined);
    } catch (err) {
      warnOnce("log file sink archive failed", err);
    }
  }

  /** 跨天：归档旧分段，开新日期 seq=0 的分段。 */
  function rollToNewDay(nextKey: string): void {
    closeAndArchiveCurrent();
    rotated += 1;
    openSegment(nextKey, 0);
  }

  /** 同日超大小：归档当前分段，开同日期下一序号的分段（不重名，避开占用）。 */
  function rollWithinDay(): void {
    const nextSeq = currentSeq + 1;
    closeAndArchiveCurrent();
    rotated += 1;
    openSegment(currentDate, nextSeq);
  }

  /** 删除超出保留期的历史文件（.log 与 .log.gz 都算）。 */
  function sweepRetention(): void {
    if (retentionDays <= 0) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - retentionDays * 86_400_000;
    for (const name of entries) {
      if (!name.startsWith(`${base}-`) || !/\.log(\.gz)?$/.test(name)) continue;
      // 优先用文件 mtime 判断年龄：归档名里的日期不一定存在，mtime 更可靠。
      void stat(join(dir, name))
        .then((s) => {
          if (s.mtimeMs < cutoff) return unlink(join(dir, name)).catch(() => undefined);
        })
        .catch(() => undefined);
    }
  }

  function write(line: string): void {
    if (disposed) return;
    if (!ensureDir()) {
      dropped += 1;
      return;
    }
    const payload = `${line}\n`;
    const bytes = Buffer.byteLength(payload);
    const key = dateKey(new Date());

    if (!stream) {
      openSegment(key, 0);
    } else if (key !== currentDate) {
      rollToNewDay(key);
    }
    if (!stream) {
      dropped += 1;
      return;
    }
    if (maxBytes > 0 && activeBytes + bytes > maxBytes) {
      rollWithinDay();
      if (!stream) {
        dropped += 1;
        return;
      }
    }
    // 性能预算：内部待刷缓冲过高时丢弃该行，绝不反压调用方（主流程）。
    const pending = stream.writableLength ?? 0;
    if (pending > maxPendingBytes) {
      dropped += 1;
      return;
    }
    try {
      stream.write(payload);
      activeBytes += bytes;
    } catch (err) {
      warnOnce("log file sink write threw", err);
      dropped += 1;
      stream = null;
    }
  }

  // 启动即尝试建目录并清理过期文件（不阻塞首条日志）。
  if (ensureDir()) sweepRetention();

  return {
    sink: write,
    dir: () => dir,
    stats: () => ({ activeBytes, rotated, dropped, lastError }),
    dispose: async () => {
      disposed = true;
      const s = stream;
      stream = null;
      if (!s) return;
      // 停机只 flush，不归档：保留活跃 .log 文件本身（判据要求停机后仍可查）。
      await new Promise<void>((done) => {
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            done();
          }
        };
        s.once("close", finish);
        s.once("error", finish);
        s.end(finish);
      });
    },
  };
}

/* ────────────────────────── 小工具（就近内联，避免为一个 sink 拉入依赖） ────────────────────────── */

async function readFileBuffer(absPath: string): Promise<Buffer> {
  return await new Promise<Buffer>((res, rej) => {
    const chunks: Buffer[] = [];
    const rs = createReadStream(absPath);
    rs.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    rs.on("end", () => res(Buffer.concat(chunks)));
    rs.on("error", rej);
  });
}

/** rename 且吞掉 ENOENT（跨天/归档竞态时原文件可能已不在）。 */
async function renameNoThrow(from: string, to: string): Promise<boolean> {
  const { rename } = await import("node:fs/promises");
  try {
    await rename(from, to);
    return true;
  } catch {
    return false;
  }
}

function pad(n: number): string {
  return String(n).padStart(3, "0");
}
