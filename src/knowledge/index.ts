/**
 * pi-starter · 知识库
 *
 * 知识库 = src/knowledge/ 下的 Markdown。系统提示词只放 name / title / description，
 * 正文由 search_knowledge / read_knowledge 按需取，避免一上来撑爆上下文。
 *
 * 新增一篇文档 = 丢一个 .md 进去（可用 frontmatter 写 title / description），重启即可。
 * 当库用：buildAgent({ extraKnowledgeDirs: ["/path/to/docs"] })
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface KnowledgeDoc {
  name: string;
  title: string;
  description: string;
  filePath: string;
  body: string;
}

/**
 * Caps applied while loading knowledge documents.
 *
 * Without these a single oversized `.md` (or a directory of thousands) is read fully into
 * memory and then injected into the system prompt, which can blow up the context window
 * before the first user message. Defaults are deliberately generous for real use.
 */
export const MAX_DOC_BYTES = 512 * 1024; // 512 KB per document
export const MAX_DOCS = 500; // documents per load

export interface LoadKnowledgeOptions {
  /** Skip documents larger than this (bytes). Default MAX_DOC_BYTES. */
  maxBytes?: number;
  /** Stop after this many documents. Default MAX_DOCS. */
  maxDocs?: number;
  /** Report skipped documents (defaults, tests). */
  onSkip?: (filePath: string, reason: string) => void;
}

export function resolveKnowledgeDir(): string | undefined {
  const candidates = [
    __dirname,
    join(__dirname, "..", "src", "knowledge"),
    join(__dirname, "..", "knowledge"),
  ];
  return candidates.find((dir) => existsSync(dir));
}

function parseDoc(filePath: string): KnowledgeDoc | undefined {
  const raw = readFileSync(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter<{
    title?: unknown;
    description?: unknown;
  }>(raw);
  const name = basename(filePath, extname(filePath));
  if (!name) return undefined;
  const title = typeof frontmatter.title === "string" && frontmatter.title.trim()
    ? frontmatter.title.trim()
    : name;
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  return {
    name,
    title,
    description,
    filePath,
    body: body.trim(),
  };
}

function loadFromDir(dir: string, options: LoadKnowledgeOptions = {}): KnowledgeDoc[] {
  if (!existsSync(dir)) return [];
  const maxBytes = options.maxBytes ?? MAX_DOC_BYTES;
  const onSkip = options.onSkip;
  const docs: KnowledgeDoc[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      // Size gate BEFORE reading: a huge file must never be pulled into memory at all.
      if (stat.size > maxBytes) {
        onSkip?.(filePath, `超过 ${maxBytes} 字节上限（${stat.size}）`);
        continue;
      }
    } catch {
      continue;
    }
    // parseDoc can still throw on malformed frontmatter; one bad file must not
    // take down the whole knowledge base.
    try {
      const doc = parseDoc(filePath);
      if (doc) docs.push(doc);
    } catch (err) {
      onSkip?.(filePath, err instanceof Error ? err.message : String(err));
    }
  }
  return docs;
}

/** 按给定目录加载。同名时先出现的赢。 */
export function loadKnowledgeFromDirs(
  dirs: readonly string[],
  options: LoadKnowledgeOptions = {},
): KnowledgeDoc[] {
  const maxDocs = options.maxDocs ?? MAX_DOCS;
  const seen = new Set<string>();
  const out: KnowledgeDoc[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const doc of loadFromDir(dir, options)) {
      if (seen.has(doc.name)) continue;
      if (out.length >= maxDocs) {
        options.onSkip?.(doc.filePath, `文档总数超过 ${maxDocs} 上限`);
        return out;
      }
      seen.add(doc.name);
      out.push(doc);
    }
  }
  return out;
}

/** 脚手架知识库 + extraKnowledgeDirs。同名时仓库内置优先。 */
export function loadScaffoldKnowledge(
  extraDirs: readonly string[] = [],
  options: LoadKnowledgeOptions = {},
): KnowledgeDoc[] {
  return loadKnowledgeFromDirs([resolveKnowledgeDir() ?? "", ...extraDirs], options);
}

export function formatKnowledgeCatalog(docs: readonly KnowledgeDoc[]): string {
  if (docs.length === 0) return "";
  const lines = [
    "## 知识库",
    "",
    "需要产品、业务或项目事实时，先 search_knowledge 检索，再 read_knowledge 读全文。不要编造知识库里没有的内容。",
    "",
    "<available_docs>",
  ];
  for (const doc of docs) {
    lines.push("  <doc>");
    lines.push(`    <name>${escapeXml(doc.name)}</name>`);
    lines.push(`    <title>${escapeXml(doc.title)}</title>`);
    if (doc.description) {
      lines.push(`      <description>${escapeXml(doc.description)}</description>`);
    }
    lines.push("  </doc>");
  }
  lines.push("</available_docs>");
  return lines.join("\n");
}

export interface KnowledgeHit {
  name: string;
  title: string;
  description: string;
  score: number;
  snippet: string;
}

export function searchKnowledge(
  docs: readonly KnowledgeDoc[],
  query: string,
  limit = 5,
): KnowledgeHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: KnowledgeHit[] = [];
  for (const doc of docs) {
    const score = scoreDoc(doc, q);
    if (score <= 0) continue;
    hits.push({
      name: doc.name,
      title: doc.title,
      description: doc.description,
      score,
      snippet: makeSnippet(doc, q),
    });
  }
  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return hits.slice(0, limit);
}

function scoreDoc(doc: KnowledgeDoc, q: string): number {
  let score = 0;
  if (doc.name.toLowerCase() === q) score += 100;
  else if (doc.name.toLowerCase().includes(q)) score += 40;
  if (doc.title.toLowerCase().includes(q)) score += 50;
  if (doc.description.toLowerCase().includes(q)) score += 30;
  if (doc.body.toLowerCase().includes(q)) score += 10;
  return score;
}

function makeSnippet(doc: KnowledgeDoc, q: string, width = 160): string {
  const haystack = doc.body || doc.description || doc.title;
  const lower = haystack.toLowerCase();
  const at = lower.indexOf(q);
  if (at < 0) {
    return haystack.length > width ? `${haystack.slice(0, width)}…` : haystack;
  }
  const start = Math.max(0, at - 40);
  const end = Math.min(haystack.length, at + q.length + 120);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < haystack.length ? "…" : "";
  return `${prefix}${haystack.slice(start, end)}${suffix}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
