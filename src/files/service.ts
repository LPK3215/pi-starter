/**
 * pi-starter · 文件服务（内核通用能力）
 *
 * Agent 不读写文件就没有手，这是与业务无关的基础能力，不是某个应用的特性。
 *
 * **安全是第一要务**：这些函数会被 HTTP 路由暴露给任何能连到端口的调用方，
 * 因此每处都做两道路径校验：
 *   1. `resolve` 后的**字面路径**在 root 内 —— 拦 `../` 与绝对路径穿越；
 *   2. 最近**已存在祖先**的 realpath 在 root 内 —— 拦**符号链接逃逸**
 *      （`resolve` 拦不住它，这正是 `extensions/guard.ts` 里 `isPathInsideCwd`
 *      明确声明不覆盖的那一类）。
 *
 * 同步实现，便于单测；路由层负责翻译成 HTTP 语义。
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppError, badRequest, notFound } from "../http/errors.js";

/** 预览上限：只读前这么多字节，避免大文件打爆内存与响应体。 */
export const DEFAULT_MAX_PREVIEW_BYTES = 512 * 1024;
/** 单次写入上限。 */
export const DEFAULT_MAX_WRITE_BYTES = 5 * 1024 * 1024;
/** 目录列举条目上限。 */
export const DEFAULT_MAX_ENTRIES = 1000;

/** 已知二进制扩展名：直接判定，省去内容嗅探。 */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff", ".avif",
  ".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac",
  ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".class", ".jar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".sqlite", ".db", ".bin", ".wasm",
]);

export function isBinaryExtension(path: string): boolean {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * 内容嗅探：字节里出现 NUL 即判二进制。
 *
 * 刻意只做这一项：完整 UTF-8 校验要处理解码与截断边界，成本高收益低；
 * NUL 在实践中已能挡住「二进制被当文本塞进 JSON」。
 */
export function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export interface FileEntry {
  /** 相对 root 的 POSIX 风格路径，便于前端拼接与比较。 */
  path: string;
  name: string;
  kind: "file" | "directory" | "other";
  size: number;
  mtimeMs: number;
  /** 文本文件前若干字符，便于列表直接展示。 */
  preview?: string;
}

export interface FileContent extends FileEntry {
  /** 文本内容；二进制为 undefined。 */
  text?: string;
  /** 因预览上限被截断。 */
  truncated?: boolean;
  binary?: boolean;
}

export interface FileServiceOptions {
  root: string;
  maxPreviewBytes?: number;
  maxWriteBytes?: number;
  maxEntries?: number;
  /** 列出目录时是否带文本预览。默认 true。 */
  previewInList?: boolean;
}

export class FileService {
  readonly root: string;
  private readonly maxPreviewBytes: number;
  private readonly maxWriteBytes: number;
  private readonly maxEntries: number;
  private readonly previewInList: boolean;

  constructor(options: FileServiceOptions) {
    this.root = resolve(options.root);
    // Fail fast and loudly: a root we cannot resolve is a deployment mistake, and every
    // later path check would be unreliable anyway.
    this.realRoot = realpathSync.native(this.root);
    this.maxPreviewBytes = options.maxPreviewBytes ?? DEFAULT_MAX_PREVIEW_BYTES;
    this.maxWriteBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.previewInList = options.previewInList ?? true;
  }

  /**
   * 相对路径 → 绝对路径，并保证落在 root 内（两道校验，见文件头说明）。
   * 对还不存在的目标，逐级向上找到第一个存在的祖先再校验真实路径。
   */
  resolvePath(relPath: string): string {
    const raw = (relPath ?? "").trim();
    if (raw === "") return this.root;
    // 调用方应始终用相对路径；直接给绝对路径的一律拒绝，避免绕过 root 语义。
    if (isAbsolute(raw)) throw badRequest("路径必须是相对于工作目录的相对路径");

    const target = resolve(this.root, raw);
    const rel = relative(this.root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw badRequest(`路径越出工作目录：${rel}`);
    }
    this.assertRealpathInside(target);
    return target;
  }

  /**
   * 真实路径也必须在 root 内——拦符号链接逃逸。**Fail-closed**。
   *
   * 拿不到真实路径时一律拒绝，而不是放行：字面路径在 root 内并不等于真实路径在root 内
   * （符号链接正是把两者分开的机制）。realpath 失败（权限、异常链接、与删除竞争）恰好是
   * 这道检查失效的时刻，此时放行等于把校验交给运气。服务不可用比放行一个文件更可接受。
   */
  private assertRealpathInside(target: string): void {
    let probe = target;
    for (let depth = 0; depth < 64; depth += 1) {
      if (existsSync(probe)) break;
      const parent = dirname(probe);
      if (parent === probe) return;
      probe = parent;
    }
    // 整条路径都不存在：没有实体可逃逸，字面校验已足够（新建/删除场景）。
    if (!existsSync(probe)) return;

    let real: string;
    try {
      real = realpathSync.native(probe);
    } catch (err) {
      throw badRequest(`无法校验真实路径，已拒绝（可能是权限问题或链接异常）：${(err as Error).message}`);
    }
    const rel = relative(this.realRoot, real);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw badRequest("路径经符号链接越出工作目录");
    }
  }

  /** root 自身的真实路径，构造时解析一次。 */
  private readonly realRoot: string;

  /** 绝对路径 → 相对 root 的 POSIX 风格路径。 */
  toRelPath(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }

  /** 列出目录。条目超上限如实标记 truncated，不静默截断。 */
  list(relPath: string): { path: string; entries: FileEntry[]; truncated: boolean } {
    const dir = this.resolvePath(relPath);
    let st;
    try {
      st = statSync(dir);
    } catch {
      throw notFound(`目录不存在：${this.toRelPath(dir) || "/"}`);
    }
    if (!st.isDirectory()) throw badRequest("目标不是目录");

    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      throw new AppError("internal", `目录读取失败：${(err as Error).message}`, { cause: err });
    }
    names.sort((a, b) => a.localeCompare(b));

    const truncated = names.length > this.maxEntries;
    const entries: FileEntry[] = [];
    for (const name of truncated ? names.slice(0, this.maxEntries) : names) {
      const abs = join(dir, name);
      let st2;
      try {
        st2 = statSync(abs);
      } catch {
        continue; // 断链的 symlink / 刚被删除的条目：跳过而非让整个列表失败
      }
      const entry: FileEntry = {
        path: this.toRelPath(abs),
        name,
        kind: st2.isDirectory() ? "directory" : st2.isFile() ? "file" : "other",
        size: st2.isDirectory() ? 0 : st2.size,
        mtimeMs: st2.mtimeMs,
      };
      if (this.previewInList && entry.kind === "file" && !isBinaryExtension(name)) {
        const head = this.readHead(abs, 200);
        if (head !== undefined) entry.preview = head.replace(/\s+/g, " ").trim().slice(0, 200);
      }
      entries.push(entry);
    }
    return { path: this.toRelPath(dir), entries, truncated };
  }

  /** 读文件（带预览上限与二进制判定）。 */
  read(relPath: string): FileContent {
    const abs = this.resolvePath(relPath);
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw notFound(`文件不存在：${this.toRelPath(abs) || "/"}`);
    }
    if (st.isDirectory()) throw badRequest("目标是目录，请用 list 浏览");

    const base: FileEntry = {
      path: this.toRelPath(abs),
      name: basename(abs),
      kind: "file",
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
    if (isBinaryExtension(abs)) return { ...base, binary: true };

    const limit = Math.min(this.maxPreviewBytes, st.size);
    const buf = Buffer.allocUnsafe(limit);
    let fd: number | undefined;
    let read = 0;
    try {
      fd = openSync(abs, "r");
      read = readSync(fd, buf, 0, limit, 0);
    } catch (err) {
      throw new AppError("internal", `文件读取失败：${(err as Error).message}`, { cause: err });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const slice = buf.subarray(0, read);
    if (looksBinary(slice)) return { ...base, binary: true };
    return { ...base, text: slice.toString("utf8"), truncated: st.size > limit };
  }

  /** 写入（覆盖）。父目录自动创建。 */
  write(relPath: string, content: string): FileContent {
    const abs = this.resolvePath(relPath);
    if (abs === this.root) throw badRequest("不能写入工作目录本身");
    if (isBinaryExtension(abs)) throw badRequest("不接受对二进制扩展名路径的文本写入");
    const buf = Buffer.from(content, "utf8");
    if (buf.byteLength > this.maxWriteBytes) {
      throw new AppError(
        "payload_too_large",
        `内容超过 ${this.maxWriteBytes} 字节上限（${buf.byteLength}）`,
      );
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
    return this.read(relPath);
  }

  /** 新建。要求目标不存在，避免误覆盖。 */
  create(relPath: string, content = ""): FileContent {
    const abs = this.resolvePath(relPath);
    if (existsSync(abs)) throw new AppError("conflict", `已存在：${this.toRelPath(abs)}`);
    return this.write(relPath, content);
  }

  /** 重命名 / 移动。源须存在，目标须不存在。 */
  rename(fromRel: string, toRel: string): FileContent {
    const from = this.resolvePath(fromRel);
    const to = this.resolvePath(toRel);
    if (from === this.root) throw badRequest("不能重命名工作目录本身");
    if (!existsSync(from)) throw notFound(`源不存在：${this.toRelPath(from)}`);
    if (existsSync(to)) throw new AppError("conflict", `目标已存在：${this.toRelPath(to)}`);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return this.read(toRel);
  }

  /** 删除文件或目录。递归删除必须显式要求。 */
  remove(relPath: string, recursive = false): { removed: string } {
    const abs = this.resolvePath(relPath);
    if (abs === this.root) throw badRequest("不能删除工作目录本身");
    if (!existsSync(abs)) throw notFound(`不存在：${this.toRelPath(abs)}`);
    let st;
    try {
      st = statSync(abs);
    } catch (err) {
      throw new AppError("internal", `无法读取目标信息：${(err as Error).message}`, { cause: err });
    }
    if (st.isDirectory() && !recursive) throw badRequest("目录非空时需显式指定递归删除");
    try {
      rmSync(abs, { recursive, force: false });
    } catch (err) {
      throw new AppError("internal", `删除失败：${(err as Error).message}`, { cause: err });
    }
    return { removed: this.toRelPath(abs) };
  }

  /** 复制文件（目录需 recursive）。 */
  copy(fromRel: string, toRel: string, recursive = false): FileContent {
    const from = this.resolvePath(fromRel);
    const to = this.resolvePath(toRel);
    if (from === this.root) throw badRequest("不能复制工作目录本身");
    if (!existsSync(from)) throw notFound(`源不存在：${this.toRelPath(from)}`);
    if (existsSync(to)) throw new AppError("conflict", `目标已存在：${this.toRelPath(to)}`);
    let isDir = false;
    try {
      isDir = statSync(from).isDirectory();
    } catch {
      /* 交给 copyFileSync 报错 */
    }
    if (isDir && !recursive) throw badRequest("复制目录需显式指定递归");
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    if (isDir) {
      return { path: this.toRelPath(to), name: basename(to), kind: "directory", size: 0, mtimeMs: Date.now() };
    }
    return this.read(toRel);
  }

  /** 读文件头部若干字符（内部用，失败返回 undefined）。 */
  private readHead(abs: string, bytes: number): string | undefined {
    try {
      if (!statSync(abs).isFile()) return undefined;
      const size = statSync(abs).size;
      const buf = Buffer.allocUnsafe(Math.min(bytes, size));
      if (buf.length === 0) return "";
      const fd = openSync(abs, "r");
      try {
        const read = readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, read).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return undefined;
    }
  }
}

/** 读整个文件为 base64（下载往返用），受体积上限保护。 */
export function readFileAsBase64(abs: string, maxBytes: number): string {
  const st = statSync(abs);
  if (st.size > maxBytes) {
    throw new AppError("payload_too_large", `文件超过 ${maxBytes} 字节上限（${st.size}）`);
  }
  return readFileSync(abs).toString("base64");
}