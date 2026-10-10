/**
 * pi-starter · 跨平台调用 npm（审计类门禁共用）
 *
 * 为什么需要它：`execFileSync("npm", …)` 在 Windows 上**必失败**——那里的 `npm` 是 `npm.cmd`，
 * 而 Node 不经 shell 不允许 spawn `.cmd` / `.bat`（实测 `ENOENT`）。于是号称「本地与远端口径
 * 一致」的依赖审计在 Windows 上一次都没真的跑过。
 *
 * 光加 `shell: true` 是**半个**修法：cmd.exe 会用它自己的退出码 1 报「不是内部或外部命令」，
 * 拿不到 `ENOENT`，调用方就没法把「npm 压根不存在」和「npm 跑完了但判定有漏洞 / 没网」分开——
 * 结果要么恒红，要么把坏掉的闸门当成"今天没网"放过（后者更危险，因为它打印的还是"跳过"）。
 *
 * 所以这里在真正干活**之前**先探一次：用最终要用的那条调用路径跑 `npm --version`，
 * 拿到形如 `11.19.1` 的输出才算可用。探测不过一律回 `null`，调用方据此判「无法执行」，
 * 既不算通过，也不冒充"发现了漏洞"。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 候选调用方式，按「不经 shell」优先：
 *   1. 与 `node` 同侧的 `npm-cli.js`（Windows 安装器与多数发行版都在 `<node>/node_modules/npm/bin`）；
 *   2. `<node>/../lib/node_modules/npm/bin/npm-cli.js`（Linux 上 npm 常是指向那里的符号链接）；
 *   3. PATH 上的 `npm`（POSIX 可直接 spawn；Windows 只能经 shell）。
 */
function candidates() {
  const nodeDir = dirname(process.execPath);
  const list = [];
  for (const cli of [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ]) {
    if (existsSync(cli)) list.push({ cmd: process.execPath, prefix: [cli], shell: false });
  }
  list.push({ cmd: "npm", prefix: [], shell: process.platform === "win32" });
  return list;
}

/**
 * 找一个**确实能用**的 npm，并返回怎么调用它。
 * 返回 `null` = 所有候选都没探通 —— 这是闸门坏了，不是依赖有漏洞，也不是网络问题。
 */
export function resolveNpm() {
  for (const candidate of candidates()) {
    try {
      const out = execFileSync(candidate.cmd, [...candidate.prefix, "--version"], {
        encoding: "utf8",
        shell: candidate.shell,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
      });
      const version = String(out ?? "").trim();
      // 必须是版本号本身。shell 下即使命令不存在也可能有输出，所以只认 `<major>.<minor>` 开头。
      if (/^\d+\.\d+/.test(version)) {
        return {
          cmd: candidate.cmd,
          prefix: candidate.prefix,
          shell: candidate.shell,
          version,
          label: candidate.prefix.length > 0 ? "node npm-cli.js" : "npm",
        };
      }
    } catch {
      // 这个候选不行，试下一个。
    }
  }
  return null;
}

/** 用探测到的调用方式，把 `args` 拼成一次 spawn 的完整参数。 */
export function npmInvocation(npm, args) {
  return { cmd: npm.cmd, args: [...npm.prefix, ...args], shell: npm.shell };
}
