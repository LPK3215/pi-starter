import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findDangerousBash, guardExtension, isPathInsideCwd } from "./guard.js";
import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { DANGEROUS_SHELL_RULES, shellApprovalRuleSpecs } from "./shell-rules.js";
import { builtinApprovalRules } from "../approval/rules.js";

test("危险 bash 命中常见破坏性命令，放过普通命令", () => {
  assert.equal(findDangerousBash("rm -rf /")?.id, "rm-rf");
  assert.equal(findDangerousBash("sudo rm -fr /tmp/x")?.id, "rm-rf");
  assert.equal(findDangerousBash("rm -r /tmp")?.id, undefined);
  assert.equal(findDangerousBash("mkfs.ext4 /dev/sda1")?.id, "mkfs");
  assert.equal(findDangerousBash("dd if=/dev/zero of=/dev/sda")?.id, "dd");
  assert.equal(findDangerousBash("Remove-Item -Recurse C:\\temp")?.id, "windows-destructive");
  assert.equal(findDangerousBash("echo hello"), undefined);
  assert.equal(findDangerousBash("ls -la"), undefined);
});

/** 用假 `ExtensionAPI` 直接驱动 tool_call 钩子。 */
function callGuard(toolName: string, input: Record<string, unknown>, cwd = process.cwd()) {
  let handler: ((event: unknown, ctx: unknown) => ToolCallEventResult | undefined) | undefined;
  const pi = {
    on: (name: string, fn: unknown) => {
      if (name === "tool_call") handler = fn as typeof handler;
    },
  };
  guardExtension(pi as never);
  assert.ok(handler, "guard must register a tool_call handler");
  return handler!(
    { type: "tool_call", toolCallId: "c1", toolName, input } as unknown as ToolCallEvent,
    { cwd },
  );
}

/**
 * 回归（高危）：agent 自己经内置 `read`/`write`/`edit` 读写 cwd 内的 `.env`。
 *
 * 这是文件服务那条旁路的**另一半**：路径校验判的是「在不在工作目录内」，而 `.env`
 * 恰好就在工作目录里，所以只加文件服务黑名单并拦不住 agent 把模型 Key 读进上下文
 * （`read` 在任何档位都可用，审批 `builtin:secret.access` 默认又被压制为 allow）。
 */
test("guard：拒绝 agent 读写敏感文件（与文件服务共用同一名单）", () => {
  const cwd = process.cwd();
  assert.equal(callGuard("read", { path: ".env" }, cwd)?.block, true, "相对路径的 .env 必须拦");
  assert.equal(callGuard("read", { path: join(cwd, ".env") }, cwd)?.block, true, "绝对路径同样拦");
  assert.equal(callGuard("write", { path: "auth.json", content: "{}" }, cwd)?.block, true);
  assert.equal(callGuard("edit", { path: "id_rsa", oldText: "a", newText: "b" }, cwd)?.block, true);
  assert.equal(callGuard("read", { path: "server.pem" }, cwd)?.block, true);

  // 普通文件不受影响；越界 read SKILL.md 的既有白名单也不受影响。
  assert.equal(callGuard("read", { path: "README.md" }, cwd), undefined);
  assert.equal(callGuard("read", { path: "/outside/SKILL.md" }, cwd), undefined);
});

/**
 * 回归（高危）：**字面 basename 无害 ≠ 真实目标无害**。
 *
 * cwd 内一个 `alias.txt -> .env` 的符号链接：字面名 `alias.txt` 不在敏感名单里，
 * 路径也确实在 cwd 内 —— 上面那两道校验都会放行，而读出来的内容就是 `.env`。
 * 文件服务那边早就补了「真实目标名也要查」（`files/service.ts` 的 `resolvePath`），
 * guard 这边此前漏了，于是模型的 `read` 能绕过同一道铁律。
 */
test("guard：cwd 内指向 .env 的符号链接同样被拦（真实目标名校验）", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-guard-link-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, ".env"), "PI_API_KEY=sk-should-not-leak\n");
  writeFileSync(join(cwd, "notes.txt"), "无害内容\n");
  writeFileSync(join(cwd, "id_rsa"), "-----BEGIN PRIVATE KEY-----\n");
  symlinkSync(join(cwd, ".env"), join(cwd, "alias.txt")); // 绝对目标
  symlinkSync(".env", join(cwd, "relative-alias.txt")); // 相对目标
  symlinkSync(join(cwd, "id_rsa"), join(cwd, "key-link"));
  symlinkSync(join(cwd, "notes.txt"), join(cwd, "harmless.txt")); // 指向普通文件

  for (const path of ["alias.txt", "relative-alias.txt", "key-link"]) {
    const result = callGuard("read", { path }, cwd);
    assert.equal(result?.block, true, `${path} 经符号链接指向敏感文件，必须拦`);
    assert.match(String(result?.reason), /符号链接指向/);
  }
  // 子目录里的链接同样要拦（不能被「相对路径」绕过）。
  assert.equal(callGuard("read", { path: "sub/../alias.txt" }, cwd)?.block, true);

  // 不误伤：指向普通文件的链接照常放行，普通文件也不受影响。
  assert.equal(callGuard("read", { path: "harmless.txt" }, cwd), undefined);
  assert.equal(callGuard("read", { path: "notes.txt" }, cwd), undefined);
  // 目标不存在时不解析，避免把父目录名误当成目标名。
  assert.equal(callGuard("read", { path: "not-created-yet.txt" }, cwd), undefined);
});

test("路径必须落在 cwd 内，跨目录和绝对路径越界被拦", () => {
  const cwd = process.cwd();
  assert.equal(isPathInsideCwd("src/agent.ts", cwd), true);
  assert.equal(isPathInsideCwd(".", cwd), true);
  assert.equal(isPathInsideCwd("../secret", cwd), false);
  assert.equal(isPathInsideCwd("src/../../secret", cwd), false);
});

/**
 * 回归：危险命令表曾有两份且已漂移。
 *
 * `guard` 的正则表与审批规则的 `BUILTIN_RULES` 各维护一份，审批多了
 * `git-destructive` / `chmod-recursive` 两条而 guard 没有。现在两边同源于
 * `shell-rules.ts`，这个测试锁住「同源」且锁住「guard 的硬拦集合没变」。
 */
test("危险命令表单一事实源：guard 与审批规则同源且无漂移", () => {
  const approval = builtinApprovalRules();
  for (const spec of shellApprovalRuleSpecs()) {
    assert.ok(
      approval.some((rule) => rule.id === spec.id),
      `审批内置规则缺少 ${spec.id}（guard 与审批已漂移）`,
    );
  }
  // 这两条是原先的漂移点：只在审批表里，guard 表没有。
  assert.ok(shellApprovalRuleSpecs().some((s) => s.id === "builtin:bash.git-destructive"));
  assert.ok(shellApprovalRuleSpecs().some((s) => s.id === "builtin:bash.chmod-recursive"));

  // 行为保持不变：guard 仍只硬拦原来那 6 条；破坏性 git / 递归 chmod 交给审批（ask）。
  const guarded = DANGEROUS_SHELL_RULES.filter((rule) => rule.guardBlocks)
    .map((rule) => rule.id)
    .sort();
  assert.deepEqual(guarded, [
    "dd",
    "fork-bomb",
    "mkfs",
    "rm-rf",
    "shutdown",
    "windows-destructive",
  ]);
  assert.equal(findDangerousBash("git reset --hard"), undefined);
  assert.equal(findDangerousBash("chmod -R 777 /srv"), undefined);
});

/**
 * 回归：路径校验曾不解析符号链接。
 *
 * 字面路径在 cwd 内不等于真实路径在 cwd 内——链接正是把两者分开的机制。
 * `FileService` 与 `exec` 都做了 realpath 校验，guard 不做得话三层保护强度不一致。
 */
test("路径校验解析符号链接：指向 cwd 外的链接判为越界", (t) => {
  const root = mkdtempSync(join(tmpdir(), "guard-root-"));
  const outside = mkdtempSync(join(tmpdir(), "guard-out-"));
  try {
    const link = join(root, "escape");
    try {
      symlinkSync(outside, link, "dir");
    } catch {
      t.skip("当前平台无法创建符号链接");
      return;
    }
    assert.equal(isPathInsideCwd(link, root), false, "链接指向 cwd 外必须判越界");
    assert.equal(isPathInsideCwd(join(root, "nested", "new.txt"), root), true, "cwd 内的新文件放行");
    assert.equal(isPathInsideCwd(outside, root), false, "绝对路径在 cwd 外仍被拦");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
