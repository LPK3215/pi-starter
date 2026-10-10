#!/usr/bin/env node
/**
 * generate_retrieval.mjs
 *
 * Purpose:
 *   Regenerate `docs/knowledge-retrieval.svg` — the pluggable knowledge-RAG
 *   retrieval pipeline introduced on top of the SDK's "register your own
 *   searchable tool" pattern. Provider / store class names are read from the
 *   actual source at generation time so the diagram never drifts from the code.
 *
 * Dependencies:
 *   Node.js built-ins only (`node:fs`, `node:path`). No npm install required.
 *
 * Run:
 *   node scripts/visualization/generate_retrieval.mjs
 *
 * Output:
 *   docs/knowledge-retrieval.svg (900 x 470, English text nodes per repo doc policy)
 *
 * Notes:
 *   - Text inside SVG is English; Chinese explanation lives in the README caption.
 *   - One file, no language suffix; README.md and README.zh-CN.md reference the same file.
 *   - Do NOT delete this script; reuse it when the retrieval layer changes.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const outPath = join(repoRoot, "docs", "knowledge-retrieval.svg");
const kbDir = join(repoRoot, "src", "knowledge");

function classesIn(fileRel, re) {
  const p = join(kbDir, fileRel);
  if (!existsSync(p)) return [];
  return [...readFileSync(p, "utf8").matchAll(re)].map((m) => m[1]);
}

// Truth sources: the concrete classes that implement each interface today.
const retrievers = classesIn("retrieval.ts", /export class (\w*Retriever)\b/g); // Keyword/Vector
const embeddingProviders = [
  ...classesIn("embeddings.ts", /export class (\w+Embeddings)\b/g),
  ...classesIn("embeddings-transformers.ts", /export class (\w+Embeddings)\b/g),
];
const stores = [
  ...classesIn("retrieval.ts", /export class (\w+VectorStore)\b/g),
  ...classesIn("vector-store-sqlite.ts", /export class (\w+VectorStore)\b/g),
];

const W = 900;
const H = 470;
const C = {
  bg: "#0f172a", panel: "#1e293b", stroke: "#334155", text: "#e2e8f0", muted: "#94a3b8",
  accent: "#38bdf8", gold: "#facc15", ok: "#22c55e", warn: "#f472b6", violet: "#a78bfa",
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const box = (x, y, w, h, { stroke = C.stroke, fill = C.panel, rx = 10 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`;
const text = (x, y, t, { size = 12, weight = "400", fill = C.text, anchor = "start" } = {}) =>
  `<text x="${x}" y="${y}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(t)}</text>`;
const arrow = (x1, y1, x2, y2, color = C.accent) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" marker-end="url(#rh)"/>`;
const marker = `<defs><marker id="rh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${C.accent}"/></marker></defs>`;
const bullet = (x, y, arr) => (arr.length ? arr : ["—"]).slice(0, 3).map((s, i) => text(x + 14, y + i * 16, `• ${s}`, { size: 11, fill: C.muted })).join("");

let s = "";
// Title
s += box(20, 20, W - 40, 46, { stroke: C.accent, fill: "#0b1224", rx: 12 });
s += text(40, 50, "Knowledge retrieval · pluggable behind the Retriever interface", { size: 17, weight: "700", fill: C.accent });
s += text(W - 40, 50, "default: keyword (zero-dep)  ·  opt-in: vector RAG", { size: 12, weight: "600", fill: C.muted, anchor: "end" });

// L1: two callers
s += box(120, 92, 300, 44, { stroke: C.ok });
s += text(270, 112, "search_knowledge", { anchor: "middle", weight: "700", fill: C.ok });
s += text(270, 128, "SDK tool (official RAG entry)", { anchor: "middle", size: 10, fill: C.muted });
s += box(480, 92, 300, 44, { stroke: C.ok });
s += text(630, 112, "GET /knowledge/search", { anchor: "middle", weight: "700", fill: C.ok });
s += text(630, 128, "REST (same retriever, single source)", { anchor: "middle", size: 10, fill: C.muted });

// L2: Retriever interface
s += box(250, 168, 400, 40, { stroke: C.gold });
s += text(450, 193, "interface Retriever { kind; search(query, limit) }", { anchor: "middle", size: 12, fill: C.gold });

// L3: implementations
s += box(90, 238, 320, 44, { stroke: C.accent });
s += text(250, 258, (retrievers[0] ?? "KeywordRetriever") + "  ·  default", { anchor: "middle", weight: "700", fill: C.accent });
s += text(250, 274, "in-process keyword scoring", { anchor: "middle", size: 10, fill: C.muted });
s += box(490, 238, 320, 44, { stroke: C.violet });
s += text(650, 258, (retrievers[1] ?? "VectorRetriever") + "  ·  PI_KNOWLEDGE_RETRIEVAL=vector", { anchor: "middle", weight: "700", fill: C.violet, size: 11 });
s += text(650, 274, "chunk → embed → cosine → aggregate by doc", { anchor: "middle", size: 10, fill: C.muted });

// L4: the two pluggable interfaces (under VectorRetriever)
s += box(360, 320, 250, 34, { stroke: C.warn });
s += text(485, 342, "EmbeddingProvider", { anchor: "middle", weight: "700", fill: C.warn });
s += box(640, 320, 220, 34, { stroke: C.warn });
s += text(750, 342, "VectorStore", { anchor: "middle", weight: "700", fill: C.warn });

// L5: concrete backends (dynamic)
s += box(300, 372, 340, 78, { stroke: C.stroke });
s += text(314, 392, "implementations:", { size: 11, weight: "600", fill: C.text });
s += bullet(314, 408, embeddingProviders);
s += box(660, 372, 210, 78, { stroke: C.stroke });
s += text(674, 392, "implementations:", { size: 11, weight: "600", fill: C.text });
s += bullet(674, 408, stores);

// Arrows
s += arrow(270, 136, 420, 168);
s += arrow(630, 136, 480, 168);
s += arrow(400, 208, 250, 238);
s += arrow(500, 208, 650, 238);
s += arrow(600, 282, 485, 320);
s += arrow(700, 282, 750, 320);
s += arrow(485, 354, 470, 372, C.warn);
s += arrow(750, 354, 765, 372, C.warn);

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="pi-starter knowledge retrieval">
  <title>pi-starter knowledge retrieval</title>
  <desc>Pluggable knowledge retrieval: the search_knowledge tool and REST /knowledge/search share one Retriever. KeywordRetriever is the zero-dependency default; VectorRetriever (opt-in) composes an EmbeddingProvider and a VectorStore. Backend class names are read from source at generation time.</desc>
  <style>svg { background: ${C.bg}; } text { paint-order: stroke fill; }</style>
  ${marker}
  <rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
  ${s}
</svg>
`;

// `--check`：只比对、不写盘，漂移退出 1（接进 `npm run docs:check`）。理由同
// `generate_architecture.mjs`。
const check = process.argv.includes("--check");
const previous = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
if (check) {
  if (previous === svg) {
    console.log(`一致：${outPath}`);
  } else {
    console.error(
      `漂移：${outPath} —— 跑 node scripts/visualization/generate_retrieval.mjs 重新生成`
    );
    process.exit(1);
  }
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, svg, "utf8");
  console.log("wrote", outPath);
}
console.log("  retrievers         :", retrievers.join(", ") || "—");
console.log("  embedding providers:", embeddingProviders.join(", ") || "—");
console.log("  vector stores      :", stores.join(", ") || "—");
