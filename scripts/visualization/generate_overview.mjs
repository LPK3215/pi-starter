#!/usr/bin/env node
/**
 * pi-starter · 全景页（docs/project_overview）生成器
 *
 * 为什么需要它：这个页面原先整页手写，于是代码跑到 v0.4.1 时它还停在 v0.2.0——
 * 「308 cases · 37 files」、`src/` 树里没有 `conversation/` 和 `memory/`、
 * API 表里挂着 `/interrupt`、`/compact`、`/mcp/servers`、`/subagents/run` 这几条
 * **根本不存在的 REST 路由**（它们是 WS 命令或工具，不是路由）。手写页面腐烂不是偶发事故，
 * 是必然：没有任何检查拿它跟代码比过。
 *
 * 这个脚本把「会腐烂的部分」——数值、文件清单、路由表、门禁列表——从源码生成，
 * 并且把「手写但必须齐平的部分」拿来断言：
 *
 *   1. `script.js` 里 `BEGIN/END:generated-metrics` 之间的 METRICS 对象（唯一数值来源）；
 *   2. `index.html` 里 `data-metric` 元素的文本——生成器把它们写成同一个值，
 *      所以**关掉 JS 也和开着 JS 一致**，而 CI 能发现两者不同；
 *   3. `BEGIN/END:generated-*` 标记区：src 顶层文件清单、docs / scripts / 根目录清单、
 *      完整 REST 路由表、`npm run verify` 的门禁列表；
 *   4. 名片页 `project_card.html`（一键导出 PNG 的长图）的徽章、数字卡与许可行——
 *      它和全景页读同一份 metrics，所以两份页面上的同一个数**永远相等**，
 *      不靠「记得两边一起改」；
 *   5. 断言：`src/` 的每个子目录都在结构树里、每个 `docs/*.md` 都在文档索引里、
 *      每条真实路由都归入且只归入一个分组（漏一条就红）、每个本地引用文件都存在、
 *      引用路径全部相对且外部链接一律 https、两份页面都是纯英文。
 *
 * 用法：
 *   node scripts/visualization/generate_overview.mjs           # 写入
 *   node scripts/visualization/generate_overview.mjs --check    # 只校验（CI 用）
 *
 * 退出码：0 = 一致 / 已写入；1 = --check 发现漂移；2 = 结构坏了（标记丢失、断言失败、
 * 引用指向不存在的文件）。断言在写入模式下同样是 2——「先写进去再说」正是腐烂的起点。
 *
 * `generatedAt` 只在**别的内容真的变了**的时候更新：把时间戳放进受检产物会让 `--check`
 * 每天无缘无故红一次，那种红很快就会被当成噪声跳过，然后整个门禁失效。
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { collectMetrics, ROOT } from "./metrics.mjs";

const DIR = join(ROOT, "docs", "project_overview");
const HTML_FILE = join(DIR, "index.html");
const JS_FILE = join(DIR, "script.js");
const CARD_FILE = join(DIR, "project_card.html");

const METRICS_BEGIN = "/* BEGIN:generated-metrics */";
const METRICS_END = "/* END:generated-metrics */";

const problems = [];
const fail = (message) => problems.push(message);

const esc = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 清单来自 `git ls-files`，不是 `readdirSync`。
 *
 * 页面要说的是「仓库里有什么」，而工作目录里还躺着 `.env`、`logs/`、`dist/`、
 * 各种本地草稿目录——用文件系统列，这些会被一并印到公开页面上。
 *
 * `-z` 与 `core.quotePath=false` 不是可有可无的：git 默认把非 ASCII 路径转义成
 * `"docs/\344\275\277..."`。开发机常把 `core.quotePath` 关成 false，于是本地全绿；
 * CI 容器不继承这份 gitconfig，中文文件名一进转义就与页面里的清单对不上——
 * 这条实测踩过一次：远端 `docs:overview:check` 报漂移，本地怎么跑都是绿的。
 */
function trackedTopLevel(dirRel) {
  let out;
  try {
    out = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-z", dirRel], {
      cwd: ROOT,
      encoding: "utf8",
    });
  } catch (err) {
    fail(`git ls-files ${dirRel} failed; the listing cannot be trusted, so nothing is generated`);
    return { files: [], dirs: [] };
  }
  const prefix = dirRel === "." ? "" : `${dirRel.replace(/\/$/, "")}/`;
  const files = new Set();
  const dirs = new Set();
  for (const line of out.split("\0").filter(Boolean)) {
    const rest = line.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) files.add(rest);
    else dirs.add(rest.slice(0, slash));
  }
  return { files: [...files].sort(), dirs: [...dirs].sort() };
}

const code = (name) => `<code>${esc(name)}</code>`;
const joinDots = (items) => items.join(" · ");

// ---------- 路由表 ----------

/**
 * 分组与说明是手写的，**路径集合不是**：生成器拿 `metrics.routeHandlers()` 的真实注册逐条核对，
 * 一条真实路由落不进任何分组、或一个分组里的路径在代码里不存在，都会让构建变红。
 * 这就是本页原先那种「API 表里写着 /interrupt」的条目再也出不来的原因。
 */
const API_GROUPS = [
  {
    title: "Health &amp; introspection",
    routes: [
      ["/health", "Liveness: reports the running mode and the bound model."],
      ["/health/ready", "Readiness: each dependency is checked separately and reported as it is, so a stale claim cannot pass as ready."],
      ["/metrics", "Cumulative counters and gauges (turns, tokens, pending approvals); <code>?format=prometheus</code> for the exposition format."],
      ["/info", "Capability snapshot of the live session: model, tools, skills, knowledge, limits."],
    ],
  },
  {
    title: "Chat, models &amp; context",
    routes: [
      ["/chat", "Stream one prompt: SSE by default, <code>?format=jsonl</code> for the raw event stream."],
      ["/model", "Switch the model on the shared session."],
      ["/model/cycle", "Rotate to the next model in <code>scopedModels</code>."],
      ["/providers", "Configured providers with their <code>checkAuth</code> result."],
      ["/context/compact", "Compact the context now; auto-compaction runs on its own budget."],
    ],
  },
  {
    title: "Resources: skills, knowledge, templates",
    routes: [
      ["/skills", "Registered skills (name + description)."],
      ["/skills/:name", "One skill's full <code>SKILL.md</code>."],
      ["/knowledge", "Knowledge documents in scope."],
      ["/knowledge/:name", "One document, verbatim."],
      ["/knowledge/search", "Search through the same <code>Retriever</code> the <code>search_knowledge</code> tool uses — there is no second implementation to drift."],
      ["/prompt-templates", "Templates available as <code>/name</code>."],
      ["/prompt-templates/:name", "One template body."],
    ],
  },
  {
    title: "Database (read-only)",
    routes: [
      ["/db", "Tables and row counts."],
      ["/db/notes", "Rows of the seeded <code>notes</code> table."],
      ["/db/notes/:id", "One row by id."],
      ["/db/query", "Run SQL. <code>SELECT</code> only — writes are rejected before the statement reaches sqlite."],
    ],
  },
  {
    title: "Cross-session memory",
    note: "Mounted only when memory is on (<code>PI_MEMORY=off</code> removes these routes).",
    routes: [
      ["/memory", "List the stored facts, or write one."],
      ["/memory/:id", "Delete one fact by id."],
    ],
  },
  {
    title: "Workspace files",
    note: "Mounted only when a <code>FileService</code> is wired; every path goes through the fail-closed guard and is audited.",
    routes: [
      ["/files/list", "Directory listing."],
      ["/files/read", "File as text (binary extensions are refused)."],
      ["/files/raw", "File as bytes, for download."],
      ["/files/write", "Replace a file's contents; creates parent directories, enforces a size cap."],
      ["/files/create", "Create a file — conflicts if it already exists."],
      ["/files/rename", "Rename / move inside the workspace; target must not exist."],
      ["/files/copy", "Copy inside the workspace."],
      ["/files/delete", "Delete a file, or a subtree when <code>recursive</code> is set."],
      ["/files/upload", "Upload a file into the workspace."],
    ],
  },
  {
    title: "Approval rules",
    note: "Mounted only when a rules store is wired.",
    routes: [
      ["/approval/rules", "List the effective rules (user first, built-in flagged), replace the whole user set, or add one. Built-in rules are read-only and every rule is re-validated on the way in — the same validator that guards the on-disk file."],
      ["/approval/rules/:id", "Delete one user rule."],
    ],
  },
  {
    title: "Provider keys",
    note: "Mounted only when a key store is wired; stored secrets are never echoed back.",
    routes: [
      ["/provider-keys", "List providers with their key names and which is active, or store a key. The first key becomes active and is applied to the live session."],
      ["/provider-keys/activate", "Activate a stored key through the same path as a model switch, so no conversation keeps using the old one."],
      ["/provider-keys/remove", "Remove a stored key."],
    ],
  },
  {
    title: "Runtime settings, tools &amp; sessions",
    note: "Mounted only when the tool registry / settings service is wired.",
    routes: [
      ["/settings", "Read, or merge a partial update into the runtime settings (persisted; unknown fields are rejected)."],
      ["/tools/:name/enabled", "Enable or disable a tool for the running session."],
      ["/capabilities", "The capability matrix — the same object the WebSocket <code>capabilities</code> frame sends."],
      ["/sessions/import", "Import an existing session file and resume from it."],
    ],
  },
  {
    title: "Structured logs",
    note: "Mounted only when a log directory is configured.",
    routes: [
      ["/logs", "Query entries by level, module, request id or keyword, with cursor paging over the daily files."],
      ["/logs/stats", "Counts per level and module for the same selection."],
    ],
  },
];

const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const METHOD_CLASS = { GET: "m-get", POST: "m-post", PUT: "m-put", PATCH: "m-patch", DELETE: "m-delete" };

/** 真实注册 → `path -> [METHOD, ...]`，顺序按 METHOD_ORDER。 */
function routeMethods(handlers) {
  const byPath = new Map();
  for (const { method, path } of handlers) {
    if (!byPath.has(path)) byPath.set(path, new Set());
    byPath.get(path).add(method);
  }
  const out = new Map();
  for (const [path, set] of byPath) {
    out.set(path, METHOD_ORDER.filter((m) => set.has(m)));
  }
  return out;
}

function apiTable(handlers) {
  const byPath = routeMethods(handlers);
  const grouped = new Set();
  const rows = [];
  for (const group of API_GROUPS) {
    const body = [];
    for (const [path, purpose] of group.routes) {
      if (!byPath.has(path)) {
        fail(`route table lists ${path}, which no longer exists in the code`);
        continue;
      }
      if (grouped.has(path)) fail(`route ${path} falls into more than one group`);
      grouped.add(path);
      const badges = byPath
        .get(path)
        .map((method) => `<span class="${METHOD_CLASS[method]}">${method}</span>`)
        .join(" ");
      body.push(`<tr><td>${badges} ${esc(path)}</td><td>${purpose}</td></tr>`);
    }
    const head = group.note
      ? `<tr><th colspan="2">${group.title} — ${group.note}</th></tr>`
      : `<tr><th colspan="2">${group.title}</th></tr>`;
    rows.push(head, ...body);
  }
  for (const path of byPath.keys()) {
    if (!grouped.has(path)) fail(`route ${path} matches no group: add it to API_GROUPS, or the table silently omits it`);
  }
  return [
    `<div class="table-wrap">`,
    `<table>`,
    `<thead><tr><th>Method · path</th><th>Purpose</th></tr></thead>`,
    `<tbody>`,
    ...rows,
    `</tbody>`,
    `</table>`,
    `</div>`,
  ].join("\n");
}

// ---------- 标记区 ----------

/**
 * 替换 `<!-- BEGIN:name -->` 与 `<!-- END:name -->` 之间的内容。
 * 标记丢失时不猜位置：静默插入一份副本，页面上就会出现两个「唯一」的清单。
 */
function replaceRegion(html, name, content, where = "index.html") {
  const begin = `<!-- BEGIN:${name} -->`;
  const end = `<!-- END:${name} -->`;
  const from = html.indexOf(begin);
  const to = html.indexOf(end);
  if (from < 0 || to < 0 || to < from) {
    fail(`${where} is missing the ${begin} / ${end} region`);
    return html;
  }
  return `${html.slice(0, from + begin.length)}\n${content}\n${html.slice(to)}`;
}

const regionContent = {
  "generated-src-root": (m) => {
    const helpers = shippedExcludes();
    const items = m.srcRootFiles.map((name) =>
      helpers.has(name) ? `${code(name)} <span class="cm">(test helper, not in dist)</span>` : code(name),
    );
    return `<div class="leaf files">Top-level, non-test (${m.srcRootFiles.length}): ${joinDots(items)}</div>`;
  },
  "generated-docs-tree": () => {
    const t = trackedTopLevel("docs");
    const entries = [...t.files.map((f) => code(f)), ...t.dirs.map((d) => code(`${d}/`))];
    return `<details><summary><span class="dir">docs/</span> — ${entries.length} entries, generated and hand-written</summary><div class="leaf">${joinDots(entries)}</div></details>`;
  },
  "generated-scripts-tree": () => {
    const t = trackedTopLevel("scripts");
    const entries = [...t.files.map((f) => code(f)), ...t.dirs.map((d) => code(`${d}/`))];
    return `<details><summary><span class="dir">scripts/</span> — generators, gates and smoke runners</summary><div class="leaf">${joinDots(entries)}</div></details>`;
  },
  "generated-root-tree": () => {
    const t = trackedTopLevel(".");
    const files = t.files.filter((name) => name !== "package-lock.json");
    // src/, docs/, scripts/, web/ and .github/ each already have their own entry in the tree.
    const dirs = t.dirs.filter((name) => !["src", "docs", "scripts", "web", ".github"].includes(name));
    return `<div class="leaf">Root: ${joinDots([...files.map((f) => code(f)), ...dirs.map((d) => code(`${d}/`))])} — tracked files only (<code>git ls-files</code>), so local scratch directories never reach the page.</div>`;
  },
  "generated-gates": (m) => `<code>${m.gates.join("</code> · <code>")}</code>`,
  "generated-api-table": (m) => apiTable(m.routeHandlers),
};

/**
 * 名片页（`project_card.html`）的生成区。
 *
 * 数值与全景页同源：两处读的都是同一份 metrics，所以「名片上 505、全景页上 600」
 * 这种事在结构上就不可能出现——而不是靠人记得两边一起改。
 */
const cardRegions = {
  "generated-card-chips": (m) =>
    `<ul class="hero-chips">
      <li><span class="bl">release</span> ${esc(m.releaseTag)}</li>
      <li><span class="bl">node</span> ${esc(m.enginesNode)}</li>
      <li><span class="bl">license</span> ${esc(m.license)}</li>
      <li><span class="bl">upstream</span> pi-coding-agent ${esc(m.sdkVersion)}</li>
    </ul>`,
  "generated-card-metrics": (m) =>
    [
      `<div class="metric"><span class="num">${m.testCases}</span><span class="label">test cases, offline, no real model call</span></div>`,
      `<div class="metric"><span class="num">${m.routes}</span><span class="label">HTTP route handlers</span></div>`,
      `<div class="metric"><span class="num">${m.srcFiles}</span><span class="label">backend source files</span></div>`,
      `<div class="metric"><span class="num">${m.gateCount}</span><span class="label">gates in npm run verify</span></div>`,
    ].join("\n      "),
  "generated-card-license": (m) =>
    `<span class="lic">${esc(m.license)} License © ${esc(m.copyright)} · ${esc(m.repoSlug)}</span>`,
};

/** `tsconfig.build.json` 的排除项 —— 用来标出「源码里有但包里不带」的测试助手。 */
function shippedExcludes() {
  const config = JSON.parse(readFileSync(join(ROOT, "tsconfig.build.json"), "utf8"));
  const set = new Set();
  for (const entry of config.exclude ?? []) {
    const parts = String(entry).split("/");
    if (parts[0] === "src" && parts.length === 2 && !parts[1].includes("*")) set.add(parts[1]);
  }
  return set;
}

// ---------- METRICS ----------

/**
 * 页面能显示的数值只有这一份。键名即 `data-metric` 属性值；新增数字时先加到这里，
 * 再在页面里引用，否则「引用了不存在的指标」那条断言会红。
 */
function buildMetrics(m) {
  return {
    version: m.version,
    releaseTag: `v${m.version}`,
    license: m.license,
    copyright: m.copyright,
    repoSlug: m.repoSlug,
    enginesNode: m.enginesNode,
    sdkVersion: m.deps.sdk,
    expressVersion: m.deps.express,
    typeboxVersion: m.deps.typebox,
    wsVersion: m.deps.ws,
    transformersVersion: m.deps.transformers,
    typescriptVersion: m.deps.typescript,
    reactVersion: m.deps.react,
    viteVersion: m.deps.vite,
    assistantUiVersion: m.deps.assistantUi,
    maxOpenConversations: m.runtime.maxOpenConversations,
    wsPath: m.runtime.wsPath,
    defaultHost: m.runtime.defaultHost,
    srcFiles: m.srcFiles,
    srcLines: m.srcLines,
    testFiles: m.testFiles,
    testCases: m.testCases,
    frontendCases: m.frontendCases,
    webFiles: m.webFiles,
    webLines: m.webLines,
    routes: m.routes,
    docFiles: m.docFiles,
    largestFile: m.largestFile,
    largestLines: m.largestLines,
    smokeChecks: m.smokeChecks,
    e2eChecks: m.e2eChecks,
    gateCount: m.gates.length,
    covLines: m.coverage.lines,
    covBranches: m.coverage.branches,
    covFunctions: m.coverage.functions,
    generatedAt: "",
  };
}

const EXISTING_PATTERN = /var METRICS = (\{[\s\S]*?\});/;

function readExistingMetrics(js) {
  const match = EXISTING_PATTERN.exec(js);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function withoutGeneratedAt(object) {
  const { generatedAt, ...rest } = object;
  void generatedAt;
  return rest;
}

/** 写入 JS 块；只有别的内容变了才换时间戳（见文件头说明）。 */
function applyMetricsBlock(js, metrics) {
  const from = js.indexOf(METRICS_BEGIN);
  const to = js.indexOf(METRICS_END);
  if (from < 0 || to < 0 || to < from) {
    fail(`script.js is missing the ${METRICS_BEGIN} / ${METRICS_END} block`);
    return { js, metrics };
  }
  const existing = readExistingMetrics(js.slice(from, to));
  const next = { ...metrics };
  if (existing && JSON.stringify(withoutGeneratedAt(existing)) === JSON.stringify(withoutGeneratedAt(next))) {
    next.generatedAt = existing.generatedAt;
  } else {
    next.generatedAt = new Date().toISOString().slice(0, 10);
  }
  const block = `var METRICS = ${JSON.stringify(next, null, 2)};`;
  return {
    js: `${js.slice(0, from + METRICS_BEGIN.length)}\n  ${block}\n  ${js.slice(to)}`,
    metrics: next,
  };
}

const DATA_METRIC = /<([a-zA-Z]+)((?:\s[^>]*?)?\sdata-metric="([^"]+)"[^>]*)>([^<]*)<\/\1>/g;

/** 把 `data-metric` 元素的文本写成同一个值：无 JS 渲染 == 有 JS 渲染。 */
function applyFallbacks(html, metrics) {
  let changed = 0;
  const out = html.replace(DATA_METRIC, (whole, tag, attrs, name, current) => {
    if (!(name in metrics)) {
      fail(`index.html references unknown metric ${name}: add it to buildMetrics or drop the data-metric`);
      return whole;
    }
    // Compare against the escaped form: on the second run the file already holds `&gt;=22.19`,
    // and re-escaping that would yield `&amp;gt;=22.19` — the check would never settle.
    const value = esc(String(metrics[name]));
    if (value === current) return whole;
    changed += 1;
    return `<${tag}${attrs}>${value}</${tag}>`;
  });
  return { html: out, changed };
}

// ---------- 断言 ----------

function assertDirsMatchTree(html, metrics) {
  const listed = new Set([...html.matchAll(/<span class="dir">([a-z][a-z0-9-]*)\/<\/span>/g)].map((m) => m[1]));
  for (const dir of metrics.srcDirs) {
    if (!listed.has(dir)) fail(`the structure tree has no entry for src/${dir}/ — add a line for it`);
  }
  const topLevel = trackedTopLevel(".").dirs;
  const shownElsewhere = new Set(["docs", "scripts", "web", ...topLevel]);
  for (const dir of listed) {
    if (!metrics.srcDirs.includes(dir) && !shownElsewhere.has(dir)) {
      fail(`the structure tree lists src/${dir}/, which does not exist in the code`);
    }
  }
}

function assertDocsIndexedListed(html, metrics) {
  for (const name of metrics.docsMdFiles) {
    if (!html.includes(name)) fail(`the docs index is missing docs/${name}`);
  }
  for (const match of html.matchAll(/href="\.\.\/([^"#]+)"/g)) {
    const target = join(DIR, "..", match[1]);
    if (!existsSync(target)) fail(`a link points at docs/${match[1]}, which is not on disk`);
  }
}

/** 相对路径 / https / 本地引用存在 —— GitHub Pages 经典模式下的三类常见断链。 */
function assertReferences(html, where) {
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const value = match[1];
    if (value.startsWith("#") || value.startsWith("mailto:")) continue;
    if (value.includes("\\")) fail(`${where}: reference uses a backslash: ${value}`);
    if (/^[a-z]+:\/\//i.test(value)) {
      if (!value.startsWith("https://")) fail(`${where}: external reference is not https: ${value}`);
      continue;
    }
    if (value.startsWith("/")) fail(`${where}: reference is absolute, which breaks under a Pages subpath: ${value}`);
    const target = join(DIR, value);
    if (!existsSync(target) || !statSync(target).isFile()) fail(`${where}: local reference does not exist: ${value}`);
  }
}

/**
 * 名片与全景页同为英文页（`<html lang="en">`，导出的 PNG 同理）。
 *
 * 只禁 CJK 字符与全角标点：`—`、`©`、`·` 这些是排版符号，不是中文，
 * 把它们也算进去只会让人把检查关掉。
 */
function assertEnglishPage(html, where) {
  const cjk = html.match(/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/g);
  if (cjk) fail(`${where} must stay English-only (found: ${[...new Set(cjk)].slice(0, 8).join(" ")})`);
}

// ---------- main ----------

/** 取出自 `before` 起第一个与 `after` 不同的行对，用于把漂移说清楚。 */
function lineSample(before, after, limit = 3) {
  const a = before.split("\n");
  const b = after.split("\n");
  const out = [];
  for (let i = 0, j = 0; i < a.length || j < b.length; i += 1, j += 1) {
    if (a[i] === b[j]) continue;
    out.push(`    line ${i + 1}: - ${a[i] ?? "(eof)"}`, `    line ${j + 1}: + ${b[j] ?? "(eof)"}`);
    if (out.length / 2 >= limit) break;
  }
  return out.join("\n");
}

/**
 * 漂移时报出**是哪一块、哪一个文件**变了。
 *
 * 只说「drift」的门禁在远端等于没说：CI 日志里看不到上下文，只能靠猜。
 * 上一轮就是靠把 METRICS 键名与标记区名字打出来，才在一条日志里定位到 git 的路径转义。
 */
function describeDrift(pages, beforeJs, afterJs) {
  const report = [];
  const oldMetrics = readExistingMetrics(beforeJs);
  const newMetrics = readExistingMetrics(afterJs);
  if (oldMetrics && newMetrics) {
    const keys = new Set([...Object.keys(oldMetrics), ...Object.keys(newMetrics)]);
    const changed = [...keys].filter((k) => JSON.stringify(oldMetrics[k]) !== JSON.stringify(newMetrics[k]));
    if (changed.length > 0) {
      report.push(`  METRICS changed: ${changed.map((k) => `${k} ${oldMetrics[k]} -> ${newMetrics[k]}`).join(", ")}`);
    }
  }
  for (const page of pages) {
    for (const name of page.regions) {
      const re = new RegExp(`<!-- BEGIN:${name} -->([\\s\\S]*?)<!-- END:${name} -->`);
      const a = re.exec(page.before)?.[1];
      const b = re.exec(page.after)?.[1];
      if (a !== undefined && b !== undefined && a !== b) report.push(`  ${page.label}: region ${name} changed`);
    }
    if (page.before !== page.after && report.length === 0) report.push(`  ${page.label}: text changed`);
  }
  if (beforeJs !== afterJs && !report.some((r) => r.includes("METRICS"))) report.push("  METRICS block changed");
  if (report.length === 0) report.push("  no generated content changed (line-ending or marker drift)");
  for (const page of pages) {
    if (page.before !== page.after) report.push(lineSample(page.before, page.after));
  }
  report.push(lineSample(beforeJs, afterJs));
  return report.join("\n");
}

const check = process.argv.includes("--check");
// `*.html` / `*.js` are `text eol=lf` in .gitattributes, but an editor or a tool can still hand
// back a CRLF file. Normalising here is what makes the write idempotent: region separators are
// written as `\n`, so without this each run would flip one more line from CRLF to LF and
// `--check` would report drift forever on a file that is semantically unchanged.
const readLf = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
// `raw` feeds the region builders and the assertions (file lists, route handlers);
// `metrics` is the flat page-facing map. Keeping them apart stops a display name from
// quietly becoming the shape of the data.
const raw = collectMetrics();
const metrics = buildMetrics(raw);

let html = readLf(HTML_FILE);
let js = readLf(JS_FILE);
let card = readLf(CARD_FILE);
const baseHtml = html;
const baseJs = js;
const baseCard = card;

for (const [name, build] of Object.entries(regionContent)) {
  html = replaceRegion(html, name, build(raw));
}
const applied = applyMetricsBlock(js, metrics);
js = applied.js;
const fallbacks = applyFallbacks(html, applied.metrics);
html = fallbacks.html;
for (const [name, build] of Object.entries(cardRegions)) {
  card = replaceRegion(card, name, build(applied.metrics), "project_card.html");
}

assertDirsMatchTree(html, raw);
assertDocsIndexedListed(html, raw);
assertReferences(html, "index.html");
assertReferences(card, "project_card.html");
assertEnglishPage(card, "project_card.html");

const pages = [
  { label: "index.html", before: baseHtml, after: html, regions: Object.keys(regionContent) },
  { label: "project_card.html", before: baseCard, after: card, regions: Object.keys(cardRegions) },
];

if (problems.length > 0) {
  console.error("generate_overview: assertions failed");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(2);
}

const drifted = js !== baseJs || pages.some((page) => page.after !== page.before);
if (check) {
  if (drifted) {
    console.error("drift: docs/project_overview no longer matches the source — run npm run docs:overview");
    console.error(describeDrift(pages, baseJs, js));
    process.exit(1);
  }
  console.log("in sync: docs/project_overview (numbers, file lists, route table and gate list come from source)");
  process.exit(0);
}

if (!drifted) {
  console.log("unchanged: docs/project_overview already matches the source");
  process.exit(0);
}

writeFileSync(JS_FILE, js);
writeFileSync(HTML_FILE, html);
writeFileSync(CARD_FILE, card);
console.log(
  `updated: docs/project_overview — ${Object.keys(applied.metrics).length} metrics, ` +
    `${metrics.routes} routes, ${raw.gates.length} gates, ${fallbacks.changed} fallback values written`,
);
console.log(describeDrift(pages, baseJs, js));
