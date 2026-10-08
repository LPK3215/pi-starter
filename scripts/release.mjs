#!/usr/bin/env node
// ============================================================================
// scripts/release.mjs —— 配置驱动的发版（通用，不绑定任何技术栈）
//
// 读项目根目录 pipeline.config.json：
//   versionFiles  版本回写位置（type: json / toml-package / cargo-lock / regex）
//   tagPrefix     tag 前缀，默认 "v"
//   remote        git 远程名，默认 "origin"
//   verify        （由 scripts/verify.mjs 读取）发布门禁命令
// 换技术栈只改配置，不改本文件。
//
// 流程：
//   1. 检查工作区无未提交改动（--force 可跳过）
//   2. 跑发布门禁（--no-verify / --dry-run 跳过）
//   3. 检查 tag 是否已存在
//   4. 把新版本号回写到 versionFiles 列出的每一处
//   5. 提交版本回写 → 打 tag → 推送分支 + tag
//   6. CI 收到 tag 后构建并发布 Release
//
// 用法（在项目根目录）：
//   npm run release -- 0.2.4                # 普通发布（先跑门禁）
//   npm run release -- 0.2.4 --dry-run      # 只预览会回写哪些文件，不写盘不提交不推送
//   npm run release -- 0.2.4 --no-verify    # 跳过门禁（不建议）
//   npm run release -- 0.2.4 --force        # 工作区有改动也强发（风险自负）
//   node scripts/release.mjs 0.2.4 --config path/to/pipeline.config.json
// ============================================================================

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--config") {
    i++;
    continue;
  }
  if (args[i].startsWith("--")) continue;
  positional.push(args[i]);
}
// 未知参数直接报错：拼错的 --xxx 会被静默忽略（例如想跳门禁却打成 `--skip-verify`），
// 结果与本来意图相反却不报错 —— 这类静默失败比直接失败更难查。
const KNOWN_FLAGS = ["--force", "--dry-run", "--no-verify", "--config"];
const unknownFlags = args.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.includes(a));
if (unknownFlags.length > 0) {
  console.error(
    `未知参数：${unknownFlags.join(" ")}\n` +
      `可用参数：${KNOWN_FLAGS.join(" / ")}（--config 需跟一个路径）`
  );
  process.exit(1);
}

const versionArg = positional[0];
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const skipVerify = args.includes("--no-verify") || dryRun;
const configIdx = args.indexOf("--config");
const configPath = path.resolve(
  ROOT,
  configIdx >= 0 && args[configIdx + 1] ? args[configIdx + 1] : "pipeline.config.json"
);

if (!versionArg) {
  console.error(
    "用法：npm run release -- <版本，如 0.2.4> [--no-verify] [--force] [--dry-run] [--config <path>]"
  );
  process.exit(1);
}

const version = versionArg.replace(/^v/, "");
// 接受标准 semver（含预发布与构建元数据）：0.2.4 / v0.2.4 / 1.0.0-rc.1 / 2.0.0-beta.3+build.5
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
if (!SEMVER.test(version)) {
  console.error(
    `版本号格式错误：${versionArg}\n应为 0.2.4 或 v0.2.4（也接受 1.0.0-rc.1 这类预发布版本）。`
  );
  process.exit(1);
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    console.error(
      `找不到配置文件：${configPath}\n` +
        `从模板目录复制 pipeline.config.example.json 到项目根目录并改名为 pipeline.config.json，再按项目实际情况改字段。`
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
const tag = `${tagPrefix}${version}`;
const versionFiles = Array.isArray(config.versionFiles) ? config.versionFiles : [];

if (versionFiles.length === 0) {
  console.error(`配置里没有 versionFiles（或为空）：${configPath}\n没有要回写的位置就无从发版。`);
  process.exit(1);
}

function rel(abs) {
  return path.relative(ROOT, abs) || abs;
}

function sh(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
}

/** 顶层 version 字段（package.json / tauri.conf.json） */
function bumpJson(abs, raw, nextVersion) {
  const obj = JSON.parse(raw);
  if (typeof obj.version !== "string") throw new Error(`${rel(abs)} 缺少顶层 version 字段，无法回写`);
  if (obj.version === nextVersion) return null;
  const old = obj.version;
  obj.version = nextVersion;
  return { file: abs, old, next: `${JSON.stringify(obj, null, 2)}\n` };
}

/** TOML [package] 段的 version 行（Cargo.toml） */
function bumpTomlPackage(abs, raw, nextVersion) {
  const marker = raw.indexOf("[package]");
  if (marker < 0) throw new Error(`${rel(abs)} 找不到 [package] 段`);
  const rest = raw.slice(marker);
  const m = rest.match(/^version = "([^"]*)"/m);
  if (!m) throw new Error(`${rel(abs)} 的 [package] 段里没有 version 行`);
  if (m[1] === nextVersion) return null;
  const next = rest.replace(/^version = "[^"]*"/m, `version = "${nextVersion}"`);
  return { file: abs, old: m[1], next: raw.slice(0, marker) + next };
}

/** Cargo.lock 中 name = <pkgName> 的那个 [[package]] 块的 version */
function bumpCargoLock(abs, raw, nextVersion, pkgName) {
  if (!pkgName) {
    throw new Error(`${rel(abs)} 的 type 是 cargo-lock，必须在配置里补 name 字段（Cargo 包名）`);
  }
  const lines = raw.split("\n");
  const out = [];
  let inBlock = false;
  let isTarget = false;
  let found = false;
  let oldVersion = null;
  for (const line of lines) {
    if (line.trim() === "[[package]]") {
      inBlock = true;
      isTarget = false;
      out.push(line);
      continue;
    }
    if (inBlock && !isTarget) {
      const m = line.match(/^name = "([^"]*)"/);
      if (m) {
        found = true;
        isTarget = m[1] === pkgName;
        out.push(line);
        continue;
      }
    }
    if (inBlock && isTarget) {
      const m = line.match(/^version = "([^"]*)"/);
      if (m) {
        oldVersion = m[1];
        out.push(oldVersion === nextVersion ? line : `version = "${nextVersion}"`);
        continue;
      }
    }
    out.push(line);
  }
  if (!found) throw new Error(`在 ${rel(abs)} 里找不到 name = "${pkgName}" 的 [[package]] 块`);
  if (oldVersion === null) throw new Error(`name = "${pkgName}" 的块里没有 version 行（${rel(abs)}）`);
  if (oldVersion === nextVersion) return null;
  return { file: abs, old: oldVersion, next: out.join("\n") };
}

/** 自定义正则：pattern 匹配含旧版本的那段文本，replace 里的 $VERSION 代表新版本 */
function bumpRegex(abs, raw, nextVersion, entry) {
  if (!entry.pattern || typeof entry.replace !== "string") {
    throw new Error(`${rel(abs)} 的 regex 项必须同时给 pattern 与 replace`);
  }
  const flags = entry.flags || "m";
  if (!new RegExp(entry.pattern, flags).test(raw)) {
    throw new Error(`正则没有匹配到任何内容：${entry.pattern}（${rel(abs)}）`);
  }
  const next = raw.replace(
    new RegExp(entry.pattern, flags),
    entry.replace.replaceAll("$VERSION", nextVersion)
  );
  if (next === raw) return null;
  return { file: abs, old: "(regex)", next };
}

function bump(entry) {
  const abs = path.resolve(ROOT, entry.path);
  if (!fs.existsSync(abs)) throw new Error(`版本文件不存在：${entry.path}`);
  const raw = fs.readFileSync(abs, "utf8");
  switch (entry.type) {
    case "json":
      return bumpJson(abs, raw, version);
    case "toml-package":
      return bumpTomlPackage(abs, raw, version);
    case "cargo-lock":
      return bumpCargoLock(abs, raw, version, entry.name);
    case "regex":
      return bumpRegex(abs, raw, version, entry);
    default:
      throw new Error(
        `未知的 type：${entry.type}（${entry.path}）。可选：json / toml-package / cargo-lock / regex`
      );
  }
}

function ensureGitIdentity() {
  try {
    execSync("git config user.name", { cwd: ROOT, stdio: "pipe" });
    execSync("git config user.email", { cwd: ROOT, stdio: "pipe" });
  } catch {
    console.error(
      "\n本机 git 没有配置 user.name / user.email，无法自动提交版本回写。\n" +
        '先执行：git config user.name "你的名字" && git config user.email "you@example.com"'
    );
    process.exit(1);
  }
}

// 1) 工作区状态
const status = execSync("git status --porcelain", { cwd: ROOT }).toString().trim();
if (status && !force) {
  console.error(
    "工作区有未提交改动，发布应从干净历史出发。\n" +
      "先提交或撤销改动，或用 --force 强行发布（风险自负）。\n\n" +
      status
  );
  process.exit(1);
}

// 2) 门禁
// 直接调用同目录的 verify.mjs —— 不依赖 package.json 里的 scripts，
// 这样没有 package.json 的项目（纯 Python / 纯 Rust）也能用同一套。
if (!skipVerify) {
  sh(`"${process.execPath}" "${path.join(__dirname, "verify.mjs")}"`);
}

// 3) tag 已存在检查
try {
  execSync(`git rev-parse "${tag}"`, { cwd: ROOT, stdio: "ignore" });
  console.error(
    `tag ${tag} 已存在。删除旧 tag（git tag -d ${tag} && git push ${remote} :${tag}）后再发。`
  );
  process.exit(1);
} catch {
  /* tag 不存在，继续 */
}

// 4) 版本号回写
const bumps = versionFiles.map(bump).filter(Boolean);

if (bumps.length === 0) {
  console.log(`\n[release] 所有版本文件都已是 ${version}，无需回写。`);
} else {
  console.log(`\n[release] 把版本号回写为 ${version}：`);
  for (const b of bumps) {
    console.log(`  - ${rel(b.file)}: ${b.old} -> ${version}`);
  }
}

if (dryRun) {
  console.log("\n[dry-run] 以上仅为预览：未写盘、未提交、未推送。");
  process.exit(0);
}

if (bumps.length > 0) {
  ensureGitIdentity();
  for (const b of bumps) fs.writeFileSync(b.file, b.next);
  const quoted = bumps.map((b) => `"${b.file}"`).join(" ");
  sh(`git add -- ${quoted}`);
  // 用 --no-verify 提交：本脚本第 2 步已经跑过全量门禁（verify），
  // 而项目的 pre-commit 钩子跑的是 precommit（人工提交用的快检子集）——
  // 再跑一遍既冗余，又会在钩子环境不满足时（如刚 clone 没装依赖）把发版
  // 中断在「版本号已回写写盘、但没提交」的半成品状态。钩子是给人工提交用的，
  // 自动化流程自带更强的门禁。
  sh(`git commit --no-verify -m "chore: bump version to ${tag}"`);
}

// 5) 打 tag + 推送
sh(`git tag "${tag}"`);
const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: ROOT }).toString().trim();
sh(`git push ${remote} "${branch}"`);
sh(`git push ${remote} "${tag}"`);

let web = "";
try {
  const remoteUrl = execSync(`git remote get-url ${remote}`, { cwd: ROOT }).toString().trim();
  web = remoteUrl
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/")
    .replace(/\.git$/, "");
} catch {
  /* 取不到就当没有，不影响发版 */
}

console.log(`\n[release] ${tag} 已推送。CI 收到 tag 后会构建并发布 Release${web ? "：" : "。"}`);
if (web) console.log(`  ${web}/releases`);
