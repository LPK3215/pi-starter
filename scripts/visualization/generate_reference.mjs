#!/usr/bin/env node
/**
 * pi-starter · 参考手册生成器
 *
 * ## 为什么需要它
 *
 * 项目长大的过程中，「能力面」跑赢了「文档面」，而且不是在细节上跑赢：
 *
 *   - WS 协议有 **57 个消息类型**，这是本项目真正对外的接口 —— 但没有任何参考文档。
 *     只有一张 SSE 时序图（`docs/sse-protocol.svg`）和一个 `protocol.ts` 本身。
 *   - REST 有 60+ 个路由处理器，README 只列了 4 个。
 *   - 环境变量有 58 个，其中 22 个在 `.env.example` 里、在两份 README 里一个字都没有。
 *
 * 手写一份这样的清单，三个月后必然又是一份过期文档。所以这里**从源码生成**：
 * 拿 `protocol.ts`、`src/http/*`、`src/tools/*`、`.env.example`、`package.json` 当事实源。
 *
 * ## 它不只是文档，还是一个检查
 *
 * 生成过程本身带断言，任何一条不成立就**非零退出**（不是打印个警告继续）：
 *   - 从 `ClientMessage` union 解析出的命令集合，必须与 `CLIENT_MESSAGE_TYPES` 完全一致
 *     （后者有编译期 `Exclude<...> extends never` 守卫，所以这就是拿编译期保证来校验解析器）。
 *   - `src/tools/*.ts` 里出现的每个工具名，必须在下面的分组表里被登记；反之亦然。
 *     —— 新增一个工具却忘了归类，会直接让门禁红，而不是让文档悄悄少一条。
 *   - 代码里引用的 `PI_*` 必须都在 `.env.example` 里登记过。
 *   - 两份 README 里出现 `PI_*` 名字但 `.env.example` 没登记（同一件事的反方向）。
 *
 * 用法：
 *   npx tsx scripts/visualization/generate_reference.mjs           # 写入 docs/参考手册.md
 *   npx tsx scripts/visualization/generate_reference.mjs --check    # 只校验，漂移则退出 1
 *
 * 退出码：0 一致 / 已写入；1 漂移或断言失败；2 无法解析（源码结构变了、生成器要更新）。
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_MESSAGE_TYPES } from "../../src/protocol.ts";
import { allTools } from "../../src/tools/index.ts";
import { sessionToolPolicy } from "../../src/config.ts";
import { inferCapabilities, inferRisk } from "../../src/tools/registry.ts";
import { webToolsForMode } from "../../src/tools/web.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = join(ROOT, "docs/参考手册.md");
const CHECK = process.argv.includes("--check");
const problems = [];

function fail(message) {
  problems.push(message);
}

function read(path) {
  return readFileSync(path, "utf8");
}

function walk(dir, extensions, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, extensions, out);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function lines(file) {
  const text = read(file);
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/* ══════════════════════════ 1. WS 协议 ══════════════════════════ */

/**
 * 从 `export type X = | { type: "a" } | ...` 里解析出每个分支的
 * 名字 / 分组（整行 `// 注释`）/ 说明（JSDoc 首段）。
 */
function parseUnion(text, unionName) {
  const all = text.split("\n");
  const startLine = all.findIndex((line) => line.startsWith(`export type ${unionName} =`));
  if (startLine < 0) {
    fail(`找不到 export type ${unionName}`);
    return [];
  }
  // 结束行是「以 }; 收尾」的那一行 —— 它接在**最后一个分支后面**（`| {...};`），
  // 不是单独一行。多行分支的收尾是 `    }`（无分号），所以不会提前截断。
  let endLine = -1;
  for (let i = startLine + 1; i < all.length; i++) {
    if (all[i].trimEnd().endsWith("};")) {
      endLine = i;
      break;
    }
  }
  if (endLine < 0) {
    fail(`找不到 ${unionName} 的结束位置（生成器需要更新）`);
    return [];
  }
  const src = all.slice(startLine, endLine + 1);
  const entries = [];
  let group = "";
  let pendingDoc = "";
  const push = (name) => {
    entries.push({ name, group, doc: summarize(pendingDoc) });
    pendingDoc = "";
  };
  for (let i = 0; i < src.length; i++) {
    const line = src[i].trim();
    if (line.startsWith("/**")) {
      // 单行 JSDoc（`/** ... */` 同一行）必须单独处理：按「找下一行 */」的写法会一直
      // 往后吞到下一个块注释，把中间的分支全吃掉 —— 分支**内部**的字段注释正是这种形态
      // （如 `rollback_conversation` 里的 `/** 走 SDK 官方 navigateTree ... */`）。
      const single = /^\/\*\*(.*?)\*\/$/.exec(line);
      if (single) {
        pendingDoc = single[1].replace(/^\s*\*\s?/, "").trim();
        continue;
      }
      const buf = [];
      i++;
      while (i < src.length && !src[i].trim().startsWith("*/")) {
        buf.push(src[i].trim().replace(/^\*\s?/, ""));
        i++;
      }
      pendingDoc = buf.join("\n").trim();
      continue;
    }
    if (line.startsWith("//")) {
      // 整行注释且当前没有挂 JSDoc：这是分组标题
      if (!pendingDoc) group = line.replace(/^\/\/\s*/, "").trim();
      continue;
    }
    if (!/^[|{]/.test(line)) continue;
    const inline = /\{\s*type:\s*"([a-z_]+)"/.exec(line)?.[1];
    if (inline) {
      push(inline);
      continue;
    }
    // 多行分支：`| {` 换行后才写 type。找到 type 之后**跳到该分支的收尾行**，
    // 否则分支内部那些字段级注释会被当成下一个分支的说明。
    for (let j = i + 1; j < src.length; j++) {
      const found = /type:\s*"([a-z_]+)"/.exec(src[j]);
      if (found) {
        push(found[1]);
        for (let k = j + 1; k < src.length; k++) {
          const inner = src[k].trim();
          if (inner === "}" || inner === "};") {
            i = k;
            break;
          }
        }
        break;
      }
      if (/^[|}]/.test(src[j].trim())) break;
    }
  }
  return entries;
}

/** JSDoc → 一行摘要：取首段、压掉换行、截到一句话。 */
function summarize(doc) {
  if (!doc) return "";
  const first = doc.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  const sentence = first.split("。")[0];
  const cut = sentence.length <= 120 ? sentence : `${sentence.slice(0, 118)}…`;
  return cut;
}

const protocolText = read(join(ROOT, "src/protocol.ts"));
const clientEntries = parseUnion(protocolText, "ClientMessage");
const serverEntries = parseUnion(protocolText, "ServerMessage");

// 断言：解析结果必须与编译期守卫过的常量完全一致
const parsedClient = [...clientEntries.map((e) => e.name)].sort();
const declaredClient = [...CLIENT_MESSAGE_TYPES].sort();
if (parsedClient.join(",") !== declaredClient.join(",")) {
  fail(
    `ClientMessage 解析结果与 CLIENT_MESSAGE_TYPES 不一致：\n` +
      `  仅在 union 里：${parsedClient.filter((n) => !declaredClient.includes(n)).join(", ") || "(无)"}\n` +
      `  仅在常量里：${declaredClient.filter((n) => !parsedClient.includes(n)).join(", ") || "(无)"}`,
  );
}
/**
 * 说明覆盖率**只统计、不判失败**。
 *
 * 「每条协议命令都必须有 JSDoc」听起来很正当，但把它设成门禁只会逼出「为了过检查而补的
 * 空说明」——那比没有说明更糟。真实的做法是把覆盖率摆在文档里，让缺口可见。
 */
const documentedClient = clientEntries.filter((entry) => entry.doc).length;
const documentedServer = serverEntries.filter((entry) => entry.doc).length;

/* ══════════════════════════ 2. REST 接口 ══════════════════════════ */

const httpFiles = [
  ...walk(join(ROOT, "src/http"), [".ts"]),
  join(ROOT, "src/app.ts"),
  join(ROOT, "src/server.ts"),
].filter((file) => !file.endsWith(".test.ts"));

const routeGroups = [];
for (const file of httpFiles.sort()) {
  const routes = [];
  for (const match of read(file).matchAll(/\.(get|post|put|patch|delete)\(\s*"(\/[^"]*)"/g)) {
    routes.push(`${match[1].toUpperCase()} ${match[2]}`);
  }
  if (routes.length > 0) routeGroups.push({ file: relative(ROOT, file), routes: [...new Set(routes)].sort() });
}

/* ══════════════════════════ 3. 工具 ══════════════════════════ */

/**
 * 工具 → 装配档位。这张表是**人工维护**的，所以配了完整性断言：
 * `src/tools/*.ts` 里出现的每个工具名都必须在这里被登记，少一条就让门禁红。
 */
const TOOL_TIERS = [
  { tier: "始终可用", files: ["tools/current-time.ts", "tools/ask-user-question.ts"] },
  { tier: "知识库（扫描到 `src/knowledge/*.md` 时）", files: ["tools/knowledge.ts"] },
  { tier: "数据库（连接成功时）", files: ["tools/database.ts"] },
  { tier: "`PI_BUILTIN_TOOLS=coding`", files: ["tools/exec.ts"] },
  { tier: "`PI_WEB=on`", files: ["tools/web.ts"] },
  { tier: "记忆（`PI_MEMORY`，默认开）", files: ["tools/memory.ts"] },
];

const toolSourceFiles = walk(join(ROOT, "src/tools"), [".ts"]).filter((f) => !f.endsWith(".test.ts"));
const toolsByFile = new Map();
for (const file of toolSourceFiles) {
  const names = [...new Set([...read(file).matchAll(/name:\s*"([a-z_][a-z0-9_]*)"/g)].map((m) => m[1]))];
  toolsByFile.set(relative(join(ROOT, "src"), file), names.sort());
}
const declaredTools = new Set([...toolsByFile.values()].flat());
const accountedTools = new Set(TOOL_TIERS.flatMap((entry) => entry.files.flatMap((f) => toolsByFile.get(f) ?? [])));
const unaccounted = [...declaredTools].filter((n) => !accountedTools.has(n));
if (unaccounted.length > 0) {
  fail(`src/tools/ 下这些工具没有在生成器的 TOOL_TIERS 里登记：${unaccounted.join(", ")}`);
}
const staleTierEntries = [...accountedTools].filter((n) => !declaredTools.has(n));
if (staleTierEntries.length > 0) {
  fail(`生成器的 TOOL_TIERS 登记了不存在的工具：${staleTierEntries.join(", ")}`);
}

// allTools 里的才是「始终可用」；其余按上表分组
const alwaysOn = new Set(allTools.map((tool) => tool.name));
function toolRow(name) {
  const caps = inferCapabilities(name);
  const risk = inferRisk(caps);
  const on = alwaysOn.has(name);
  return `| \`${name}\` | ${caps.join(", ") || "—"} | ${risk} | ${on ? "是" : "否"} |`;
}

const tiers = [];
for (const entry of TOOL_TIERS) {
  const names = entry.files.flatMap((f) => toolsByFile.get(f) ?? []).sort();
  tiers.push({ tier: entry.tier, names });
}

// SDK 内置工具档位（直接从 sessionToolPolicy 取，不手抄）
const builtinTiers = [
  { mode: "off", names: sessionToolPolicy("off").tools },
  { mode: "readonly", names: sessionToolPolicy("readonly").tools },
  { mode: "coding", names: sessionToolPolicy("coding").tools },
];
const webEnabledTools = webToolsForMode(true).map((tool) => tool.name);

/* ══════════════════════════ 4. 环境变量 ══════════════════════════ */

const envExampleText = read(join(ROOT, ".env.example"));
/**
 * 一个变量在 `.env.example` 里可能被写多遍——不同取值的示例块各自出现一次
 * （`PI_EMBEDDINGS_PROVIDER` 有 openai 与 transformers 两种写法）。表要按**变量名**去重：
 * 只出现多行，读者会以为那里有多个变量，计数也会虚高。
 *
 * 合并口径：
 *   - `enabled`：只要有一处是未注释的真赋值就算「启用」。
 *   - `comment`：取**每个出现处**的注释，按首次出现顺序拼起来，去掉重复。
 *     多套写法各自的说明都留着，比只留最后一块更不容易丢信息。
 */
const envRawEntries = [];
{
  let comment = [];
  let group = "";
  for (const raw of envExampleText.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      comment = [];
      continue;
    }
    const header = /^#\s*[-=]{4,}/.test(line) ? "" : /^#\s*(.+)$/.exec(line)?.[1];
    const varMatch = /^#?\s*(PI_[A-Z0-9_]+)\s*=/.exec(line);
    if (varMatch) {
      envRawEntries.push({
        name: varMatch[1],
        enabled: !line.startsWith("#"),
        group,
        comment: comment.filter(Boolean).slice(-2).join(" ").replace(/\s+/g, " ").trim(),
      });
      comment = [];
      continue;
    }
    if (header !== undefined) {
      comment.push(header);
      if (comment.filter(Boolean).length === 1) group = header.trim();
    }
  }
}
const envByName = new Map();
for (const entry of envRawEntries) {
  const seen = envByName.get(entry.name);
  if (!seen) {
    envByName.set(entry.name, { ...entry, comments: entry.comment ? [entry.comment] : [] });
    continue;
  }
  seen.enabled = seen.enabled || entry.enabled;
  if (entry.comment && !seen.comments.includes(entry.comment)) seen.comments.push(entry.comment);
}
const envEntries = [...envByName.values()].map((e) => ({ ...e, comment: e.comments.join(" ") }));
// 断言：去重后每个变量只该有一行——生成器将来改动若把这个性质弄丢，直接让门禁红。
const envDuplicates = envEntries.map((e) => e.name).filter((n, i, all) => all.indexOf(n) !== i);
if (envDuplicates.length > 0) fail(`环境变量表出现重复行：${[...new Set(envDuplicates)].join(", ")}`);
if (envEntries.length !== envByName.size) fail("环境变量去重后计数与唯一名字数不一致");
const envDeclared = new Set(envEntries.map((e) => e.name));

// 代码里引用的 PI_*（排除测试、排除 `PI_FOO_*` 这种 glob 提法）
const envInCode = new Set();
for (const file of walk(join(ROOT, "src"), [".ts"]).filter((f) => !f.endsWith(".test.ts"))) {
  for (const match of read(file).matchAll(/\bPI_[A-Z0-9_]+/g)) {
    if (match[0].endsWith("_")) continue; // glob 提法
    envInCode.add(match[0]);
  }
}
// `PI_API_KEY_<PROVIDER>` 这类模板名与文档举例，不算漏登记
const ENV_ALLOWLIST = new Set(["PI_API_KEY_ZHIPU", "PI_EMBEDDINGS_KEY", "PI_BASE_URL_", "PI_API"]);
const missingFromExample = [...envInCode].filter((n) => !envDeclared.has(n) && !ENV_ALLOWLIST.has(n));
if (missingFromExample.length > 0) {
  fail(`代码里引用但 .env.example 未登记：${missingFromExample.sort().join(", ")}`);
}

/* ══════════════════════════ 5. npm 脚本 ══════════════════════════ */

const pkg = JSON.parse(read(join(ROOT, "package.json")));
const scripts = Object.entries(pkg.scripts).sort(([a], [b]) => a.localeCompare(b));

/* ══════════════════════════ 6. 模块地图 ══════════════════════════ */

const moduleRows = [];
for (const entry of readdirSync(join(ROOT, "src"), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (entry.isDirectory()) {
    const files = walk(join(ROOT, "src", entry.name), [".ts"]);
    const source = files.filter((f) => !f.endsWith(".test.ts"));
    if (source.length === 0) continue;
    moduleRows.push({
      name: `${entry.name}/`,
      files: source.length,
      lineCount: source.reduce((total, f) => total + lines(f), 0),
    });
  } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
    moduleRows.push({ name: entry.name, files: 1, lineCount: lines(join(ROOT, "src", entry.name)) });
  }
}
moduleRows.sort((a, b) => b.lineCount - a.lineCount);

/* ══════════════════════════ 渲染 ══════════════════════════ */

function render() {
  const out = [];
  out.push("# pi-starter 参考手册");
  out.push("");
  out.push("> **本文档由 `scripts/visualization/generate_reference.mjs` 从源码生成，请勿手改。**");
  out.push(">");
  out.push("> 事实源：`src/protocol.ts`（协议）、`src/http/*` + `src/app.ts` + `src/server.ts`（REST）、");
  out.push("> `src/tools/*`（工具）、`.env.example`（环境变量）、`package.json`（脚本）。");
  out.push("> `npm run docs:reference:check` 在 CI 里挡住漂移；生成过程本身还带一致性断言，");
  out.push("> 新增协议命令/工具却忘了归类会直接让门禁红，而不是让这份文档悄悄少一条。");
  out.push("");
  out.push("## 1. WS 协议（真正的对外接口）");
  out.push("");
  out.push(
    `协议版本 \`PROTOCOL_VERSION = ${protocolText.match(/PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1] ?? "?"}\`。` +
      `客户端命令 **${clientEntries.length}** 条，服务端帧 **${serverEntries.length}** 条。`,
  );
  out.push("");
  out.push(
    `说明覆盖率：客户端 ${documentedClient}/${clientEntries.length}，` +
      `服务端 ${documentedServer}/${serverEntries.length}` +
      "（说明取自 src/protocol.ts 里分支上方的 JSDoc；没有 JSDoc 就是空。补说明是持续动作，" +
      "刻意不设成门禁——逼出来的空说明比没有说明更糟）。",
  );
  out.push("");
  out.push("### 1.1 客户端 → 服务端");
  out.push("");
  out.push("| 命令 | 说明 |");
  out.push("|---|---|");
  let group = "";
  for (const entry of clientEntries) {
    if (entry.group && entry.group !== group) {
      group = entry.group;
      out.push(`| **${group}** | |`);
    }
    out.push(`| \`${entry.name}\` | ${entry.doc} |`);
  }
  out.push("");
  out.push("### 1.2 服务端 → 客户端");
  out.push("");
  out.push("| 帧 | 说明 |");
  out.push("|---|---|");
  group = "";
  for (const entry of serverEntries) {
    if (entry.group && entry.group !== group) {
      group = entry.group;
      out.push(`| **${group}** | |`);
    }
    out.push(`| \`${entry.name}\` | ${entry.doc || "—"} |`);
  }
  out.push("");
  out.push("## 2. REST 接口");
  out.push("");
  out.push(`共 **${routeGroups.reduce((total, g) => total + g.routes.length, 0)}** 个路由处理器。`);
  out.push("");
  for (const group of routeGroups) {
    out.push(`### \`${group.file}\``);
    out.push("");
    for (const route of group.routes) out.push(`- \`${route}\``);
    out.push("");
  }
  out.push("## 3. 工具");
  out.push("");
  out.push("### 3.1 脚手架自带工具（按装配档位分组）");
  out.push("");
  out.push("| 工具 | 能力标签 | 风险 | 默认可用 |");
  out.push("|---|---|---|---|");
  for (const entry of tiers) {
    for (const name of entry.names) {
      const caps = inferCapabilities(name);
      const always = alwaysOn.has(name);
      out.push(`| \`${name}\` | ${caps.join(", ") || "—"} | ${inferRisk(caps)} | ${always ? "是" : `否（${entry.tier}）`} |`);
    }
  }
  out.push("");
  out.push("> 装配档位说明：");
  for (const entry of tiers) {
    out.push(`> - ${entry.tier} → ${entry.names.map((n) => `\`${n}\``).join(", ")}`);
  }
  out.push("");
  out.push("### 3.2 SDK 内置工具（按 `PI_BUILTIN_TOOLS` 档位）");
  out.push("");
  out.push("| 档位 | 工具 |");
  out.push("|---|---|");
  for (const entry of builtinTiers) {
    out.push(`| \`${entry.mode}\` | ${entry.names.map((n) => `\`${n}\``).join(", ")} |`);
  }
  out.push("");
  out.push(
    `> 另：\`PI_WEB=on\` 时额外注册 ${webEnabledTools.map((n) => `\`${n}\``).join(", ")}` +
      `（注入的后端没有 \`search()\` 时不含 \`web_search\`）。MCP 工具由外部 server 提供，不在此表。`,
  );
  out.push("");
  out.push("## 4. 环境变量");
  out.push("");
  out.push(
    `\`.env.example\` 登记了 **${envEntries.length}** 个（按变量名去重）；下表的「默认」列里，未注释的即为默认启用的写法。`,
  );
  out.push("");
  out.push("| 变量 | 默认 | 说明 |");
  out.push("|---|---|---|");
  for (const entry of envEntries) {
    out.push(`| \`${entry.name}\` | ${entry.enabled ? "启用" : "注释（示例）"} | ${entry.comment || "—"} |`);
  }
  out.push("");
  out.push("## 5. npm 脚本");
  out.push("");
  out.push("| 脚本 | 命令 |");
  out.push("|---|---|");
  for (const [name, command] of scripts) out.push(`| \`npm run ${name}\` | \`${command}\` |`);
  out.push("");
  out.push("## 6. 模块地图（按代码量降序）");
  out.push("");
  out.push("| 模块 | 文件数 | 行数 |");
  out.push("|---|---|---|");
  for (const row of moduleRows) out.push(`| \`src/${row.name}\` | ${row.files} | ${row.lineCount} |`);
  out.push("");
  out.push("---");
  out.push("");
  out.push(
    `*生成于 ${new Date().toISOString().slice(0, 10)} 的工作区源码。重新生成：\`npm run docs:reference\`。*`,
  );
  out.push("");
  return out.join("\n");
}

/* ══════════════════════════ 主流程 ══════════════════════════ */

if (problems.length > 0) {
  console.error("参考手册生成失败（一致性断言不通过）：\n");
  for (const problem of problems) console.error(`  ✖ ${problem}`);
  console.error(
    "\n这不是文档问题，是代码与「已知清单」不一致 —— 修代码或更新生成器里的登记表，不要绕过它。",
  );
  process.exit(2);
}

const rendered = render();
const current = statSync(OUT, { throwIfNoEntry: false }) ? read(OUT) : "";
if (rendered === current) {
  console.log("一致：docs/参考手册.md");
  process.exit(0);
}
if (CHECK) {
  console.error("漂移：docs/参考手册.md —— 跑 npm run docs:reference 重新生成");
  process.exit(1);
}
writeFileSync(OUT, rendered);
console.log(`已更新：docs/参考手册.md（${rendered.split("\n").length} 行）`);
