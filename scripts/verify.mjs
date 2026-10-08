#!/usr/bin/env node
// ============================================================================
// scripts/verify.mjs —— 配置驱动的发布门禁（通用，不绑定任何技术栈）
//
// 读项目根目录 pipeline.config.json 的 "verify" 数组，逐条执行；
// 任何一条失败即停，最后汇总失败清单并以非 0 退出。
// 换技术栈只改配置，不改本文件。
//
// 用法（在项目根目录）：
//   npm run verify                       # 跑全部
//   node scripts/verify.mjs --list       # 只列出会跑哪些命令，不执行
//   node scripts/verify.mjs --only "rust fmt"          # 只跑指定项（可重复传）
//   node scripts/verify.mjs --skip "frontend build"    # 跳过指定项（可重复传）
//   node scripts/verify.mjs --key precommit        # 跑配置里的 precommit 数组（提交前的快门禁）
//   node scripts/verify.mjs --config path/to/pipeline.config.json
// ============================================================================

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
function valuesOf(flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) out.push(argv[i + 1]);
  }
  return out;
}
// 未知参数直接报错：拼错的 --xxx 静默忽略会与本意相反（理由同 release.mjs）
const KNOWN_FLAGS = ["--list", "--only", "--skip", "--key", "--config"];
const unknownFlags = argv.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.includes(a));
if (unknownFlags.length > 0) {
  console.error(
    `未知参数：${unknownFlags.join(" ")}\n` +
      `可用参数：${KNOWN_FLAGS.join(" / ")}（--only / --skip / --key 需跟一个值，--config 需跟一个路径）`
  );
  process.exit(1);
}

const listOnly = argv.includes("--list");
const only = valuesOf("--only");
const skip = valuesOf("--skip");
const configArgIdx = argv.indexOf("--config");
const configPath = path.resolve(
  ROOT,
  configArgIdx >= 0 && argv[configArgIdx + 1] ? argv[configArgIdx + 1] : "pipeline.config.json"
);

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    console.error(
      `找不到配置文件：${configPath}\n` +
        `从模板目录复制 pipeline.config.example.json 到项目根目录并改名为 pipeline.config.json（按项目实际情况改其中的字段）。`
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

// 读哪个数组：默认 verify（全量门禁）；--key precommit 读配置里的快门禁
const keyIdx = argv.indexOf("--key");
const configKey = keyIdx >= 0 && argv[keyIdx + 1] ? argv[keyIdx + 1] : "verify";

const config = loadConfig();
const steps = Array.isArray(config[configKey]) ? config[configKey] : [];

if (steps.length === 0) {
  console.error(
    `配置里没有 ${configKey} 数组（或为空）：${configPath}\n` +
      (configKey === "verify"
        ? "请先写上门禁命令；确实不需要门禁的仓库，把 release.mjs 用 --no-verify 跑。"
        : `--key ${configKey} 指向的是可选门禁（如 precommit），留空即可 —— 调用方会自动跳过。`)
  );
  process.exit(1);
}

/** Windows 下 npm / pnpm / yarn / npx / bun 必须以 .cmd 形式调用，否则 execSync 找不到 */
function normalizeCmd(cmd) {
  if (process.platform !== "win32") return cmd;
  return cmd.replace(/^(npm|pnpm|yarn|npx|bun)(\s)/, "$1.cmd$2");
}

const selected = steps.filter((s) => {
  const name = s.name || s.cmd;
  if (only.length > 0 && !only.includes(name)) return false;
  if (skip.includes(name)) return false;
  return true;
});

if (selected.length === 0) {
  console.error("过滤后没有要跑的项，检查 --only / --skip 的名字是否与配置里的 name 一致。");
  process.exit(1);
}

if (listOnly) {
  console.log(`配置文件：${path.relative(ROOT, configPath)}`);
  for (const [i, s] of selected.entries()) {
    const cwd = s.cwd ? `  (cwd: ${s.cwd})` : "";
    console.log(`  ${i + 1}. [${s.name || s.cmd}] ${s.cmd}${cwd}`);
  }
  process.exit(0);
}

const failed = [];

for (const step of selected) {
  const name = step.name || step.cmd;
  const cwd = step.cwd ? path.resolve(ROOT, step.cwd) : ROOT;
  console.log(`\n=== [${name}] ===`);
  try {
    execSync(normalizeCmd(step.cmd), { cwd, stdio: "inherit" });
    console.log(`--- ${name} 通过 ---`);
  } catch {
    failed.push(name);
  }
}

if (failed.length > 0) {
  console.error(`\n[verify] 以下 ${failed.length} 项失败：\n  - ${failed.join("\n  - ")}`);
  process.exit(1);
}

console.log(`\n[verify] 全绿：${selected.map((s) => s.name || s.cmd).join(" / ")} 均通过。`);
