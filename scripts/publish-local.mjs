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
// 「建 Release」按**主远程的宿主**自动选后端（可用配置 "host": "cnb" / "github" 显式覆盖）：
//   · GitHub（github.com）→ 需要 gh（GitHub CLI）并已登录；
//   · CNB（cnb.cool）     → 需要 cnb（CNB CLI）并已登录。
// 写死 gh 会让托管在 CNB 的仓库永远发不出 Release（gh 多半没装、也没有 GitHub 远程）——
// 本仓正是这种情况：tag 推上去了却建不了 Release。故宿主必须探测，不能假设。
//
// 用法（在项目根目录）：
//   npm run publish:local              # 门禁 → 出包 → 建/更新该 tag 的 Release
//   npm run publish:local -- --dry-run # 只显示会做什么，不执行
//   npm run publish:local -- --no-release  # 只出包到本地，不碰 GitHub
//   npm run publish:local -- --no-verify   # 跳过门禁（不建议）
//   npm run publish:local -- --tag v0.2.1  # 显式指定 tag（默认按版本文件推导）
//   npm run publish:local -- --force       # 工作区有改动也继续（风险自负）
// ============================================================================

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
// 全部远程（与 release.mjs 同一口径）：Release 只挂在主远程 remote 上，但镜像
// 远程缺 tag 需要能看到，否则推一漏一不会有人发现。
const remotes = [
  ...new Set(
    (Array.isArray(config.remotes) && config.remotes.length > 0
      ? config.remotes
      : [remote]
    ).filter((r) => typeof r === "string" && r.trim())
  ),
];
const versionFiles = Array.isArray(config.versionFiles) ? config.versionFiles : [];
const lp = config.localPublish && typeof config.localPublish === "object" ? config.localPublish : {};
const steps = Array.isArray(lp.steps) ? lp.steps : [];
const artifactGlobs = Array.isArray(lp.artifacts) ? lp.artifacts : [];

// ---------------------------------------------------------------- 宿主识别
/** 主远程 URL（取不到就当空串：后续会按默认宿主走并给出可读报错）。 */
function remoteUrl(name) {
  try {
    return execSync(`git remote get-url ${name}`, { cwd: ROOT, stdio: "pipe" }).toString().trim();
  } catch {
    return "";
  }
}

/**
 * Release 建在哪个平台 —— 由**主远程的 URL** 决定，而不是写死 GitHub。
 * 配置里的 "host" 可显式覆盖（自建域名 / 镜像场景）。
 */
function detectHost() {
  if (config.host === "cnb" || config.host === "github") return config.host;
  return /(^|[/.@])cnb\.cool([:/]|$)/i.test(remoteUrl(remote)) ? "cnb" : "github";
}
const host = detectHost();

/** `git@cnb.cool:org/repo.git` 与 `https://cnb.cool/org/repo.git` → `org/repo`。 */
function repoSlug() {
  const url = remoteUrl(remote);
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  if (!m) {
    console.error(
      `\n从主远程 ${remote} 的 URL 推不出「组织/仓库」：${url || "(取不到)"}\n` +
        `CNB 的 Release 接口需要它，请在 pipeline.config.json 里改成可解析的远程地址。`
    );
    process.exit(1);
  }
  return m[1];
}

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

// ---------------------------------------------------------------- CNB 后端
/**
 * 定位 cnb CLI 到底怎么调起来。Windows 上 npm 全局装的是 `cnb.cmd` shim，三条路都有坑：
 *   · `execFileSync("cnb", …)`       → ENOENT（CreateProcess 跑不了那个无扩展名的 sh 脚本）
 *   · `execFileSync("cnb.cmd", …)`   → EINVAL（Node 禁止不经 shell spawn .bat/.cmd）
 *   · 只有经 cmd.exe 起得来，而 `shell: true` 下 Node **只拼接、不转义**参数（DEP0190）——
 *     本脚本要传 slug、tag、以及 `--body-file` 的路径，拼接一次就是一次引号事故。
 *
 * 所以从 .cmd shim 里取出真正的 JS 入口，用 `node <entry> …` 直接跑：数组传参、不经 shell。
 * 与 `scripts/npm-invocation.mjs` 对 npm 的处理同一思路，也补上了原先那个错：**预检走 shell、
 * 实跑走 execFileSync**，于是 `cnb --version` 检得过、`cnb releases …` 必炸。
 */
function cnbCli() {
  if (process.platform !== "win32") return { cmd: "cnb", prefix: [] };
  let shim;
  try {
    // `where` 只查路径、不执行任何带参数的命令，没有引号面。
    shim = execSync("where cnb", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /\.cmd$/i.test(line));
  } catch {
    return null;
  }
  if (!shim) return null;
  const matched = /"([^"]*node_modules[^"]*\.js)"/i.exec(fs.readFileSync(shim, "utf8"));
  if (!matched) return null;
  const entry = matched[1].split("%dp0%").join(path.dirname(shim));
  return fs.existsSync(entry) ? { cmd: process.execPath, prefix: [entry] } : null;
}

const CNB = cnbCli();

/** 取不到 cnb 的真身就按「无法执行」红出去——不许退化成"Release 不存在"或"没装 CLI"。 */
function requireCnb(what) {
  if (CNB) return CNB;
  console.error(
    `\n[cnb] ${what}：无法执行 cnb CLI。\n` +
      "Windows 上它是 npm 全局的 .cmd shim，本脚本会从其 JS 入口直接起（不经 cmd.exe，避免参数被拼接）。\n" +
      "取不到入口通常是 cnb 没装或不在 PATH：`npm i -g @cnbcool/cnb-cli`，或先用 --no-release 只出包。"
  );
  process.exit(2);
}

function cnbReady() {
  const cnb = requireCnb("预检");
  try {
    execFileSync(cnb.cmd, [...cnb.prefix, "--version"], { stdio: "pipe" });
  } catch {
    console.error(
      `\n建 Release 需要可用的 CNB CLI（cnb）：本仓主远程 ${remote} 在 CNB 上，但 \`--version\` 跑不起来。\n` +
        `只想在本地出包、不出 Release 的话，加 --no-release。`
    );
    process.exit(1);
  }
}

/** 跑一条 `cnb releases …`（数组传参，不拼字符串——token / 路径里可能有特殊字符）。 */
function cnbRun(...argv) {
  const cmd = ["releases", ...argv];
  console.log(`\n$ cnb ${cmd.join(" ")}`);
  if (dryRun) return "";
  const cnb = requireCnb("写操作");
  return execFileSync(cnb.cmd, [...cnb.prefix, ...cmd], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();
}

/**
 * CLI 的输出是 `status: 200` 加一段 `data:` 下的 `  key: value`，也用它报错
 * （404 时退出码为 3，走 catch）。这里只取需要的几个标量，不引 YAML 依赖。
 */
function parseCnbData(out) {
  const obj = {};
  let inData = false;
  for (const raw of String(out).split(/\r?\n/)) {
    if (/^data:\s*$/.test(raw)) {
      inData = true;
      continue;
    }
    if (!inData) {
      const m = raw.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (m) obj[m[1]] = m[2];
      continue;
    }
    const m = raw.match(/^\s{2}([A-Za-z_]+):\s*(.*)$/);
    if (m) obj[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return obj;
}

/** 只读查询：dry-run 下也照常执行（无副作用），这样预览里说"创建"还是"更新"才是真的。 */
function cnbQuery(...argv) {
  const cmd = ["releases", ...argv];
  console.log(`$ cnb ${cmd.join(" ")}`);
  // 先确认 cnb 起得来，再进 try：否则「压根没跑起来」会被下面的 catch 吞成"查不到 Release"，
  // 于是预览会说"将新建"，而真实原因只是这台机器调不动 CLI。
  const cnb = requireCnb("只读查询");
  try {
    return execFileSync(cnb.cmd, [...cnb.prefix, ...cmd], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
    }).toString();
  } catch {
    // cnb **跑起来了**但退出非 0（例如该 tag 还没有 Release）——这是语义结果，不是闸门坏了。
    return "";
  }
}

/** 用 tag 查 Release；不存在（CLI 退出非 0）或 tag 不匹配都返回 null。 */
function cnbGetRelease(slug, tagName) {
  const d = parseCnbData(cnbQuery("get-release-by-tag", "--repo", slug, "--tag", tagName));
  return d.tag_name === tagName ? d : null;
}

function cnbCreateRelease(slug, tagName, notes) {
  const argv = [
    "post-release",
    "--repo", slug,
    "--tag-name", tagName,
    "--name", tagName,
    "--make-latest", "true",
  ];
  if (notes) argv.push("--body-file", notes);
  const d = parseCnbData(cnbRun(...argv));
  if (!dryRun && !d.id) throw new Error("创建 Release 失败：CNB 响应里没有 id");
  return d;
}

/**
 * 上传一个产物：要上传地址 → PUT 到预签名地址 → 确认。
 * `overwrite` 命中同名附件（对应 gh 的 --clobber），不必先查 asset id 再删。
 */
async function cnbUploadAsset(slug, releaseId, file, overwrite) {
  const size = fs.statSync(file).size;
  const argv = [
    "post-release-asset-upload-url",
    "--repo", slug,
    "--release-id", releaseId,
    "--asset-name", path.basename(file),
    "--size", String(size),
    "--ttl", "0",
  ];
  if (overwrite) argv.push("--overwrite");
  const d = parseCnbData(cnbRun(...argv));
  if (dryRun) return;

  const { upload_url: url, verify_url: verifyUrl } = d;
  if (!url || !verifyUrl) {
    throw new Error(`拿不到上传地址：${JSON.stringify(d).slice(0, 200)}`);
  }

  const res = await fetch(url, { method: "PUT", body: fs.readFileSync(file) });
  if (!res.ok) throw new Error(`附件上传失败：HTTP ${res.status} ${res.statusText}（${path.basename(file)}）`);

  // verify_url 形如 …/asset-upload-confirmation/<token>/<encodeURIComponent(assetPath)>?ttl=0
  const segs = new URL(verifyUrl).pathname.split("/");
  const i = segs.indexOf("asset-upload-confirmation");
  const token = segs[i + 1];
  const assetPath = decodeURIComponent(segs[i + 2] ?? "");
  if (!token || !assetPath) throw new Error(`解析不了 verify_url：${verifyUrl}`);

  cnbRun(
    "post-release-asset-upload-confirmation",
    "--repo", slug,
    "--release-id", releaseId,
    "--upload-token", token,
    "--asset-path", assetPath,
    "--ttl", "0"
  );
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

// 镜像远程只提醒不阻断：本脚本的职责是出包 + 建 Release，
// 把缺的 tag 补上是一行 git push 的事，拼好命令直接交给用户。
const lagging = remotes.filter((r) => {
  if (r === remote) return false;
  try {
    return (
      execSync(`git ls-remote --tags ${r} "${tag}"`, { cwd: ROOT }).toString().trim().length === 0
    );
  } catch {
    return true;
  }
});
if (lagging.length > 0 && !dryRun) {
  console.warn(
    `\n[publish-local] ⚠ tag ${tag} 在这些远程上还没有：${lagging.join(", ")}。` +
      `Release 不受影响，但会跟主远程不同版本：\n  ` +
      lagging.map((r) => `git push ${r} ${tag}`).join(" && ")
  );
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
  console.log(
    `\n[publish-local] 已指定 --no-release：产物留在本地，未触碰 ${host === "cnb" ? "CNB" : "GitHub"}。`
  );
  process.exit(0);
}

// release notes：--notes 指定文件 > CHANGELOG 对应段 > 交给宿主 CLI 处理。
// 临时文件写进系统临时目录，**不落工作区**——留在仓库根目录会被误提交。
const notesTmp = path.join(os.tmpdir(), `publish-local-notes-${version}.md`);
let notesFile = notesFileArg || null;
if (!notesFile) {
  const body = extractChangelogSection(version);
  if (body) {
    if (!dryRun) fs.writeFileSync(notesTmp, body + "\n");
    notesFile = notesTmp;
    console.log(`\n[publish-local] release notes：取自 CHANGELOG.md 的 ${version} 段`);
  } else {
    console.log(
      `\n[publish-local] CHANGELOG.md 里没有 ${version} 段：release notes 交给 ${
        host === "cnb" ? "CNB（正文留空）" : "gh --generate-notes"
      }`
    );
  }
}

if (host === "cnb") {
  const slug = repoSlug();
  cnbReady();
  const existing = cnbGetRelease(slug, tag);

  if (dryRun) {
    console.log(
      `\n[dry-run] 宿主 CNB（${slug}）：将会${
        existing ? "更新已存在的 Release（--overwrite 覆盖同名附件）" : "创建 Release"
      } ${tag}，产物 ${files.length} 个。未执行任何写操作。`
    );
    process.exit(0);
  }

  if (existing && !clobber) {
    console.error(
      `\nRelease ${tag} 已存在。要覆盖它的产物，加 --clobber（会替换同名资产）。\n` +
        `想看一眼：cnb releases get-release-by-tag --repo ${slug} --tag ${tag}`
    );
    process.exit(1);
  }

  let releaseId = existing ? existing.id : null;
  if (!existing) {
    const created = cnbCreateRelease(slug, tag, notesFile);
    releaseId = created.id;
    console.log(
      `\n[publish-local] ✓ 已创建 Release ${tag}` +
        (files.length > 0 ? `（待挂 ${files.length} 个产物）` : "（纯文本发布，无产物）")
    );
  } else if (notesFile) {
    // 覆盖模式下正文也要跟着更新，否则 Release 正文与已挂产物不是同一版内容。
    cnbRun("patch-release", "--repo", slug, "--release-id", releaseId, "--body-file", notesFile);
  }

  for (const f of files) {
    await cnbUploadAsset(slug, releaseId, f, Boolean(existing));
    console.log(`[publish-local]   ↑ ${rel(f)}`);
  }
  if (existing) console.log(`\n[publish-local] ✓ 已覆盖 Release ${tag} 的产物（--clobber）`);

  console.log(
    `\n[publish-local] 完成。查看：cnb releases get-release-by-tag --repo ${slug} --tag ${tag}`
  );
  process.exit(0);
}

// ---------------------------------------------------------------- GitHub 后端
ghReady();

// Release 是否已存在
let releaseExists = false;
try {
  execSync(`gh release view "${tag}"`, { cwd: ROOT, stdio: "ignore" });
  releaseExists = true;
} catch {
  /* 不存在 */
}

if (dryRun) {
  console.log(
    `\n[dry-run] 宿主 GitHub：将会${releaseExists ? "更新已存在的 Release" : "创建 Release"} ${tag}，产物 ${files.length} 个。未执行任何写操作。`
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
  // 清掉临时 notes 文件，别留在临时目录里堆积
  if (!notesFileArg && fs.existsSync(notesTmp)) fs.unlinkSync(notesTmp);
}

console.log(`\n[publish-local] 完成。查看：gh release view ${tag} --web`);
