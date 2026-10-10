/**
 * 进程执行的行为测试。
 *
 * 断言打在真实子进程上：退出码、输出、超时、后台停止、工作区逃逸。
 * 不连模型。平台建不出目录链接时显式 skip，不把「没跑」当成通过。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { builtinApprovalRules, evaluateRules } from "../approval/rules.js";
import { dangerousShellCommand } from "../extensions/guard.js";
import { isPathInsideCwd } from "../extensions/guard.js";
import { allTools } from "../tools/index.js";
import { execToolsForMode } from "../tools/exec.js";
import { inferCapabilities } from "../tools/registry.js";
import { waitFor } from "../test-server.js";
import {
  ExecEnvironment,
  ExecError,
  MAX_COMMAND_CHARS,
  MAX_JOBS,
  MAX_OUTPUT_BYTES,
} from "./runner.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "pi-exec-"));
}

function remove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 子进程刚退出时目录可能仍被占用，留给系统临时目录即可 */
  }
}

/** 生成一条当前平台 shell 能跑起来的 node -e。脚本里不要出现双引号。 */
function nodeEval(source: string): string {
  if (source.includes('"')) throw new Error("测试脚本不能含双引号");
  const exe = process.execPath;
  if (process.platform === "win32") return `"${exe}" -e "${source}"`;
  const quoted = `'${exe.replace(/'/g, `'\\''`)}'`;
  return `${quoted} -e ${JSON.stringify(source)}`;
}

function linkDir(root: string, outside: string): string | null {
  const attempts: Array<[string, "junction" | "dir"]> = [
    ["escape-dir", "junction"],
    ["escape-dir", "dir"],
  ];
  for (const [name, type] of attempts) {
    try {
      symlinkSync(outside, join(root, name), type);
      return name;
    } catch {
      /* 试下一种 */
    }
  }
  return null;
}

test("前台执行拿得到 stdout、stderr 和退出码", async () => {
  const root = workspace();
  const env = new ExecEnvironment({ workspace: root });
  try {
    const out = await env.run({ command: nodeEval("process.stdout.write('hello-exec')") });
    assert.equal(out.status, "exited");
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "hello-exec");
    assert.equal(out.timedOut, false);

    const err = await env.run({ command: nodeEval("process.stderr.write('boom')") });
    assert.equal(err.stderr, "boom");
    assert.equal(err.exitCode, 0);

    const code = await env.run({ command: nodeEval("process.exit(7)") });
    assert.equal(code.exitCode, 7);
    assert.equal(code.status, "exited");
  } finally {
    env.dispose();
    remove(root);
  }
});

test("子进程的 cwd 是工作区内的真实目录", async () => {
  const root = workspace();
  mkdirSync(join(root, "sub"));
  const env = new ExecEnvironment({ workspace: root });
  try {
    const view = await env.run({
      command: nodeEval("process.stdout.write(process.cwd())"),
      cwd: "sub",
    });
    assert.equal(view.exitCode, 0);
    assert.equal(realpathSync(view.stdout.trim()), realpathSync(join(root, "sub")));
  } finally {
    env.dispose();
    remove(root);
  }
});

test("多字节输出被分块边界切开时不该出现替换字符（U+FFFD）", async () => {
  const root = workspace();
  const env = new ExecEnvironment({ workspace: root });
  try {
    // 确定性复现：把 9000 字节的中文按 4096 字节切开分两次写。
    // 4096 不是 3 的倍数，所以第一次写的末尾正好是一个汉字的中间 —— 两个 chunk 各自
    // 单独 `toString("utf8")` 就会各吐一个 U+FFFD，而原文字符其实一个都没丢。
    const view = await env.run({
      command: nodeEval(
        "const b=Buffer.from('中'.repeat(3000));" +
          "process.stdout.write(b.subarray(0,4096));" +
          "setTimeout(()=>process.stdout.write(b.subarray(4096)),50)",
      ),
    });
    assert.equal(view.exitCode, 0);
    assert.equal(view.truncated, false, "9000 字节没到 64KB 上限，不该被截断");
    assert.equal(view.stdout.includes("\uFFFD"), false, "分块边界不该解码出替换字符");
    assert.equal(view.stdout, "中".repeat(3000), "字符必须逐字完整");
  } finally {
    env.dispose();
    remove(root);
  }
});

test("子进程不继承模型密钥，但保留其余环境（PATH 等）", async () => {
  const root = workspace();
  const env = new ExecEnvironment({ workspace: root });
  const names = ["PI_API_KEY", "PI_API_KEY_ZHIPU"] as const;
  const restore = names.map((name) => [name, process.env[name]] as const);
  process.env.PI_API_KEY = "sk-should-not-leak";
  process.env.PI_API_KEY_ZHIPU = "sk-also-should-not-leak";
  try {
    const view = await env.run({
      command: nodeEval(
        "process.stdout.write(JSON.stringify([process.env.PI_API_KEY ?? null, process.env.PI_API_KEY_ZHIPU ?? null, process.env.PATH ? 'has-path' : 'no-path']))",
      ),
    });
    assert.equal(view.exitCode, 0);
    const [key, zhipu, pathVar] = JSON.parse(view.stdout) as [string | null, string | null, string];
    assert.equal(key, null, "PI_API_KEY 不该进子进程（Linux/macOS 的 /bin/sh 主路径同样如此）");
    assert.equal(zhipu, null, "PI_API_KEY_<PROVIDER> 同样不该进子进程");
    assert.equal(pathVar, "has-path", "其余环境变量必须保留，否则 shell 与外部工具跑不起来");
  } finally {
    for (const [name, value] of restore) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    env.dispose();
    remove(root);
  }
});

test("空命令、超长命令、越界 cwd、不存在的 cwd 都不会启动任务", async () => {
  const root = workspace();
  const outside = workspace();
  writeFileSync(join(root, "note.txt"), "x");
  const env = new ExecEnvironment({ workspace: root });
  try {
    const cases: Array<{ command: string; cwd?: string; code: string }> = [
      { command: "   ", code: "empty_command" },
      { command: "echo\nok", code: "bad_command" },
      { command: "x".repeat(MAX_COMMAND_CHARS + 1), code: "command_too_long" },
      { command: nodeEval("process.exit(0)"), cwd: "..", code: "outside_workspace" },
      { command: nodeEval("process.exit(0)"), cwd: outside, code: "outside_workspace" },
      { command: nodeEval("process.exit(0)"), cwd: "missing", code: "cwd_unresolved" },
      { command: nodeEval("process.exit(0)"), cwd: "note.txt", code: "cwd_not_dir" },
    ];
    for (const item of cases) {
      await assert.rejects(
        () => env.run({ command: item.command, cwd: item.cwd }),
        (err: unknown) => {
          assert.ok(err instanceof ExecError, `expected ExecError for ${item.code}`);
          assert.equal(err.code, item.code);
          return true;
        },
      );
    }
    assert.equal(env.list().length, 0);
  } finally {
    env.dispose();
    remove(root);
    remove(outside);
  }
});

test("经目录链接越出工作区的 cwd 被拒绝", async (t) => {
  const root = workspace();
  const outside = workspace();
  const name = linkDir(root, outside);
  if (!name) {
    t.skip("当前平台无法创建目录链接（junction / symlink 都失败）");
    remove(root);
    remove(outside);
    return;
  }
  const linked = realpathSync(join(root, name));
  assert.equal(
    isPathInsideCwd(linked, realpathSync(root)),
    false,
    "前提：这个链接确实指向工作区外面，否则后面的拒绝说明不了什么",
  );
  const env = new ExecEnvironment({ workspace: root });
  try {
    await assert.rejects(
      () => env.run({ command: nodeEval("process.stdout.write('escaped')"), cwd: name }),
      (err: unknown) => {
        assert.ok(err instanceof ExecError);
        assert.equal(err.code, "outside_workspace");
        return true;
      },
    );
    assert.equal(env.list().length, 0);
  } finally {
    env.dispose();
    remove(root);
    remove(outside);
  }
});

test("超时会结束进程并标记 timed_out", async () => {
  const root = workspace();
  const env = new ExecEnvironment({ workspace: root });
  try {
    const view = await env.run({
      command: nodeEval("setTimeout(function(){}, 30000)"),
      timeoutMs: 500,
    });
    assert.equal(view.timedOut, true);
    assert.equal(view.status, "timed_out");
  } finally {
    env.dispose();
    remove(root);
  }
});

test("后台任务可列出、可停止，dispose 会清掉仍在跑的", async () => {
  const root = workspace();
  const env = new ExecEnvironment({ workspace: root });
  try {
    const started = await env.run({
      command: nodeEval("setTimeout(function(){}, 30000)"),
      background: true,
      timeoutMs: 30_000,
    });
    assert.equal(started.status, "running");
    assert.equal(started.background, true);
    assert.ok(env.list().some((job) => job.id === started.id && job.status === "running"));

    const stopped = await env.stop(started.id);
    assert.notEqual(stopped.status, "running");

    const again = await env.run({
      command: nodeEval("setTimeout(function(){}, 30000)"),
      background: true,
      timeoutMs: 30_000,
    });
    env.dispose();
    await waitFor(() => env.get(again.id)?.status !== "running", "dispose 后后台任务结束");
    await assert.rejects(() => env.run({ command: nodeEval("process.exit(0)") }), (err: unknown) => {
      assert.ok(err instanceof ExecError);
      assert.equal(err.code, "disposed");
      return true;
    });
  } finally {
    env.dispose();
    remove(root);
  }
});

test("同时运行的任务有上限", async () => {
  const root = workspace();
  const env = new ExecEnvironment({ workspace: root });
  try {
    const ids: string[] = [];
    for (let i = 0; i < MAX_JOBS; i += 1) {
      const view = await env.run({
        command: nodeEval("setTimeout(function(){}, 30000)"),
        background: true,
        timeoutMs: 30_000,
      });
      ids.push(view.id);
    }
    await assert.rejects(() => env.run({ command: nodeEval("process.exit(0)") }), (err: unknown) => {
      assert.ok(err instanceof ExecError);
      assert.equal(err.code, "too_many_jobs");
      return true;
    });
    assert.equal(ids.length, MAX_JOBS);
  } finally {
    env.dispose();
    remove(root);
  }
});

test("超出字节上限的输出被截断，并告诉调用方", async () => {
  const root = workspace();
  const env = new ExecEnvironment({ workspace: root });
  try {
    const view = await env.run({
      command: nodeEval(`process.stdout.write('y'.repeat(${MAX_OUTPUT_BYTES + 50}))`),
    });
    assert.equal(view.truncated, true);
    assert.equal(view.exitCode, 0);
    assert.equal(view.stdout.length, MAX_OUTPUT_BYTES);
    assert.ok(view.stdout.startsWith("yyy"));
  } finally {
    env.dispose();
    remove(root);
  }
});

test("AbortSignal 会杀掉正在跑的进程", async () => {
  const root = workspace();
  const env = new ExecEnvironment({ workspace: root });
  try {
    const ac = new AbortController();
    const pending = env.run({
      command: nodeEval("setTimeout(function(){}, 30000)"),
      timeoutMs: 30_000,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 80);
    const view = await pending;
    assert.equal(view.status, "killed");
  } finally {
    env.dispose();
    remove(root);
  }
});

test("exec 工具能跑通，且不在默认 allTools 里", async () => {
  assert.equal(allTools.some((tool) => tool.name === "exec" || tool.name === "exec_jobs" || tool.name === "exec_stop"), false);
  assert.equal(execToolsForMode("off", new ExecEnvironment({ workspace: process.cwd() })).length, 0);
  assert.equal(execToolsForMode("readonly", new ExecEnvironment({ workspace: process.cwd() })).length, 0);

  const root = workspace();
  const env = new ExecEnvironment({ workspace: root });
  try {
    const tools = execToolsForMode("coding", env);
    assert.deepEqual(tools.map((tool) => tool.name), ["exec", "exec_jobs", "exec_stop"]);
    const exec = tools[0];
    assert.ok(exec);
    const result = await exec.execute(
      "call-1",
      { command: nodeEval("process.stdout.write('from-tool')") },
      undefined,
      undefined,
      undefined as never,
    );
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    assert.match(text, /from-tool/);
    assert.equal((result.details as { ok?: boolean }).ok, true);

    const jobs = tools[1];
    assert.ok(jobs);
    const listed = await jobs.execute("call-2", {}, undefined, undefined, undefined as never);
    const listedText = listed.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    assert.match(listedText, /ex-1/);
  } finally {
    env.dispose();
    remove(root);
  }
});

test("exec 与 bash 走同一套内置高危规则，guard 也认 exec", () => {
  const rules = builtinApprovalRules();
  const denied = evaluateRules(rules, {
    toolName: "exec",
    args: { command: "mkfs.ext4 /dev/sda1" },
    cwd: process.cwd(),
  });
  assert.equal(denied?.action, "deny");
  const asked = evaluateRules(rules, {
    toolName: "exec",
    args: { command: "rm -rf /tmp/x" },
    cwd: process.cwd(),
  });
  assert.equal(asked?.action, "ask");
  assert.equal(
    evaluateRules(rules, {
      toolName: "exec",
      args: { command: "node -v" },
      cwd: process.cwd(),
    }),
    null,
  );
  assert.equal(dangerousShellCommand("exec", { command: "dd if=/dev/zero of=/dev/sda" })?.id, "dd");
  assert.equal(dangerousShellCommand("exec", { command: "echo hi" }), undefined);
  assert.equal(dangerousShellCommand("exec_jobs", { command: "mkfs" }), undefined);
});

test("exec 的能力标签是 shell，观察任务不是", () => {
  assert.deepEqual(inferCapabilities("exec"), ["shell"]);
  assert.deepEqual(inferCapabilities("exec_stop"), ["shell"]);
  assert.deepEqual(inferCapabilities("exec_jobs"), ["shell.observe"]);
});

test("执行工具接在组装层和 Web 注册表上，不是只声明了工厂", () => {
  const agentSrc = readFileSync(fileURLToPath(new URL("../agent.ts", import.meta.url)), "utf8");
  const serverSrc = readFileSync(fileURLToPath(new URL("../server.ts", import.meta.url)), "utf8");
  assert.match(agentSrc, /execToolsForMode\(cfg\.builtinTools, execEnv\)/);
  assert.match(agentSrc, /execEnv\?\.dispose\(\)/);
  assert.match(serverSrc, /execRegistrySpecs\(\)/);
});
