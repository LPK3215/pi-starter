/**
 * pi-starter · 会话索引（重启后找回对话）
 *
 * SDK 负责把对话写成 JSONL，也能按路径打开。对话列表本身原来只活在 SessionHub 的内存里，
 * 重启即空。本模块补上这一层：记住「有哪些会话、文件在哪、叫什么、多少消息」。
 *
 * 范围：只恢复本工作区、本脚手架自己写下的对话。不做跨客户端过户，不做项目维度。
 * 会话目录是 SDK 默认目录的**兄弟目录**（`…/<编码>.pi-starter`），不和 `pi` CLI 的
 * `.jsonl` 混在一起——客户端因此打不开 CLI 的记录。
 *
 * 安全：
 *   - 客户端只提交会话 id。路径只从本索引查出，不接受调用方传来的任意路径当作「用户指定的文件」。
 *   - `assertSessionFileAllowed()` 必须在 `SessionManager.open()` 之前运行。
 *     `resolveSessionManager()` 会再查一次；不要绕过它直接 open。
 *   - 允许根目录的 realpath 失败就丢掉这个根，不退回字面路径。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AppError, badRequest } from "../errors.js";

/** 索引里的一条对话。路径只给服务端自己用，不下发。 */
export interface StoredConversation {
  /** SDK 的 session id，也是 Conversation.id。客户端用它打开，不用文件名去猜。 */
  sessionId: string;
  /** SDK 会话文件绝对路径。恢复时交给 SessionManager.open。 */
  sessionFile: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export interface SessionIndexData {
  version: 1;
  /** 这份索引属于哪个工作目录。对不上就整份忽略。 */
  cwd: string;
  conversations: StoredConversation[];
}

export interface SessionCatalog {
  readonly cwd: string;
  list(): readonly StoredConversation[];
  get(sessionId: string): StoredConversation | undefined;
  /**
   * 插入或按 sessionId 替换，并立刻原子写盘。
   * 路径过不了 `assertSessionFileAllowed` 就抛，不会把越界路径写进文件。
   */
  upsert(entry: StoredConversation): void;
  /** 打开失败或文件已不在时丢掉这一条，避免列表里永远挂着打不开的项。 */
  remove(sessionId: string): void;
}

export function emptyIndex(cwd: string): SessionIndexData {
  return { version: 1, cwd, conversations: [] };
}

/** 索引放在会话目录里面。目录按 cwd 分开，所以不同工作区不会共用一份文件。 */
export function defaultSessionIndexFile(sessionDir: string): string {
  return join(sessionDir, "index.json");
}

/**
 * 本脚手架自己的会话目录。
 *
 * 不把 cwd 编码规则再写一遍：先问 SDK 它会把这个 cwd 放到哪，再使用旁边的
 * `<那个目录名>.pi-starter`。编码一旦在这边重写且和 SDK 不一致，恢复会静默找错地方。
 *
 * `SessionManager.create()` 会顺带创建 CLI 的会话目录，并在内存里分配一个用不到的
 * session id。文件要等到第一条 assistant 消息才落盘，而这里立刻丢掉这个 manager，
 * 所以不会留下空的 `.jsonl`。显式传入 `explicitDir` 时不再问 SDK（测试用）。
 */
export function scaffoldSessionDir(cwd: string, explicitDir?: string): string {
  const dir = explicitDir ?? siblingOfSdkSessionDir(cwd);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function siblingOfSdkSessionDir(cwd: string): string {
  const sdkDir = SessionManager.create(cwd).getSessionDir();
  return join(dirname(sdkDir), `${basename(sdkDir)}.pi-starter`);
}

/**
 * 允许打开的会话目录。问不到就返回空数组——空数组等于禁止恢复（fail-closed）。
 * 传入 `explicitDir` 时不会去碰 SDK 的默认目录。
 */
export function defaultSessionRoots(cwd: string, explicitDir?: string): string[] {
  try {
    if (!explicitDir && cwd.trim() === "") return [];
    return [scaffoldSessionDir(explicitDir ? cwd || process.cwd() : cwd, explicitDir)];
  } catch {
    return [];
  }
}

/** realpath 失败返回 undefined。调用方必须当成「不能确认」，不能退回字面路径。 */
function safeRealpath(target: string): string | undefined {
  try {
    return realpathSync.native(target);
  } catch {
    return undefined;
  }
}

/** `target` 是否严格位于 `root` 之内（根目录本身不算）。 */
function isStrictlyInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "" || rel === "..") return false;
  // `..inside.jsonl` 是合法文件名，不能用 startsWith("..") 一刀切。
  if (rel.startsWith(`..${sep}`) || rel.startsWith("../")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * 校验一个会话文件能否被打开。必须在任何 `SessionManager.open()` 之前调用。
 *
 * 失败即拒绝：
 *   1. 绝对路径，且是 `.jsonl`；
 *   2. 文件 realpath 必须成功（缺文件、不可读、断掉的符号链接都拒绝）；
 *   3. 至少一个允许根的 realpath 成功，且文件真实落在该根里面。
 *      根自己 realpath 失败就丢掉这个根，不用字面路径顶上。
 */
export function assertSessionFileAllowed(filePath: string, allowedRoots: readonly string[]): void {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw badRequest("会话文件路径不能为空");
  }
  if (!isAbsolute(filePath)) {
    throw badRequest("会话文件路径必须是绝对路径");
  }
  if (!filePath.toLowerCase().endsWith(".jsonl")) {
    throw badRequest("会话文件必须是 .jsonl");
  }
  if (allowedRoots.length === 0) {
    throw new AppError("forbidden", "会话恢复未启用");
  }

  const real = safeRealpath(resolve(filePath));
  if (!real) {
    throw new AppError("forbidden", "无法校验会话文件，已拒绝（文件不存在或不可读）");
  }
  const roots = allowedRoots
    .map((root) => safeRealpath(resolve(root)))
    .filter((root): root is string => root !== undefined);
  if (roots.length === 0) {
    throw new AppError("forbidden", "无法校验会话目录，已拒绝");
  }
  if (!roots.some((root) => isStrictlyInside(root, real))) {
    throw new AppError("forbidden", "会话文件不在允许的目录内");
  }
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !value.includes("/") && !value.includes("\\");
}

/** 只保留安全目录内、字段完整的条目。被手工塞进索引的越界路径在这里丢掉。 */
export function sanitizeIndexEntries(
  entries: readonly unknown[],
  allowedRoots: readonly string[],
): { kept: StoredConversation[]; dropped: number } {
  const kept: StoredConversation[] = [];
  let dropped = 0;
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") {
      dropped += 1;
      continue;
    }
    const item = raw as Record<string, unknown>;
    if (!isSessionId(item.sessionId) || typeof item.sessionFile !== "string" || typeof item.title !== "string") {
      dropped += 1;
      continue;
    }
    try {
      assertSessionFileAllowed(item.sessionFile, allowedRoots);
    } catch {
      dropped += 1;
      continue;
    }
    kept.push({
      sessionId: item.sessionId,
      sessionFile: item.sessionFile,
      title: item.title,
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
      messageCount: typeof item.messageCount === "number" ? item.messageCount : 0,
    });
  }
  return { kept, dropped };
}

/**
 * 索引文件端口（原子写 + 损坏回落）。
 *
 * `cwd` 是这份索引所属的工作目录。文件里的 cwd 对不上就整份当空的，避免两个工作区
 * 共用或拷错文件时把别人的列表接进来。保存时一律写这个 cwd，并再次丢掉越界路径。
 */
export function sessionIndexPort(
  filePath: string,
  allowedRoots: readonly string[],
  options: { cwd?: string; logger?: (msg: string, err: unknown) => void } = {},
): { load(): SessionIndexData; save(data: SessionIndexData): void } {
  const cwd = options.cwd ?? process.cwd();
  const log = options.logger;
  return {
    load: () => {
      if (!existsSync(filePath)) return emptyIndex(cwd);
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return emptyIndex(cwd);
        }
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.cwd !== "string" || resolve(obj.cwd) !== resolve(cwd)) {
          log?.("会话索引属于另一个工作区，已忽略", obj.cwd);
          return emptyIndex(cwd);
        }
        const entries = Array.isArray(obj.conversations) ? obj.conversations : [];
        const { kept, dropped } = sanitizeIndexEntries(entries, allowedRoots);
        if (dropped > 0) log?.("会话索引中有条目被丢弃（路径不可信）", dropped);
        // 读回来时也封顶：文件可能来自旧版本或被手工塞大，不能因为"读"就放行无界数据。
        return { version: 1, cwd, conversations: trimToCap(kept, MAX_INDEX_ENTRIES) };
      } catch (err) {
        log?.("会话索引无法解析，已回落为空索引", err);
        return emptyIndex(cwd);
      }
    },
    save: (data) => {
      const { kept, dropped } = sanitizeIndexEntries(data.conversations, allowedRoots);
      if (dropped > 0) log?.("会话索引保存时丢弃了不可信条目", dropped);
      const clean = emptyIndex(cwd);
      clean.conversations = kept;
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
      renameSync(tmp, filePath);
    },
  };
}

/** 进程内目录 + 立刻落盘。Web 入口用这一层，而不是自己拼路径。 */
/**
 * 索引条目上限。
 *
 * 没有上限时索引会随对话数无限增长，而每次 `upsert` 都要**全量重写**整个 JSON——
 * 也就是 O(n) 的写放大，跑久了既拖慢又占内存。对照本项目自己的其它护栏
 * （MAX_OPEN_CONVERSATIONS / MAX_ROWS / MAX_SNAPSHOT_MESSAGES），这里同样该有。
 *
 * 超出时淘汰 `updatedAt` 最旧的一条——而不是拒绝写入，否则用户会发现「最近的对话
 * 存不下来」，而那正是他最想保住的东西。
 */
export const MAX_INDEX_ENTRIES = 500;

/** 淘汰到上限内：按 updatedAt 升序保留最近的若干条。 */
function trimToCap(entries: StoredConversation[], cap: number): StoredConversation[] {
  if (entries.length <= cap) return entries;
  return [...entries]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, cap)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function sessionCatalog(
  filePath: string,
  allowedRoots: readonly string[],
  cwd: string,
  options: { logger?: (msg: string, err: unknown) => void; maxEntries?: number } = {},
): SessionCatalog {
  const port = sessionIndexPort(filePath, allowedRoots, { cwd, logger: options.logger });
  let data = port.load();
  const cap = Number.isInteger(options.maxEntries) && (options.maxEntries as number) >= 1
    ? (options.maxEntries as number)
    : MAX_INDEX_ENTRIES;
  const persist = (conversations: StoredConversation[]): void => {
    // 写入前已逐条校验过（upsert 里调assertSessionFileAllowed，load 时过滤越界项），
    // 所以直接用内存结果即可——原先每次写完都 port.load() 重新读回文件，纯浪费 IO。
    const next: SessionIndexData = { version: 1, cwd, conversations: trimToCap(conversations, cap) };
    port.save(next);
    data = next;
  };
  return {
    cwd,
    list: () => data.conversations,
    get: (sessionId) => data.conversations.find((entry) => entry.sessionId === sessionId),
    upsert: (entry) => {
      if (!isSessionId(entry.sessionId)) throw badRequest("会话 id 无效");
      if (typeof entry.title !== "string") throw badRequest("会话标题无效");
      assertSessionFileAllowed(entry.sessionFile, allowedRoots);
      const conversations = data.conversations.filter((item) => item.sessionId !== entry.sessionId);
      conversations.push({
        sessionId: entry.sessionId,
        sessionFile: entry.sessionFile,
        title: entry.title,
        updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
        messageCount: typeof entry.messageCount === "number" ? entry.messageCount : 0,
      });
      persist(conversations);
    },
    remove: (sessionId) => {
      const conversations = data.conversations.filter((item) => item.sessionId !== sessionId);
      if (conversations.length === data.conversations.length) return;
      persist(conversations);
    },
  };
}
