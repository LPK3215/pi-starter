#!/usr/bin/env node
/**
 * generate_architecture.mjs
 *
 * Purpose:
 *   Regenerate `docs/architecture.svg`, the layered architecture diagram of
 *   pi-starter. All counts (deps, tools, skills, endpoints, SSE events, tests,
 *   version) are read at generation time from the actual repository so the
 *   SVG never drifts from the code.
 *
 * Dependencies:
 *   Node.js built-ins only (`node:fs`, `node:path`). No npm install required.
 *
 * Run:
 *   node scripts/visualization/generate_architecture.mjs
 *
 * Output:
 *   docs/architecture.svg (1080 x 720, English text nodes per repo doc policy)
 *
 * Notes:
 *   - Text inside SVG is English; Chinese explanations live in the README figure caption.
 *   - One file only, no language suffix. Both README.md and README.zh-CN.md reference the same file.
 *   - Do NOT delete this script; future diagram updates reuse it.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectMetrics } from "./metrics.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const outPath = join(repoRoot, "docs", "architecture.svg");

// ---------- truth sources ----------

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

function readSafe(rel) {
  const p = join(repoRoot, rel);
  return existsSync(p) && statSync(p).isFile() ? readFileSync(p, "utf8") : "";
}

function listTs(dirRel, { excludeTest = false, exclude = [] } = {}) {
  const abs = join(repoRoot, dirRel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((n) => n.endsWith(".ts") && !exclude.includes(n))
    .filter((n) => !(excludeTest && n.endsWith(".test.ts")));
}

// Registered tool names: extracted from `name: "..."` strings inside every tool file under src/tools/
const toolNames = (() => {
  const dir = join(repoRoot, "src", "tools");
  if (!existsSync(dir)) return [];
  const names = new Set();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f === "index.ts" || f.endsWith(".test.ts")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/\bname:\s*"([a-z_][a-z0-9_]*)"/g)) names.add(m[1]);
  }
  return [...names];
})();

// Registered extensions
const extensionNames = (() => {
  const idx = readSafe("src/extensions/index.ts");
  const m = idx.match(/allExtensions\s*:\s*ExtensionFactory\[\]\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/(\w+Extension)\b/g)].map((x) => x[1].replace(/Extension$/, ""));
})();

// Skills: subdirectories with SKILL.md
const skillNames = (() => {
  const abs = join(repoRoot, "src", "skills");
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => existsSync(join(abs, d.name, "SKILL.md")))
    .map((d) => d.name);
})();

// Knowledge Markdown docs (top level of src/knowledge)
const knowledgeDocs = (() => {
  const abs = join(repoRoot, "src", "knowledge");
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((n) => n.endsWith(".md"));
})();

// HTTP endpoints declared in src/app.ts
const endpoints = (() => {
  const src = readSafe("src/app.ts");
  return [...src.matchAll(/app\.(get|post|put|delete)\(\s*"([^"]+)"/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
})();

// SSE event names emitted by src/sse.ts and src/app.ts (union, in first-seen order)
const sseEvents = (() => {
  const seen = new Set();
  for (const rel of ["src/sse.ts", "src/app.ts"]) {
    const src = readSafe(rel);
    for (const m of src.matchAll(/sse\(\s*"([a-z_]+)"/g)) seen.add(m[1]);
  }
  // app.ts also emits `done` and `error` directly
  for (const m of readSafe("src/app.ts").matchAll(/"(done|error)"/g)) seen.add(m[1]);
  return [...seen];
})();

// Test counts — read from `metrics.mjs`, the single source behind the README table and the
// overview page. This used to walk `*.test.ts` on disk on its own: the numbers agreed, but the
// disk walk counts files `npm test` never runs, so a deregistered test would have kept the SVG
// green while the README dropped it.
const metrics = collectMetrics();
const testFileCount = metrics.testFiles;
const testCases = metrics.testCases;

// ---------- render ----------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const shortList = (arr, n = 5) => (arr.length ? arr.slice(0, n).join(", ") + (arr.length > n ? ` +${arr.length - n}` : "") : "—");

const W = 1080;
const H = 720;

// Layer palette (dark-mode-friendly, single set — SVG is English and language-agnostic)
const C = {
  bg: "#0f172a",
  panel: "#1e293b",
  panelStroke: "#334155",
  text: "#e2e8f0",
  muted: "#94a3b8",
  accent: "#38bdf8",
  warn: "#f472b6",
  ok: "#22c55e",
  gold: "#facc15",
};

const box = (x, y, w, h, { stroke = C.panelStroke, fill = C.panel, rx = 10 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`;

const text = (x, y, t, { size = 13, weight = "400", fill = C.text, anchor = "start" } = {}) =>
  `<text x="${x}" y="${y}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(t)}</text>`;

const arrow = (x1, y1, x2, y2, color = C.accent) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" marker-end="url(#ah)"/>`;

const arrowMarkerDef = (color = C.accent) =>
  `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker></defs>`;

const chip = (x, y, w, h, label, color) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${color}" opacity="0.14" stroke="${color}" stroke-width="1"/><text x="${x + w / 2}" y="${y + h / 2 + 4}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" fill="${color}" text-anchor="middle">${esc(label)}</text>`;

// Header band
const header = `
  ${box(20, 20, W - 40, 58, { stroke: C.accent, fill: "#0b1224", rx: 12 })}
  ${text(40, 55, `pi-starter · agent scaffold on the pi-agent SDK`, { size: 20, weight: "700", fill: C.accent })}
  ${text(W - 40, 55, `v${pkg.version} · Node ${pkg.engines?.node ?? ""}`, { size: 14, weight: "600", fill: C.muted, anchor: "end" })}
`;

// Row 1: Entry points (CLI / HTTP+SSE / WebSocket / Library / RPC) — five transports
const y1 = 100;
const rowH = 90;
const entries = [
  { title: "CLI", sub: "npm run dev", extra: "src/index.ts · /model, /cycle" },
  { title: "HTTP + SSE", sub: "npm run web", extra: `app.ts · ${endpoints.length} endpoints` },
  { title: "WebSocket", sub: "GET /ws?session=", extra: "transport/ws.ts · snapshot+rev" },
  { title: "Library", sub: "buildAgent()", extra: "src/lib.ts · dist" },
  { title: "RPC stdio", sub: "--mode rpc", extra: "src/rpc.ts · JSONL" },
];
const entryW = (W - 60) / entries.length;
let row1 = "";
entries.forEach((e, i) => {
  const x = 30 + i * (entryW + 5);
  row1 += box(x, y1, entryW - 5, rowH, { stroke: C.accent });
  row1 += text(x + 16, y1 + 26, e.title, { size: 15, weight: "700", fill: C.accent });
  row1 += text(x + 16, y1 + 48, e.sub, { size: 12, fill: C.text });
  row1 += text(x + 16, y1 + 68, e.extra, { size: 11, fill: C.muted });
});

// Row 2: Assembly (agent.ts) — spans full width
const y2 = y1 + rowH + 20; // 210
const row2H = 84;
let row2 = "";
row2 += box(30, y2, W - 60, row2H, { stroke: C.gold });
row2 += text(50, y2 + 26, "Assembly · src/agent.ts", { size: 15, weight: "700", fill: C.gold });
row2 += text(50, y2 + 50, "model + prompts + tools + skills + knowledge(+retrieval) + memory + database + extensions → AgentSession · scopedModels cycling", { size: 12, fill: C.text });
row2 += text(50, y2 + 70, `config precedence: CLI flags > .env > default · built-in tools tier = "${process.env.PI_BUILTIN_TOOLS_HINT ?? "off"}"`, { size: 11, fill: C.muted });

// Row 3: Business resources (4 columns)
const y3 = y2 + row2H + 20; // 314
const row3H = 148;
const cards = [
  { title: "Tools", items: toolNames, note: "src/tools/", color: C.ok },
  { title: "Skills", items: skillNames, note: "src/skills/<name>/SKILL.md", color: C.ok },
  { title: "Knowledge", items: knowledgeDocs.map((n) => n.replace(/\.md$/, "")), note: "src/knowledge/*.md · retrieval: keyword | vector", color: C.ok },
  { title: "Extensions", items: extensionNames, note: "src/extensions/", color: C.warn },
];
const colW = (W - 60) / cards.length;
let row3 = "";
cards.forEach((c, i) => {
  const x = 30 + i * (colW + 5);
  row3 += box(x, y3, colW - 5, row3H, { stroke: c.color });
  row3 += text(x + 16, y3 + 26, c.title, { size: 15, weight: "700", fill: c.color });
  row3 += text(x + 16, y3 + 46, c.note, { size: 10, fill: C.muted });
  row3 += text(x + 16, y3 + 68, `${c.items.length} registered:`, { size: 11, weight: "600", fill: C.text });
  // list items (up to 4 lines of 1 item each)
  const showItems = c.items.slice(0, 4);
  showItems.forEach((it, k) => {
    row3 += text(x + 16, y3 + 88 + k * 16, `• ${it}`, { size: 11, fill: C.text });
  });
  if (c.items.length > 4) {
    row3 += text(x + 16, y3 + 88 + 4 * 16, `+${c.items.length - 4} more`, { size: 10, fill: C.muted });
  }
  if (c.items.length === 0) {
    row3 += text(x + 16, y3 + 88, "(empty)", { size: 11, fill: C.muted });
  }
});

// Row 4: HTTP contract + SSE translator
const y4 = y3 + row3H + 20; // 482
const row4H = 66;
let row4 = "";
const halfW = (W - 60) / 2;
row4 += box(30, y4, halfW - 5, row4H, { stroke: C.accent });
row4 += text(46, y4 + 24, "HTTP contract · src/app.ts", { size: 13, weight: "700", fill: C.accent });
row4 += text(46, y4 + 44, `${endpoints.length} endpoints:`, { size: 11, fill: C.text });
row4 += text(46, y4 + 58, shortList(endpoints, 6), { size: 10, fill: C.muted });

row4 += box(35 + halfW, y4, halfW - 5, row4H, { stroke: C.accent });
row4 += text(50 + halfW, y4 + 24, "SSE translator · src/sse.ts", { size: 13, weight: "700", fill: C.accent });
row4 += text(50 + halfW, y4 + 44, `${sseEvents.length} event types:`, { size: 11, fill: C.text });
row4 += text(50 + halfW, y4 + 58, sseEvents.join(" · "), { size: 10, fill: C.muted });

// Row 5: Runtime deps + config
const y5 = y4 + row4H + 18; // 566
const row5H = 108;
let row5 = "";
// Left half: SDK + Node
row5 += box(30, y5, halfW - 5, row5H, { stroke: C.muted });
row5 += text(46, y5 + 22, "Runtime", { size: 13, weight: "700", fill: C.text });
const deps = Object.entries(pkg.dependencies || {});
deps.forEach(([k, v], i) => {
  row5 += text(46, y5 + 42 + i * 14, `• ${k} @ ${v}`, { size: 10, fill: C.muted });
});

// Right half: user config
const cx = 35 + halfW;
row5 += box(cx, y5, halfW - 5, row5H, { stroke: C.muted });
row5 += text(cx + 16, y5 + 22, "Configuration surface", { size: 13, weight: "700", fill: C.text });
row5 += text(cx + 16, y5 + 42, "• .env (PI_MODEL / PI_MODELS / PI_API_KEY / PI_BUILTIN_TOOLS / PI_DATABASE_PATH)", { size: 10, fill: C.muted });
row5 += text(cx + 16, y5 + 58, "• ~/.pi/agent/models.json  ← npm run setup (merge-write)", { size: 10, fill: C.muted });
row5 += text(cx + 16, y5 + 74, "• ~/.pi/agent/auth.json    ← mode 0o600, --force to overwrite", { size: 10, fill: C.muted });
row5 += text(cx + 16, y5 + 90, `• Contract smoke tests: ${testFileCount} files · ${testCases} cases`, { size: 10, fill: C.muted });
row5 += text(cx + 16, y5 + 104, "• PI_SCOPED_MODELS · PI_KNOWLEDGE_RETRIEVAL=vector · PI_EMBEDDINGS_* · Dockerfile", { size: 10, fill: C.muted });

// Arrows between rows (single column, centered)
let arrows = "";
arrows += arrow(W / 2, y1 + rowH + 2, W / 2, y2 - 4);
arrows += arrow(W / 2, y2 + row2H + 2, W / 2, y3 - 4);
arrows += arrow(W / 2, y3 + row3H + 2, W / 2, y4 - 4);
arrows += arrow(W / 2, y4 + row4H + 2, W / 2, y5 - 4);

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="pi-starter architecture">
  <title>pi-starter architecture</title>
  <desc>Layered view of pi-starter: entry points, assembly, business resources, HTTP+SSE contract, and runtime configuration. All counts and names are read from the actual source files at generation time.</desc>
  <style>
    svg { background: ${C.bg}; }
    text { paint-order: stroke fill; }
  </style>
  ${arrowMarkerDef()}
  <rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
  ${header}
  ${row1}
  ${row2}
  ${row3}
  ${row4}
  ${row5}
  ${arrows}
</svg>
`;

/**
 * `--check`：只比对、不写盘，漂移就退出 1（接进 `npm run docs:check`）。
 *
 * 为什么需要：本生成器一直是「跑一次就新鲜一次」，而**没有任何东西保证它被跑过**。
 * 实际漂移过一次：README 上的架构图写着 `Contract smoke tests: 49 files · 470 cases`，
 * 当时源码里已经是 `53 files · 504 cases` —— 图里的数字比手写文档更危险，因为它看起来是
 * 机器生成的、于是不受怀疑。现在它与 README 数字、参考手册共用同一条门禁。
 */
const check = process.argv.includes("--check");
const previous = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
if (check) {
  if (previous === svg) {
    console.log(`一致：${outPath}`);
  } else {
    console.error(
      `漂移：${outPath} —— 跑 node scripts/visualization/generate_architecture.mjs 重新生成`
    );
    process.exit(1);
  }
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, svg, "utf8");

  // Report what was picked up so drift is visible in the terminal too.
  console.log("wrote", outPath);
}
console.log("  version        :", pkg.version);
console.log("  node engines   :", pkg.engines?.node);
console.log("  deps           :", deps.length);
console.log("  tools          :", toolNames.length, "→", toolNames.join(", "));
console.log("  skills         :", skillNames.length, "→", skillNames.join(", "));
console.log("  knowledge docs :", knowledgeDocs.length, "→", knowledgeDocs.join(", "));
console.log("  extensions     :", extensionNames.length, "→", extensionNames.join(", "));
console.log("  http endpoints :", endpoints.length);
console.log("  sse events     :", sseEvents.length, "→", sseEvents.join(", "));
console.log("  tests          :", testFileCount, "files ·", testCases, "cases");
