/**
 * pi-starter · 跨会话记忆（memory store）
 *
 * 知识库是**静态**的（`src/knowledge/*.md`，随包发布、只读）；记忆是**动态**的
 * （运行期由模型或用户写入、跨会话存活）。两者刻意分开：
 *   - 知识库进系统提示词目录，只读；
 *   - 记忆不进系统提示词正文，靠 `recall` 按需检索，可写。
 *
 * 存储形态：一个 JSONL 文件，每行一条记录。选 JSONL 而不是单个 JSON 对象数组，是因为
 * 「追加一条」不必重写整文件；写盘仍走**原子 rename**（先写同目录临时文件再改名），
 * 与 `settings.ts` 的 `fileSettingsPort` 同一口径——进程写到一半被杀不会留下截断文件。
 *
 * 有界：单条正文、总条数、单文件字节都有上限。无界记忆等于把上下文窗口交给时间。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 单条记忆正文的字节上限（UTF-8）。超出即拒绝，不静默截断。 */
export const MAX_MEMORY_BYTES = 4 * 1024;
/** 记忆总条数上限。超出时最旧的被淘汰（并回报淘汰了几条）。 */
export const MAX_MEMORY_ENTRIES = 2000;
/** 记忆文件字节上限。超过即拒绝写入，避免文件无限增长。 */
export const MAX_MEMORY_FILE_BYTES = 4 * 1024 * 1024;
/** 单次 recall 返回条数默认值与硬上限。 */
export const DEFAULT_RECALL_LIMIT = 5;
export const MAX_RECALL_LIMIT = 50;
/** 标签数量与单个标签长度上限。 */
export const MAX_TAGS = 16;
export const MAX_TAG_LENGTH = 48;

/** 一条记忆。 */
export interface MemoryEntry {
  /** 稳定 id（内容哈希 + 序号），供 recall 命中后按 id 取用。 */
  id: string;
  /** 正文。模型或用户写下的自由文本。 */
  text: string;
  /** 可选标签，便于分组与过滤。 */
  tags: string[];
  /** ISO 时间戳（首次写入）。 */
  createdAt: string;
  /** ISO 时间戳（最近一次覆盖）。 */
  updatedAt: string;
}

/** recall 的命中形状。 */
export interface MemoryHit {
  id: string;
  text: string;
  tags: string[];
  updatedAt: string;
  score: number;
}

export interface MemoryStoreOptions {
  /** 记忆文件路径。默认 `~/.pi/agent/pi-starter-memory.jsonl`。 */
  filePath?: string;
  /** 写盘失败/淘汰等事件的告警出口。 */
  logger?: (msg: string, detail?: unknown) => void;
}

/** 默认记忆文件路径（与 settings / provider-keys 同处）。 */
export function defaultMemoryFile(): string {
  return join(getAgentDir(), "pi-starter-memory.jsonl");
}

/** 稳定短哈希（FNV-1a → base36），不加密：内容变则 id 变。 */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * 记忆存储：内存索引 + JSONL 落盘。
 *
 * 所有变更都是同步的（单进程、零依赖），与 `SettingsService` / `FileService` 的取舍一致：
 * 便于单测，且调用方（工具层）不需要处理并发写。多进程同时写同一文件不在支持范围内——
 * 与 settings 一样，这是「按服务单实例」的脚手架。
 */
export class MemoryStore {
  private entries: MemoryEntry[] = [];
  private readonly filePath: string;
  private readonly log?: (msg: string, detail?: unknown) => void;

  constructor(options: MemoryStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultMemoryFile();
    this.log = options.logger;
    this.entries = this.load();
  }

  /** 只读快照（按更新时间倒序，最新在前）。 */
  list(): MemoryEntry[] {
    return [...this.entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get size(): number {
    return this.entries.length;
  }

  /** 按 id 取一条。 */
  get(id: string): MemoryEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  /**
   * 写入一条记忆。
   *
   * 同一段正文再次写入时**覆盖**（保留 createdAt、刷新 updatedAt 与 tags），
   * 而不是产生重复条目——模型重复「记住」同一件事是常态，让它变成脏数据是设计失误。
   *
   * @returns 写入的记录，以及因超出总条数上限被淘汰的条数。
   * @throws 正文为空、超字节上限、标签非法、或文件超上限时抛 Error（调用方翻成对模型可读的说明）。
   */
  remember(input: { text: string; tags?: readonly string[] }): { entry: MemoryEntry; evicted: number } {
    const text = input.text.trim();
    if (!text) throw new Error("memory text is empty");
    if (utf8Bytes(text) > MAX_MEMORY_BYTES) {
      throw new Error(`memory text exceeds ${MAX_MEMORY_BYTES} bytes`);
    }
    const tags = normalizeTags(input.tags ?? []);
    const now = new Date().toISOString();
    const id = hashText(text);

    const existingIndex = this.entries.findIndex((entry) => entry.id === id);
    const entry: MemoryEntry =
      existingIndex >= 0
        ? { ...this.entries[existingIndex]!, text, tags, updatedAt: now }
        : { id, text, tags, createdAt: now, updatedAt: now };

    const next = existingIndex >= 0
      ? this.entries.map((item, i) => (i === existingIndex ? entry : item))
      : [...this.entries, entry];

    // 淘汰最旧的（按 updatedAt）直到落回上限内。
    let evicted = 0;
    while (next.length > MAX_MEMORY_ENTRIES) {
      let oldestAt = 0;
      for (let i = 1; i < next.length; i += 1) {
        if (next[i]!.updatedAt < next[oldestAt]!.updatedAt) oldestAt = i;
      }
      next.splice(oldestAt, 1);
      evicted += 1;
    }

    const bytes = utf8Bytes(serialize(next));
    if (bytes > MAX_MEMORY_FILE_BYTES) {
      throw new Error(`memory file would exceed ${MAX_MEMORY_FILE_BYTES} bytes`);
    }

    this.entries = next;
    this.save();
    return { entry, evicted };
  }

  /** 删除一条记忆。返回是否命中。 */
  forget(id: string): boolean {
    const next = this.entries.filter((entry) => entry.id !== id);
    if (next.length === this.entries.length) return false;
    this.entries = next;
    this.save();
    return true;
  }

  /**
   * 关键词检索。
   *
   * 与知识库的 `searchKnowledge` 同一套打分口径（正文命中 + 标签命中 + 按词分档），
   * 但**记忆规模小**，所以不做向量化——默认零依赖、零网络调用。
   * 空查询返回最近更新的若干条（「我记过什么」这个最常用的问法）。
   */
  recall(query: string, limit = DEFAULT_RECALL_LIMIT): MemoryHit[] {
    const want = Math.min(Math.max(Math.trunc(Number.isFinite(limit) ? limit : DEFAULT_RECALL_LIMIT), 1), MAX_RECALL_LIMIT);
    const q = query.trim().toLowerCase();
    if (!q) {
      return this.list()
        .slice(0, want)
        .map((entry) => ({ id: entry.id, text: entry.text, tags: entry.tags, updatedAt: entry.updatedAt, score: 0 }));
    }
    const terms = q.split(/\s+/).filter(Boolean);
    const hits: MemoryHit[] = [];
    for (const entry of this.entries) {
      const score = scoreEntry(entry, q, terms);
      if (score <= 0) continue;
      hits.push({ id: entry.id, text: entry.text, tags: entry.tags, updatedAt: entry.updatedAt, score });
    }
    hits.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
    return hits.slice(0, want);
  }

  private load(): MemoryEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const stat = statSync(this.filePath);
      if (!stat.isFile()) return [];
      if (stat.size > MAX_MEMORY_FILE_BYTES) {
        this.log?.(`记忆文件超过 ${MAX_MEMORY_FILE_BYTES} 字节上限，已忽略`, this.filePath);
        return [];
      }
      const raw = readFileSync(this.filePath, "utf8");
      const out: MemoryEntry[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          const entry = parseEntry(parsed);
          if (entry) out.push(entry);
        } catch {
          // 单行损坏不该让整个记忆库报废（与 settings 的「读失败不致命」同一原则）。
          this.log?.("记忆文件存在无法解析的行，已跳过", this.filePath);
        }
      }
      return out;
    } catch (err) {
      this.log?.("记忆文件读取失败，已回落为空", err);
      return [];
    }
  }

  /** 原子写：先写同目录临时文件再 rename，避免写到一半被杀留下截断文件。 */
  private save(): void {
    try {
      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${basename(this.filePath)}.${process.pid}.tmp`);
      writeFileSync(tmp, serialize(this.entries), "utf8");
      renameSync(tmp, this.filePath);
    } catch (err) {
      // 落盘失败只告警：记忆写不进去不该让一次对话崩掉。
      this.log?.("记忆写盘失败", err);
      try {
        rmSync(join(dirname(this.filePath), `.${basename(this.filePath)}.${process.pid}.tmp`), { force: true });
      } catch {
        // 临时文件清理失败无需再报，交由下次覆盖。
      }
    }
  }
}

function serialize(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return "";
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function parseEntry(raw: unknown): MemoryEntry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.text !== "string" || !obj.text.trim()) return undefined;
  const text = obj.text;
  const id = typeof obj.id === "string" && obj.id ? obj.id : hashText(text);
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === "string")
    : [];
  const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : new Date(0).toISOString();
  const updatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt : createdAt;
  return { id, text, tags: tags.slice(0, MAX_TAGS), createdAt, updatedAt };
}

function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const clean = tag.trim();
    if (!clean) continue;
    if (clean.length > MAX_TAG_LENGTH) throw new Error(`memory tag exceeds ${MAX_TAG_LENGTH} chars`);
    if (!out.includes(clean)) out.push(clean);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function scoreEntry(entry: MemoryEntry, q: string, terms: readonly string[]): number {
  const text = entry.text.toLowerCase();
  const tags = entry.tags.map((t) => t.toLowerCase());
  let score = 0;
  if (text.includes(q)) score += 60;
  for (const term of terms) {
    if (text.includes(term)) score += 20;
    if (tags.some((tag) => tag === term)) score += 40;
    else if (tags.some((tag) => tag.includes(term))) score += 15;
  }
  return score;
}
