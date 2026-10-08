#!/usr/bin/env node
// ============================================================================
// scripts/publish-local.mjs —— 本地出包 + 发布 Release（不依赖 GitHub Actions）
//
// 为什么需要它：CI 可能因为**与你的代码完全无关**的原因跑不起来 ——
//   ① 账号被计费锁定（`the job was not started because your account is locked
//      due to a billing issue`）→ 所有仓库全部无法启动，公开仓也一样；
//   ② 私有仓免费额度用尽（Free 账号 2000 分钟/月）；
//   ③ 组织/仓库策略禁用了 Actions。
// 这时 tag 推上去了，CI 却不出包。本脚本走**同一条发版语义**，只是把"出包"
// 从云端搬回本地：门禁 → 出包 → 把产物挂到该 tag 的正式 Release 上。
//
// 读项目根目录 pipeline.config.json 的 "localPublish" 段：
//   steps      出包步骤（逐条执行，任一失败即停）。留空 = 纯文本发布
//   artifacts  产物 glob（相对项目根），命中的文件挂到 Release。留空 = 纯文本发布
//
// 「发布」不必等于「出安装包」：文档站、纯库、只发版本说明的项目，两个数组都留空即可 ——
// 建一个带 release notes 的正式 Release，不挂任何文件。
//
// 换技术栈只改配置，不改本文件。
//
// 用法（在项目根目录；建 Release 需已安装并登录 gh）：
//   npm run publish:local              # 门禁 → 出包 → 建/更新该 tag 的 Release
//   npm run publish:local -- --dry-run # 只显示会做什么，不执行
//   npm run publish:local -- --no-release  # 只出包到本地，不碰 GitHub
//   npm run publish:local -- --no-verify   # 跳过门禁（不建议）
//   npm run publish:local -- --tag v0.2.1  # 显式指定 tag（默认按版本文件推导）
//   npm run publish:local -- --force       # 工作区有改动也继续（风险自负）
// ============================================================================

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------- 参数
const args = process.argv.slice(2);

const KNOWN_FLAGS = [
  "--dry-run",
  "--no-release",
  "--no-verify",
  "--force",
  "--clobber",
  "--config",
  "--tag",
  "--notes",
];
const unknownFlags = args.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.includes(a));
if (unknownFlags.length > 0) {
  console.error(
    `未知参数：${unknownFlags.join(" ")}\n` +
      `可用参数：${KNOWN_FLAGS.join(" / ")}（--config / --tag / --notes 需跟一个值）`
  );
  process.exit(1);
}

function valueOf(flag) {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

const dryRun = args.includes("--dry-run");
const noRelease = args.includes("--no-release");
const skipVerify = args.includes("--no-verify");
const force = args.includes("--force");
const clobber = args.includes("--clobber");
const explicitTag = valueOf("--tag");
const notesFileArg = valueOf("--notes");

const configPath = path.resolve(
  ROOT,
  valueOf("--config") || "pipeline.config.json"
);

// ---------------------------------------------------------------- 配置
function loadConfig() {
  if (!fs.existsSync(configPath)) {
    console.error(
      `找不到配置文件：${configPath}\n` +
        `从模板复制 pipeline.config.example.json 到项目根并改名为 pipeline.config.json。`
    );
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error(`配置文件不是合法 JSON：${configPath}\n${err.message}`);
    process.exit(1);
  }
}

const config = loadConfig();
const tagPrefix = typeof config.tagPrefix === "string" ? config.tagPrefix : "v";
const remote = typeof config.remote === "string" && config.remote ? config.remote : "origin";
const versionFiles = Array.isArray(config.versionFiles) ? config.versionFiles : [];
const lp = config.localPublish && typeof config.localPublish === "object" ? config.localPublish : {};
const steps = Array.isArray(lp.steps) ? lp.steps : [];
const artifactGlobs = Array.isArray(lp.artifacts) ? lp.artifacts : [];

function rel(abs) {
  return path.relative(ROOT, abs) || abs;
}

function sh(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  if (dryRun) return "";
  return execSync(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
}

/**
 * Windows 上 npm / pnpm / yarn / npx / bun 是 .cmd 批处理，execSync 直接调会
 * 找不到可执行文件 —— 统一改写为 .cmd 版本（与 verify.mjs 的规则一致）。
 */
function shStep(cmd, cwd) {
  let c = cmd;
  if (process.platform === "win32") {
    c = c.replace(/^(npm|npx|pnpm|yarn|bun)(\s|$)/, "$1.cmd$2");
  }
  console.log(`\n$ ${c}${cwd ? `   (cwd: ${cwd})` : ""}`);
  if (dryRun) return;
  execSync(c, { cwd: cwd ? path.resolve(ROOT, cwd) : ROOT, stdio: "inherit" });
}

// ---------------------------------------------------------------- 版本 / tag
/** 从 json 或 toml-package 版本文件里读出当前版本号 */
function readVersionFrom(entry) {
  const abs = path.resolve(ROOT, entry.path);
  if (!fs.existsSync(abs)) return null;
  const raw = fs.readFileSync(abs, "utf8");
  if (entry.type === "json") {
    try {
      const obj = JSON.parse(raw);
      return typeof obj.version === "string" ? obj.version : null;
    } catch {
      return null;
    }
  }
  if (entry.type === "toml-package") {
    // Cargo.toml 的 [package] 与 pyproject.toml 的 [project] 都认
    const m =
      raw.match(/\[package\][\s\S]*?\n\s*version\s*=\s*"([^"]+)"/) ||
      raw.match(/\[project\][\s\S]*?\n\s*version\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  }
  return null;
}

function resolveTag() {
  if (explicitTag) return explicitTag.startsWith(tagPrefix) ? explicitTag : `${tagPrefix}${explicitTag}`;

  // versionFrom 可写成字符串（按扩展名自动判类型）或 { path, type } 对象
  let from = null;
  if (typeof lp.versionFrom === "string") {
    from = { path: lp.versionFrom, type: /\.toml$/i.test(lp.versionFrom) ? "toml-package" : "json" };
  } else if (lp.versionFrom && typeof lp.versionFrom === "object" && lp.versionFrom.path) {
    from = lp.versionFrom;
  }
  const candidates = from ? [from, ...versionFiles] : versionFiles;
  for (const entry of candidates) {
    const v = readVersionFrom(entry);
    if (v) return `${tagPrefix}${v}`;
  }
  console.error(
    "推不出 tag：配置里没有可解析的版本文件（type 为 json / toml-package），而且没给 --tag。\n" +
      `请在 pipeline.config.json 里加 "localPublish": { "versionFrom": "package.json" }，或显式传 --tag <tag>。`
  );
  process.exit(1);
}

// ---------------------------------------------------------------- 产物 glob
/** `*` 单层、`**` 任意层、其余按字面。够用且不引依赖。 */
function expandGlob(pattern) {
  const segs = pattern.split(/[\\/]/).filter((s) => s && s !== ".");
  let dirs = [ROOT];

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const isLast = i === segs.length - 1;
    const next = [];

    for (const dir of dirs) {
      if (seg === "**") {
        // 任意层（含零层）：把 dir 自身与所有子孙目录都作为候选
        next.push(...walkDirs(dir));
        continue;
      }
      if (!fs.existsSync(dir)) continue;

      if (seg.includes("*")) {
        const re = new RegExp(
          "^" + seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^\\\\/]*") + "$"
        );
        for (const name of fs.readdirSync(dir)) {
          if (!re.test(name)) continue;
          const p = path.join(dir, name);
          if (isLast ? fs.statSync(p).isFile() : fs.statSync(p).isDirectory()) next.push(p);
        }
      } else {
        const p = path.join(dir, seg);
        if (!fs.existsSync(p)) continue;
        if (isLast ? fs.statSync(p).isFile() : fs.statSync(p).isDirectory()) next.push(p);
      }
    }
    dirs = next;
  }
  return [...new Set(dirs)];
}

function walkDirs(root, out = []) {
  out.push(root);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".venv") continue;
    walkDirs(path.join(root, e.name), out);
  }
  return out;
}

// ---------------------------------------------------------------- release notes
/** 抽 CHANGELOG 里对应版本那一段（与 publish.yml 的 awk 语义一致，跨平台不依赖 awk） */
function extractChangelogSection(version) {
  const p = path.join(ROOT, "CHANGELOG.md");
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^##\\s*\\[?${esc}\\]?`);

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (head.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start, end).join("\n").trim();
  return body || null;
}

function ghReady() {
  try {
    execSync("gh --version", { stdio: "pipe" });
  } catch {
    console.error(
      "\n建 Release 需要 GitHub CLI（gh）：没装就到 https://cli.github.com 装一个，然后 `gh auth login`。\n" +
        "只想在本地出包不建 Release 的话，加 --no-release。"
    );
    process.exit(1);
  }
  // 只读本地凭据、**不发网络请求** —— `gh auth status` 要联网校验 token，
  // 在需要代理的网络里会失败，于是把「已登录」误判成「未登录」，白白挡住发版。
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return;
  try {
    execSync("gh auth token", { stdio: "pipe" });
  } catch {
    console.error(
      "\ngh 没有可用凭据：先 `gh auth login`，或设置 GH_TOKEN / GITHUB_TOKEN 环境变量；\n" +
        "只想在本地出包就加 --no-release。\n" +
        "（若你的网络访问 GitHub 需要代理，请先设好 HTTPS_PROXY / HTTP_PROXY —— 真正上传产物时要用。）"
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 主流程
const tag = resolveTag();
const version = tag.replace(new RegExp(`^${tagPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "");

console.log(`\n[publish-local] 仓库：${ROOT}`);
console.log(`[publish-local] tag：${tag}${dryRun ? "   （dry-run）" : ""}`);
console.log(`[publish-local] 出包步骤：${steps.length} 条 · 产物 glob：${artifactGlobs.length} 条`);

// steps 与 artifacts 都允许为空 —— 那意味着「纯文本发布」：只建带 release notes 的
// Release、不挂任何文件。文档站、纯库、只发版本说明的项目都属于这一类，
// "发布"不必等于"出安装包"。
if (steps.length === 0 && artifactGlobs.length === 0) {
  console.log(
    "\n[publish-local] 未配置出包步骤与产物 —— 走**纯文本发布**（只建 Release + release notes，不出任何包）。"
  );
}

// 1) 工作区
const status = execSync("git status --porcelain", { cwd: ROOT }).toString().trim();
if (status && !force) {
  console.error(
    "工作区有未提交改动，出包应从干净历史出发（产物才对得上 tag）。\n" +
      "先提交或撤销改动，或用 --force 强行继续（风险自负）。\n\n" +
      status
  );
  process.exit(1);
}

// 2) tag 必须已存在（本脚本不负责打 tag —— 那是 release.mjs 的事）
let hasLocalTag = false;
try {
  execSync(`git rev-parse "${tag}"`, { cwd: ROOT, stdio: "ignore" });
  hasLocalTag = true;
} catch {
  /* 不存在 */
}
if (!hasLocalTag) {
  console.error(
    `本地没有 tag ${tag}。本脚本只负责"出包 + 建 Release"，打 tag 交给 release.mjs：\n` +
      `  npm run release -- ${version}\n` +
      `（它会把版本号回写到配置里的每个位置、commit、打 tag、推分支与 tag。）`
  );
  process.exit(1);
}

// 3) tag 必须已在远程（Release 是挂在远程 tag 上的）
let hasRemoteTag = false;
try {
  const out = execSync(`git ls-remote --tags ${remote} "${tag}"`, { cwd: ROOT }).toString().trim();
  hasRemoteTag = out.length > 0;
} catch {
  /* 取不到就当没有 */
}
if (!hasRemoteTag && !noRelease) {
  console.error(
    `远程 ${remote} 上还没有 tag ${tag}，Release 必须挂在远程 tag 上。\n` +
      `先推送：git push ${remote} ${tag}`
  );
  process.exit(1);
}

// 4) 门禁
if (!skipVerify) {
  console.log("\n[publish-local] 跑发布门禁…");
  if (dryRun) {
    console.log(`$ "${process.execPath}" "${path.join(__dirname, "verify.mjs")}"`);
  } else {
    execSync(`"${process.execPath}" "${path.join(__dirname, "verify.mjs")}"`, {
      cwd: ROOT,
      stdio: "inherit",
    });
  }
} else {
  console.log("\n[publish-local] 已跳过门禁（--no-verify）");
}

// 5) 出包
console.log("\n[publish-local] 本地出包：");
for (const s of steps) {
  const name = s.name || s.cmd;
  console.log(`  - [${name}] ${s.cmd}${s.cwd ? `  (cwd: ${s.cwd})` : ""}`);
}
for (const s of steps) shStep(s.cmd, s.cwd);

// 6) 收集产物
const files = artifactGlobs.flatMap((g) => expandGlob(g)).filter((f, i, a) => a.indexOf(f) === i);
if (artifactGlobs.length === 0) {
  console.log("\n[publish-local] 未配置 artifacts —— 纯文本发布，不挂任何文件。");
} else {
  console.log(`\n[publish-local] 产物：`);
  if (files.length === 0) {
    console.log(dryRun ? "  （dry-run：未执行出包，产物要真跑一次才会产生）" : "  （一个都没匹配到）");
    if (!dryRun) {
      console.warn(
        `  ⚠ 这不一定是错：跨平台形态里"本机没出的包"本来就匹配不到（如 Tauri 在 Windows 上不会产出 .dmg）——\n` +
          `    确认 glob 写对了就继续；写错了就改配置。当前 glob：${artifactGlobs.join(", ")}`
      );
    }
  } else {
    for (const f of files) {
      const size = fs.statSync(f).size;
      console.log(`  - ${rel(f)}  (${(size / 1024).toFixed(1)} KiB)`);
    }
  }
}

// 7) Release
if (noRelease) {
  console.log("\n[publish-local] 已指定 --no-release：产物留在本地，未触碰 GitHub。");
  process.exit(0);
}

ghReady();

// Release 是否已存在
let releaseExists = false;
try {
  execSync(`gh release view "${tag}"`, { cwd: ROOT, stdio: "ignore" });
  releaseExists = true;
} catch {
  /* 不存在 */
}

// release notes：--notes 指定文件 > CHANGELOG 对应段 > 交给 gh 自动生成
let notesFile = notesFileArg || null;
if (!notesFile) {
  const body = extractChangelogSection(version);
  if (body) {
    const tmp = path.join(ROOT, `.publish-local-notes-${version}.md`);
    if (!dryRun) fs.writeFileSync(tmp, body + "\n");
    notesFile = rel(tmp);
    console.log(`\n[publish-local] release notes：取自 CHANGELOG.md 的 ${version} 段`);
  } else {
    console.log(`\n[publish-local] CHANGELOG.md 里没有 ${version} 段，release notes 用 gh 自动生成`);
  }
}

if (dryRun) {
  console.log(
    `\n[dry-run] 将会${releaseExists ? "更新已存在的 Release" : "创建 Release"} ${tag}，产物 ${files.length} 个。未执行任何写操作。`
  );
  process.exit(0);
}

try {
  if (!releaseExists) {
    const quoted = files.map((f) => `"${f}"`).join(" ");
    const notesArgs = notesFile ? `--notes-file "${notesFile}"` : "--generate-notes";
    sh(`gh release create "${tag}" ${quoted} --title "${tag}" ${notesArgs} --latest`);
    console.log(
      `\n[publish-local] ✓ 已创建 Release ${tag}` +
        (files.length > 0 ? `（${files.length} 个产物）` : "（纯文本发布，无产物）")
    );
  } else if (clobber) {
    const quoted = files.map((f) => `"${f}"`).join(" ");
    sh(`gh release upload "${tag}" ${quoted} --clobber`);
    if (notesFile) sh(`gh release edit "${tag}" --notes-file "${notesFile}"`);
    console.log(`\n[publish-local] ✓ 已覆盖 Release ${tag} 的产物（--clobber）`);
  } else {
    console.error(
      `\nRelease ${tag} 已存在。要覆盖它的产物，加 --clobber（会替换同名资产）。\n` +
        `想看一眼：gh release view ${tag}`
    );
    process.exit(1);
  }
} finally {
  // 清掉临时 notes 文件，别留在工作区里
  const tmp = path.join(ROOT, `.publish-local-notes-${version}.md`);
  if (!notesFileArg && fs.existsSync(tmp)) fs.unlinkSync(tmp);
}

console.log(`\n[publish-local] 完成。查看：gh release view ${tag} --web`);
