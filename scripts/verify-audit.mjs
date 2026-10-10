#!/usr/bin/env node
// ============================================================================
// scripts/verify-audit.mjs —— 让**本地**门禁与**远端**的依赖审计口径对齐
//
// 为什么需要它：远端的依赖审计藏在 `.cnb.yml` 的 verify 链与 frontend 作业里，
// 而 `npm run verify` 里**没有审计**这一步——于是「本地跑绿」从来不等于「远端能绿」。
// 这个不对称本身就是隐患（本轮的前端 audit 恒红，本地完全看不见）。
//
// 本脚本跑的是与远端**同一条命令**，只是把两个包分开跑、分别给结论：
//   1. 根包   —— 生产依赖 + 开发依赖一起闸（与 .cnb.yml 的 audit 步骤一致）
//   2. web/   —— 走 check:audit（生产依赖 0 高危硬门 + 开发依赖基线化）
//
// 诚实跳过：web/ 的审计需要 web/node_modules。没装就**明确 SKIP 并说明原因**——
// 不假装通过（"没验证"不等于"验证通过"），与 rag-smoke.mjs / e2e-restart.mjs 同款原则。
// 想让 web/ 也真正被审计，先跑 `npm ci --prefix web`。
// ============================================================================

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "https://registry.npmjs.org";

const results = [];
function run(name, cmd, args, cwd) {
  console.log(`\n=== [${name}] ===\n$ ${cmd} ${args.join(" ")}`);
  try {
    execFileSync(cmd, args, { cwd, stdio: "inherit" });
    results.push({ name, ok: true });
    console.log(`--- ${name} 通过 ---`);
  } catch {
    results.push({ name, ok: false });
  }
}
function skip(name, reason) {
  results.push({ name, ok: true, skipped: true, reason });
  console.log(`\nSKIP  ${name} — ${reason}`);
}

// 1) 根包：与远端 .cnb.yml 的 audit 步骤同一条命令
run("audit: backend", "npm", ["audit", "--audit-level=high", `--registry=${REGISTRY}`], ROOT);

// 2) web/：走基线化闸门（提前判 node_modules，避免把"没装依赖"误报成"审计失败"）
const webRoot = path.join(ROOT, "web");
if (existsSync(path.join(webRoot, "node_modules"))) {
  run("audit: frontend", "npm", ["run", "check:audit"], webRoot);
} else {
  skip("audit: frontend", "web/node_modules 不存在（先跑 `npm ci --prefix web`）");
}

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
console.log(
  `\n[verify:audit] ${results.length - failed.length - skipped.length} 通过 / ${skipped.length} 跳过 / ${failed.length} 失败`
);
if (skipped.length > 0) {
  console.log("跳过的项（没验证不等于验证通过）：");
  for (const s of skipped) console.log(`  - ${s.name} — ${s.reason}`);
}
if (failed.length > 0) {
  console.error(`以下 ${failed.length} 项失败：\n  - ${failed.map((r) => r.name).join("\n  - ")}`);
  process.exit(1);
}
