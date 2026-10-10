#!/usr/bin/env node
/**
 * pi-starter · README 可验证数字生成器
 *
 * 为什么需要它：README 里那些「可验证的数字」（文件数、用例数、行数、路由数）是手写的，
 * 而代码跑得比文档快 —— 结果是同一份 README 里 `42 test files · 376 cases` 与
 * `# 376 unit + integration tests` 对着不同的数字，谁也不知道哪个是真的。
 *
 * 这个脚本把数字**从源码算出来**，写进 README 里的标记块：
 *
 *     <!-- BEGIN:generated-numbers -->
 *     ...（本脚本生成，勿手改）...
 *     <!-- END:generated-numbers -->
 *
 * 用法：
 *   node scripts/visualization/generate_readme_numbers.mjs           # 写入
 *   node scripts/visualization/generate_readme_numbers.mjs --check   # 只校验，漂移则退出 1
 *
 * 退出码：0 = 一致 / 已写入；1 = --check 发现漂移（CI 用）；2 = 找不到标记块（README 被改坏）。
 *
 * 计数口径住在 `metrics.mjs`（唯一来源）：README 表格和 `docs/project_overview/` 的 METRICS
 * 块都从它取，所以两处不可能给出不同的数。原先本文件自带一套 walk/countLines/routeCount，
 * 全景页再抄一份，就是这么长出「页面 37 files · 308 cases」这种早已不成立的数字的。
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectMetrics } from "./metrics.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BEGIN = "<!-- BEGIN:generated-numbers -->";
const END = "<!-- END:generated-numbers -->";

function table(locale) {
  const n = collectMetrics();
  const zh = locale === "zh";
  const head = zh ? "| 指标 | 数值 |" : "| Metric | Value |";
  const sep = "|---|---|";
  const rows = zh
    ? [
        ["后端源码（`src/`，不含测试）", `${n.srcFiles} 个 \`.ts\` · ${n.srcLines} 行`],
        ["后端测试", `${n.testFiles} 个文件 · **${n.testCases} 用例** · ${n.testLines} 行`],
        ["前端手写代码（`web/src`）", `${n.webFiles} 个文件 · ${n.webLines} 行`],
        ["前端用例", `${n.frontendCases}`],
        ["HTTP 路由处理器（`app.` / `router.` 上的方法）", `${n.routes}`],
        ["手写文档（`docs/*.md`）", `${n.docFiles}`],
        ["最大单文件", `\`${n.largestFile}\`（${n.largestLines} 行）`],
      ]
    : [
        ["Backend source (`src/`, tests excluded)", `${n.srcFiles} \`.ts\` files · ${n.srcLines} lines`],
        ["Backend tests", `${n.testFiles} files · **${n.testCases} cases** · ${n.testLines} lines`],
        ["Frontend hand-written (`web/src`)", `${n.webFiles} files · ${n.webLines} lines`],
        ["Frontend cases", `${n.frontendCases}`],
        ["HTTP route handlers (`app.` / `router.` methods)", `${n.routes}`],
        ["Hand-written docs (`docs/*.md`)", `${n.docFiles}`],
        ["Largest single file", `\`${n.largestFile}\` (${n.largestLines} lines)`],
      ];
  const note = zh
    ? "> 本表由 `node scripts/visualization/generate_readme_numbers.mjs` 从源码生成，**请勿手改**；`npm run docs:numbers:check` 会在 CI 里挡住漂移。"
    : "> Generated from source by `node scripts/visualization/generate_readme_numbers.mjs` — **do not edit by hand**; `npm run docs:numbers:check` guards against drift in CI.";
  return [head, sep, ...rows.map(([k, v]) => `| ${k} | ${v} |`), "", note].join("\n");
}

function apply(readmePath, locale, check) {
  let text;
  try {
    text = readFileSync(readmePath, "utf8");
  } catch {
    console.error(`读不到 ${readmePath}`);
    process.exit(2);
  }
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin < 0 || end < 0 || end < begin) {
    console.error(`${readmePath} 缺少 ${BEGIN} / ${END} 标记块`);
    process.exit(2);
  }
  const updated = `${text.slice(0, begin + BEGIN.length)}\n${table(locale)}\n${text.slice(end)}`;
  if (updated === text) {
    console.log(`一致：${relative(ROOT, readmePath)}`);
    return true;
  }
  if (check) {
    console.error(`漂移：${relative(ROOT, readmePath)} —— 跑 npm run docs:numbers 重新生成`);
    return false;
  }
  writeFileSync(readmePath, updated);
  console.log(`已更新：${relative(ROOT, readmePath)}`);
  return true;
}

const check = process.argv.includes("--check");
const files = [
  [join(ROOT, "README.md"), "en"],
  [join(ROOT, "README.zh-CN.md"), "zh"],
];
if (files.some(([file]) => !statSync(file, { throwIfNoEntry: false }))) {
  console.error("README.md / README.zh-CN.md 必须都存在");
  process.exit(2);
}
const ok = files.map(([file, locale]) => apply(file, locale, check)).every(Boolean);
process.exit(ok ? 0 : 1);
