/**
 * pi-starter · 面向人的数字的唯一来源
 *
 * 为什么存在：README 的指标表和 `docs/project_overview/` 的页面数字原先各抄一份。
 * 手抄的结局是页面上挂着 `37 files · 308 cases`——这组数在代码里早就不成立了，而 CI 抓不到，
 * 因为它没有任何真源可比。现在所有计数从这里出：`generate_readme_numbers.mjs` 写 README 表格，
 * `generate_overview.mjs` 写全景页的 METRICS 块，口径只有一份。
 *
 * 口径（刻意写死在这里，改口径就改这里，两条下游会一起跟着变）：
 *   - 用例数 = `package.json` 的 `test` / `test:web` 清单里每个文件顶层 `test(` 的声明数。
 *     实测与 `tsx --test` 报告的 `ℹ tests N` 一致，所以它是可核对的，不是估计值。
 *   - 行数 = 文件内容按 `\n` 切分（与 `wc -l` 一致，结尾空行不算两行）。
 *   - 路由数 = `app.` / `router.` 上的 get/post/put/patch/delete 调用。
 *     早期用裸 `.get(` 计数，把 `search.get("limit")`（URLSearchParams）也算了进去，
 *     于是"58 个路由处理器"里混着 11 次查询参数读取——一个标榜可验证的数字其实不可验证。
 *   - 冒烟 / e2e 断言数 = 两个脚本里 `check(` 的调用点数（不含定义）。它们都用同一个函数记账，
 *     所以调用点数就是断言数；实测 `npm run smoke` 报的正是 `23/23 runtime checks passed`。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { THRESHOLDS } from "../coverage-thresholds.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * 生成物里的路径一律正斜杠。
 *
 * `path.relative` 在 Windows 上给反斜杠，而写进文档的是正斜杠字面量。不归一会同时坏两处：
 * 文档正文里出现 `\`，以及 `toolsByFile.get("tools/web.ts")` 这类**按路径查表全部 miss**——
 * 后者会让完整性断言把**所有**工具报成「没有登记」，真正漏登记的那一条被淹在假信号里。
 * 只坏第一处的话，`--check` 在 Windows 上恒报漂移：数字全对，只有分隔符不同，
 * 这条「防漂移」检查本身就成了平台噪声。
 */
export const toPosix = (p) => (sep === "/" ? p : p.split(sep).join("/"));

/** 递归收集目录下的文件（按扩展名过滤），跳过 node_modules / dist / 点开头的条目。 */
export function walk(dir, extensions, out = []) {
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

export function countLines(file) {
  const text = readFileSync(file, "utf8");
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function sumLines(files) {
  return files.reduce((total, file) => total + countLines(file), 0);
}

function packageJson() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
}

/** 清单里指定的测试文件（`tsx --test` 那一串路径），而不是"扫出来的所有 *.test.ts"。 */
function manifestTests(script) {
  return String(packageJson().scripts[script] ?? "")
    .split(/\s+/)
    .filter((piece) => piece.endsWith(".test.ts"))
    .map((piece) => join(ROOT, piece));
}

function countCases(files) {
  return files.reduce((total, file) => total + (readFileSync(file, "utf8").match(/^test\(/gm) ?? []).length, 0);
}

/** 路由调用点：只认 `app.` / `router.` 这两个接收者。 */
export function routeHandlers() {
  const dirs = [join(ROOT, "src", "http"), join(ROOT, "src")];
  const files = new Set();
  for (const dir of dirs) {
    for (const file of walk(dir, [".ts"])) {
      if (file.endsWith(".test.ts")) continue;
      // src 根目录只看 app.ts，避免把无关文件的 `.get(` 数进来
      if (relative(ROOT, dir) === "src" && !file.endsWith("app.ts")) continue;
      files.add(file);
    }
  }
  const call = /(?:app|router)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  const handlers = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(call)) {
      handlers.push({ method: match[1].toUpperCase(), path: match[2], file: toPosix(relative(ROOT, file)) });
    }
  }
  return handlers;
}

/** `check(` 调用点数 —— 冒烟与 e2e 脚本都按这个函数记账，所以调用点数就是断言数。 */
function checkCalls(rel) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  return (text.match(/^\s*check\(/gm) ?? []).length;
}

/**
 * 从源码里读出的运行默认值。
 *
 * 只读那种「`export const NAME = 字面量` / `key: 字面量`」形态，读不到就报错而不是猜：
 * 页面上写 `cap 8` 而代码里已经是 6，比不写这个数字更糟。
 */
function literal(rel, pattern, what) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  const match = pattern.exec(text);
  if (!match) throw new Error(`metrics: ${what} not found in ${rel} — the page would print a number the code does not have`);
  return match[1];
}

/** `npm run verify` 由哪些子门禁串起来（全景页按这份列表渲染）。 */
function verifyGates() {
  return String(packageJson().scripts.verify)
    .split("&&")
    .map((step) => step.trim().replace(/^npm (?:run )?/, ""))
    .filter(Boolean);
}

export function collectMetrics() {
  const pkg = packageJson();
  const srcFiles = walk(join(ROOT, "src"), [".ts"]);
  const srcTests = srcFiles.filter((file) => file.endsWith(".test.ts"));
  const srcSource = srcFiles.filter((file) => !file.endsWith(".test.ts"));
  const webFiles = walk(join(ROOT, "web", "src"), [".ts", ".tsx"]);
  const docsMd = walk(join(ROOT, "docs"), [".md"]);
  const backendFiles = manifestTests("test");
  const frontendFiles = manifestTests("test:web");
  const routes = routeHandlers();
  const webPkg = JSON.parse(readFileSync(join(ROOT, "web", "package.json"), "utf8"));
  const largest = srcSource
    .map((file) => ({ file: toPosix(relative(ROOT, file)), lines: countLines(file) }))
    .sort((a, b) => b.lines - a.lines)[0];

  return {
    version: pkg.version,
    license: pkg.license,
    enginesNode: pkg.engines.node,
    deps: {
      sdk: pkg.dependencies["@earendil-works/pi-coding-agent"],
      express: pkg.dependencies.express,
      typebox: pkg.dependencies.typebox,
      ws: pkg.dependencies.ws,
      transformers: pkg.optionalDependencies["@huggingface/transformers"],
      typescript: pkg.devDependencies.typescript,
      react: webPkg.dependencies.react,
      vite: webPkg.devDependencies.vite,
      assistantUi: webPkg.dependencies["@assistant-ui/react"],
    },
    runtime: {
      maxOpenConversations: Number(
        literal("src/client-session.ts", /DEFAULT_MAX_OPEN_CONVERSATIONS\s*=\s*(\d+)/, "conversation cap default"),
      ),
      wsPath: literal("src/config.ts", /wsPath:\s*"([^"]+)"/, "WebSocket path default"),
      defaultHost: literal("src/config.ts", /\n {2}host:\s*"([^"]+)"/, "default bind address"),
    },
    srcFiles: srcSource.length,
    srcLines: sumLines(srcSource),
    testFiles: backendFiles.length,
    testCases: countCases(backendFiles),
    testLines: sumLines(srcTests),
    webFiles: webFiles.length,
    webLines: sumLines(webFiles),
    frontendCases: countCases(frontendFiles),
    routes: routes.length,
    routeHandlers: routes,
    docFiles: docsMd.length,
    largestFile: largest.file,
    largestLines: largest.lines,
    smokeChecks: checkCalls(join("scripts", "smoke-ws.mjs")),
    e2eChecks: checkCalls(join("scripts", "e2e-restart.mjs")),
    coverage: THRESHOLDS,
    gates: verifyGates(),
    srcDirs: readdirSync(join(ROOT, "src"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
    srcRootFiles: srcSource
      .filter((file) => relative(join(ROOT, "src"), file).indexOf(sep) < 0)
      .map((file) => toPosix(relative(ROOT, file)).split("/").pop())
      .sort(),
    docsMdFiles: docsMd.map((file) => toPosix(relative(ROOT, file)).split("/").pop()).sort(),
  };
}

export { ROOT };
