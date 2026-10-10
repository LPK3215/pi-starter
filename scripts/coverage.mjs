#!/usr/bin/env node
/**
 * pi-starter · 覆盖率门禁（棘轮阈值）
 *
 * 用 Node 内置的 `--experimental-test-coverage`（零依赖，与测试同一次运行，不额外引入 c8/nyc）。
 * 只看 `src/**`：workspace 之外的文件（编辑器插件等）不该影响本项目的数字。
 *
 * **棘轮（ratchet）**：阈值定在「当前实测值下方一点」，只允许往上调。
 * 这样它挡的是「覆盖率的下降」，而不是逼你现在去补一大片测试 ——
 * 门槛设得虚高只会让人加 `/* istanbul ignore *\/`，那是反效果。
 *
 * 实测基线（2026-10-10）：lines 92.82 / branches 81.15 / functions 85.73。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** 只降不升的棘轮阈值（略低于实测基线）。调高之前先跑一次看真实数字。 */
const THRESHOLDS = { lines: 92, branches: 81, functions: 85 };

const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const files = pkg.scripts.test
  .split(/\s+/)
  .filter((piece) => piece.endsWith(".test.ts"));
if (files.length === 0) {
  console.error("package.json 的 test 脚本里没有找到任何 *.test.ts");
  process.exit(2);
}

/**
 * `--test-coverage-include` 需要 Node >= 22.14（engines 已要求 >=22.19）。
 *
 * 低版本上的处理是**明确降级并说明**，而不是静默通过、也不是直接变红：
 * 工具不支持不该被当成覆盖率不达标。
 */
const [major, minor] = process.versions.node.split(".").map(Number);
const coverageSupported = major > 22 || (major === 22 && (minor ?? 0) >= 14);

if (!coverageSupported) {
  console.warn(
    `⚠️  当前 Node ${process.versions.node} 不支持 --test-coverage-include（需要 >=22.14），` +
      `本次降级为普通测试：覆盖率阈值未检查。`,
  );
  const plain = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
    cwd: ROOT,
    stdio: "inherit",
  });
  process.exit(plain.status ?? 1);
}

const args = [
  "--import",
  "tsx",
  "--test",
  "--experimental-test-coverage",
  "--test-coverage-include=src/**",
  `--test-coverage-lines=${THRESHOLDS.lines}`,
  `--test-coverage-branches=${THRESHOLDS.branches}`,
  `--test-coverage-functions=${THRESHOLDS.functions}`,
  ...files,
];

console.log(
  `覆盖率门禁：lines>=${THRESHOLDS.lines} / branches>=${THRESHOLDS.branches} / functions>=${THRESHOLDS.functions}（src/**，${files.length} 个测试文件）`,
);
const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
process.exit(result.status ?? 1);
