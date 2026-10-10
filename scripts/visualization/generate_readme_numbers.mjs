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
 * 数字口径（刻意写死在这里，改口径就地改）：
 *   - 用例数 = `npm test` 清单里每个文件顶层 `test(` 的声明数。实测与 `tsx --test` 报告的
 *     `ℹ tests N` 一致 —— 所以它是**可核对**的，而不是估计值。
 *   - 行数 = 文件字节按 \n 切分（与 `wc -l` 一致，不把结尾空行算成两行）。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BEGIN = "<!-- BEGIN:generated-numbers -->";
const END = "<!-- END:generated-numbers -->";

/** 递归收集目录下的文件（按扩展名过滤），跳过 node_modules / dist。 */
function walk(dir, extensions, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, extensions, out);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function countLines(file) {
  const text = readFileSync(file, "utf8");
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function sumLines(files) {
  return files.reduce((total, file) => total + countLines(file), 0);
}

/** `npm test` 清单里的文件与用例数。 */
function backendTests() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const files = pkg.scripts.test
    .split(/\s+/)
    .filter((piece) => piece.endsWith(".test.ts"))
    .map((piece) => join(ROOT, piece));
  let cases = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    cases += (text.match(/^test\(/gm) ?? []).length;
  }
  return { files, cases };
}

/** 前端用例数：同口径，单文件。 */
function frontendTests() {
  const file = join(ROOT, "web/src/pi/client.test.ts");
  let cases = 0;
  try {
    cases = (readFileSync(file, "utf8").match(/^test\(/gm) ?? []).length;
  } catch {
    cases = 0;
  }
  return { file, cases };
}

/** 静态计数 HTTP 路由处理器（`router.get(...)` / `app.post(...)` 形态）。 */
function routeCount() {
  const dirs = [join(ROOT, "src/http"), join(ROOT, "src")];
  const files = new Set();
  for (const dir of dirs) {
    for (const file of walk(dir, [".ts"])) {
      if (file.endsWith(".test.ts")) continue;
      // src 根目录只看 app.ts，避免把无关文件的 `.get(` 也数进来
      if (dir.endsWith(`${"src"}`) && !file.endsWith(`${"app"}.ts`)) continue;
      files.add(file);
    }
  }
  let total = 0;
  const pattern = /\.(?:get|post|put|patch|delete)\(\s*["'`]/g;
  for (const file of files) {
    total += (readFileSync(file, "utf8").match(pattern) ?? []).length;
  }
  return total;
}

function collect() {
  const srcFiles = walk(join(ROOT, "src"), [".ts"]);
  const srcTests = srcFiles.filter((file) => file.endsWith(".test.ts"));
  const srcSource = srcFiles.filter((file) => !file.endsWith(".test.ts"));
  const webFiles = walk(join(ROOT, "web/src"), [".ts", ".tsx"]);
  const docsMd = walk(join(ROOT, "docs"), [".md"]);
  const backend = backendTests();
  const frontend = frontendTests();
  return {
    srcSource: { files: srcSource.length, lines: sumLines(srcSource) },
    srcTests: { files: backend.files.length, cases: backend.cases, lines: sumLines(srcTests) },
    web: { files: webFiles.length, lines: sumLines(webFiles) },
    frontendTests: frontend.cases,
    routes: routeCount(),
    docs: docsMd.length,
    largest: srcSource
      .map((file) => ({ file: relative(ROOT, file), lines: countLines(file) }))
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 1)[0],
  };
}

function table(locale) {
  const n = collect();
  const zh = locale === "zh";
  const head = zh ? "| 指标 | 数值 |" : "| Metric | Value |";
  const sep = "|---|---|";
  const rows = zh
    ? [
        ["后端源码（`src/`，不含测试）", `${n.srcSource.files} 个 \`.ts\` · ${n.srcSource.lines} 行`],
        ["后端测试", `${n.srcTests.files} 个文件 · **${n.srcTests.cases} 用例** · ${n.srcTests.lines} 行`],
        ["前端手写代码（`web/src`）", `${n.web.files} 个文件 · ${n.web.lines} 行`],
        ["前端用例", `${n.frontendTests}`],
        ["HTTP 路由处理器（静态计数）", `${n.routes}`],
        ["手写文档（`docs/*.md`）", `${n.docs}`],
        ["最大单文件", `\`${n.largest.file}\`（${n.largest.lines} 行）`],
      ]
    : [
        ["Backend source (`src/`, tests excluded)", `${n.srcSource.files} \`.ts\` files · ${n.srcSource.lines} lines`],
        ["Backend tests", `${n.srcTests.files} files · **${n.srcTests.cases} cases** · ${n.srcTests.lines} lines`],
        ["Frontend hand-written (`web/src`)", `${n.web.files} files · ${n.web.lines} lines`],
        ["Frontend cases", `${n.frontendTests}`],
        ["HTTP route handlers (static count)", `${n.routes}`],
        ["Hand-written docs (`docs/*.md`)", `${n.docs}`],
        ["Largest single file", `\`${n.largest.file}\` (${n.largest.lines} lines)`],
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
