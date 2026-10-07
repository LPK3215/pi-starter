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

function loadFromDir(dir: string): KnowledgeDoc[] {
  if (!existsSync(dir)) return [];
  const docs: KnowledgeDoc[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    try {
      if (!statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }
    const doc = parseDoc(filePath);
    if (doc) docs.push(doc);
  }
  return docs;
}

/** 按给定目录加载。同名时先出现的赢。 */
export function loadKnowledgeFromDirs(dirs: readonly string[]): KnowledgeDoc[] {
  const seen = new Set<string>();
  const out: KnowledgeDoc[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const doc of loadFromDir(dir)) {
      if (seen.has(doc.name)) continue;
      seen.add(doc.name);
      out.push(doc);
    }
  }
  return out;
}

/** 脚手架知识库 + extraKnowledgeDirs。同名时仓库内置优先。 */
export function loadScaffoldKnowledge(extraDirs: readonly string[] = []): KnowledgeDoc[] {
  return loadKnowledgeFromDirs([resolveKnowledgeDir() ?? "", ...extraDirs]);
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
