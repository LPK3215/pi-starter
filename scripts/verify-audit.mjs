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
//
// 退出码：0 全通过（可有 SKIP）；1 审计判定有问题；2 **审计没能执行**（闸门坏了，
// 与"依赖有漏洞"必须分开报，否则平台问题会被读成安全问题）。
// ============================================================================

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { npmInvocation, resolveNpm } from "./npm-invocation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "https://registry.npmjs.org";

const results = [];

/**
 * 调用前先探一次 npm，原因见 `npm-invocation.mjs`：Windows 上 `npm` 是 `npm.cmd`，不经 shell
 * 就 spawn 不了（实测 ENOENT，于是这条"本地与远端口径一致"的审计在 Windows 上一次都没真的跑过，
 * 还被裸 catch 报成「审计失败」——恒红，且把平台问题误标成依赖有问题）；而**加上** shell 只解决了
 * 一半：cmd.exe 会用退出码 1 报"不是内部或外部命令"，看起来和一次正常的审计失败一模一样。
 * 探不通就判「无法执行」：既不算通过，也不算"依赖有漏洞"。
 */
const npm = resolveNpm();

/**
 * 三种结论，不是一种：通过 / 失败（npm 判定有高危）/ 无法执行（npm 根本没起来）。
 * 与 `skip()` 的区别：skip 是**已知前提不成立**（比如没装 web/node_modules），
 * 而「无法执行」是**本该跑却跑不动**。
 */
function run(name, npmArgs, cwd) {
  if (!npm) {
    results.push({ name, ok: false, unavailable: true, reason: "找不到可用的 npm（试过 npm-cli.js 与 PATH 上的 npm）" });
    console.error(`\n=== [${name}] ===\n--- 无法执行：找不到可用的 npm —— 审计根本没跑，这不是通过 ---`);
    return;
  }
  const { cmd, args, shell } = npmInvocation(npm, npmArgs);
  console.log(`\n=== [${name}] ===\n$ ${npm.label} ${npmArgs.join(" ")}`);
  try {
    execFileSync(cmd, args, { cwd, stdio: "inherit", shell });
    results.push({ name, ok: true });
    console.log(`--- ${name} 通过 ---`);
  } catch (err) {
    // 起不动时没有退出码（`status` 为 undefined），只有 `code`；npm 判定失败则是正常退出码。
    if (err && err.status === undefined && (err.code === "ENOENT" || err.code === "EINVAL")) {
      results.push({ name, ok: false, unavailable: true, reason: `${err.code}：npm 无法执行` });
      console.error(`--- ${name} 无法执行（${err.code}）：审计根本没跑，这不是通过 ---`);
      return;
    }
    results.push({ name, ok: false, reason: `npm 退出码 ${err && err.status}` });
    console.error(`--- ${name} 失败（npm 退出码 ${err && err.status}）---`);
  }
}
function skip(name, reason) {
  results.push({ name, ok: true, skipped: true, reason });
  console.log(`\nSKIP  ${name} — ${reason}`);
}

// 1) 根包：与远端 .cnb.yml 的 audit 步骤同一条命令
run("audit: backend", ["audit", "--audit-level=high", `--registry=${REGISTRY}`], ROOT);

// 2) web/：走基线化闸门（提前判 node_modules，避免把"没装依赖"误报成"审计失败"）
const webRoot = path.join(ROOT, "web");
if (existsSync(path.join(webRoot, "node_modules"))) {
  run("audit: frontend", ["run", "check:audit"], webRoot);
} else {
  skip("audit: frontend", "web/node_modules 不存在（先跑 `npm ci --prefix web`）");
}

const failed = results.filter((r) => !r.ok);
const unavailable = failed.filter((r) => r.unavailable);
const skipped = results.filter((r) => r.skipped);
console.log(
  `\n[verify:audit] ${results.length - failed.length - skipped.length} 通过 / ${skipped.length} 跳过 / ` +
    `${failed.length - unavailable.length} 失败 / ${unavailable.length} 无法执行`
);
if (skipped.length > 0) {
  console.log("跳过的项（没验证不等于验证通过）：");
  for (const s of skipped) console.log(`  - ${s.name} — ${s.reason}`);
}
if (unavailable.length > 0) {
  console.error(
    `以下 ${unavailable.length} 项**没能执行**（不是依赖有漏洞，是审计跑不起来，多半是 npm 定位失败）：`
  );
  for (const u of unavailable) console.error(`  - ${u.name} — ${u.reason}`);
  process.exit(2);
}
if (failed.length > 0) {
  console.error(`以下 ${failed.length} 项失败：\n  - ${failed.map((r) => `${r.name}（${r.reason}）`).join("\n  - ")}`);
  process.exit(1);
}
