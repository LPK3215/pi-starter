/**
 * 进程执行工具层（`createExecTools`）测试。
 *
 * `src/exec/runner.ts` 有测试，但**工具层没有任何测试** —— 也就是「参数怎么翻译成 runner 调用」
 * 与「结果怎么呈现给模型」这两段从未被执行过。这两段恰好是模型直接看到的部分：
 * 退出码非零有没有被标成错误、输出被截断有没有说出来、超时秒数非法会不会先炸在参数上。
 *
 * 全程用假 `ExecEnvironment`，不真的起进程。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EXEC_TOOL_NAMES, createExecTools, execRegistrySpecs, execToolsForMode } from "./exec.js";
import { ExecError, MAX_TIMEOUT_MS, type ExecEnvironment, type ExecJobView } from "../exec/runner.js";
import { inferRisk } from "./registry.js";

function fakeView(over: Partial<ExecJobView> = {}): ExecJobView {
  return {
    id: "job-1",
    command: "echo hi",
    cwd: "/workspace",
    status: "exited",
    exitCode: 0,
    stdout: "hi\n",
    stderr: "",
    truncated: false,
    timedOut: false,
    background: false,
    ...over,
  } as ExecJobView;
}

interface Recorder {
  env: ExecEnvironment;
  runs: Array<Record<string, unknown>>;
  stopped: string[];
}

function fakeEnv(options: {
  run?: (args: Record<string, unknown>) => Promise<ExecJobView> | ExecJobView;
  list?: () => ExecJobView[];
  get?: (id: string) => ExecJobView | undefined;
  stop?: (id: string) => Promise<ExecJobView> | ExecJobView;
} = {}): Recorder {
  const runs: Array<Record<string, unknown>> = [];
  const stopped: string[] = [];
  const env = {
    async run(args: Record<string, unknown>) {
      runs.push(args);
      if (options.run) return options.run(args);
      return fakeView({ command: String(args.command), cwd: String(args.cwd ?? "/workspace") });
    },
    list: () => options.list?.() ?? [],
    get: (id: string) => options.get?.(id),
    async stop(id: string) {
      stopped.push(id);
      if (options.stop) return options.stop(id);
      return fakeView({ id, status: "killed", exitCode: null });
    },
    dispose: () => {},
  } as unknown as ExecEnvironment;
  return { env, runs, stopped };
}

/** 取工具并按名字调用。 */
function toolByName(env: ExecEnvironment, name: string) {
  const tool = createExecTools(env).find((candidate) => candidate.name === name);
  assert.ok(tool, `找不到工具 ${name}`);
  return tool as unknown as {
    execute: (
      id: string,
      params: unknown,
      signal: AbortSignal | undefined,
      update: undefined,
      ctx: never,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown>; isError?: boolean }>;
  };
}

async function run(env: ExecEnvironment, name: string, params: unknown, signal?: AbortSignal) {
  const result = await toolByName(env, name).execute("call-1", params, signal, undefined, undefined as never);
  return {
    text: result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join(""),
    details: result.details,
    isError: result.isError === true,
  };
}

/* ────────────────────── 档位与登记 ────────────────────── */

test("只有 coding 档且给了环境才装配执行工具；其余档一律空", () => {
  const { env } = fakeEnv();
  assert.deepEqual(execToolsForMode("coding", env).map((tool) => tool.name), [...EXEC_TOOL_NAMES]);
  assert.deepEqual(execToolsForMode("off", env), []);
  assert.deepEqual(execToolsForMode("readonly", env), []);
  // 没给环境也不能凭空造出一个能跑 shell 的工具。
  assert.deepEqual(execToolsForMode("coding", undefined), []);
});

test("登记元数据：exec_jobs 的能力是 shell.observe（按名字推断会推错）", () => {
  const specs = execRegistrySpecs();
  assert.deepEqual(specs.map((spec) => spec.name), [...EXEC_TOOL_NAMES]);
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  assert.deepEqual(byName.get("exec")?.capabilities, ["shell"]);
  assert.deepEqual(byName.get("exec_stop")?.capabilities, ["shell"]);
  assert.deepEqual(byName.get("exec_jobs")?.capabilities, ["shell.observe"]);
  assert.equal(byName.get("exec_jobs")?.risk, "low", "只看不改的任务不该被判成高危");
  assert.equal(inferRisk(byName.get("exec")!.capabilities), "high");
  for (const spec of specs) assert.equal(spec.source, "custom");
});

/* ────────────────────── exec ────────────────────── */

test("exec：成功时把 stdout / stderr / 退出码都给模型，且不算错误", async () => {
  const { env, runs } = fakeEnv({ run: () => fakeView({ stdout: "out\n", stderr: "err\n", exitCode: 0 }) });
  const res = await run(env, "exec", { command: "echo hi" });
  assert.match(res.text, /status: exited/);
  assert.match(res.text, /exit: 0/);
  // stdout / stderr 各自自带结尾换行，所以段之间会有一个空行 —— 这是刻意的分段，不是多出来的。
  assert.match(res.text, /--- stdout ---\nout\n\n--- stderr ---\nerr\n$/);
  assert.equal(res.details.ok, true);
  assert.equal(res.isError, false, "exit 0 不该被标成错误");
  assert.equal(runs[0]?.command, "echo hi");
  assert.equal(runs[0]?.background, false, "缺省是前台");
});

test("exec：非零退出 / 超时都标成错误，让模型知道要处理", async () => {
  const failed = await run(fakeEnv({ run: () => fakeView({ exitCode: 1 }) }).env, "exec", { command: "false" });
  assert.equal(failed.details.ok, false);
  assert.equal(failed.isError, true, "非零退出必须标成错误，否则模型会以为成功了");

  const timedOut = await run(fakeEnv({ run: () => fakeView({ timedOut: true, exitCode: null }) }).env, "exec", {
    command: "sleep 99",
  });
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.text, /timed_out: true/);
});

test("exec：后台任务立即返回 id，并告诉模型下一步用什么工具", async () => {
  const { env, runs } = fakeEnv({
    run: () => fakeView({ background: true, status: "running", exitCode: null }),
  });
  const res = await run(env, "exec", { command: "npm run dev", background: true });
  assert.equal(runs[0]?.background, true);
  assert.equal(res.details.background, true);
  assert.equal(res.details.ok, true, "后台已启动不算失败");
  assert.equal(res.isError, false);
  assert.match(res.text, /exec_jobs/);
  assert.match(res.text, /exec_stop/);
});

test("exec：输出被截断时必须说出来，否则模型会以为就这么多", async () => {
  const { env } = fakeEnv({ run: () => fakeView({ truncated: true, stdout: "前段" }) });
  const res = await run(env, "exec", { command: "cat big" });
  assert.match(res.text, /truncated: true（输出超过上限，只保留前段）/);
  assert.equal(res.details.truncated, true);
});

test("exec：非法 timeout_seconds 在**调用 runner 之前**就被拦下", async () => {
  for (const bad of [0, -1, Number.NaN, MAX_TIMEOUT_MS / 1000 + 1]) {
    const { env, runs } = fakeEnv();
    const res = await run(env, "exec", { command: "echo hi", timeout_seconds: bad });
    assert.equal(res.isError, true, `timeout_seconds=${bad} 应被拒`);
    assert.match(res.text, /timeout_seconds/);
    assert.equal(runs.length, 0, "参数非法时绝不能真的起进程");
  }
  // 合法值换算成毫秒并透传。
  const { env, runs } = fakeEnv();
  await run(env, "exec", { command: "echo hi", timeout_seconds: 2.5 });
  assert.equal(runs[0]?.timeoutMs, 2500);
});

test("exec：runner 抛错时翻成可读文本并标成错误，不把异常冒出去", async () => {
  const { env } = fakeEnv({
    run: () => {
      throw new ExecError("工作目录必须留在工作区内", "bad_cwd");
    },
  });
  const res = await run(env, "exec", { command: "ls", cwd: "../.." });
  assert.equal(res.isError, true);
  assert.match(res.text, /工作目录必须留在工作区内/);
  assert.equal(res.details.ok, false);
});

test("exec：AbortSignal 原样透传给 runner（否则本轮中断停不下子进程）", async () => {
  const controller = new AbortController();
  const { env, runs } = fakeEnv();
  await run(env, "exec", { command: "sleep 10" }, controller.signal);
  assert.equal(runs[0]?.signal, controller.signal);
});

/* ────────────────────── exec_jobs ────────────────────── */

test("exec_jobs：无任务时如实说没有；有任务时每行给 id / 状态 / 退出码", async () => {
  const empty = await run(fakeEnv({ list: () => [] }).env, "exec_jobs", {});
  assert.match(empty.text, /当前没有执行任务/);
  assert.deepEqual(empty.details.jobs, []);

  const long = "a".repeat(200);
  const { env } = fakeEnv({
    list: () => [fakeView({ id: "job-1", command: "echo hi" }), fakeView({ id: "job-2", command: long, exitCode: null, status: "running" })],
  });
  const res = await run(env, "exec_jobs", {});
  assert.deepEqual(res.details.jobs, ["job-1", "job-2"]);
  assert.match(res.text, /job-1 {2}exited {2}exit=0 {2}echo hi/);
  assert.match(res.text, /job-2 {2}running {2}exit=-/, "还在跑的任务退出码用 - 表示，不是 0");
  assert.ok(res.text.includes("aaa..."), "超长命令要截断，别把整行撑爆");
  assert.ok(!res.text.includes(long), "不该原样带出 200 字符的命令");
});

test("exec_jobs：传 id 时返回该任务的输出；不存在的 id 明确报错", async () => {
  const { env } = fakeEnv({ get: (id) => (id === "job-1" ? fakeView({ stdout: "hello\n" }) : undefined) });
  const hit = await run(env, "exec_jobs", { id: " job-1 " });
  assert.match(hit.text, /hello/);
  assert.equal(hit.isError, false);

  const miss = await run(env, "exec_jobs", { id: "nope" });
  assert.equal(miss.isError, true);
  assert.match(miss.text, /没有这个任务：nope/);
});

/* ────────────────────── exec_stop ────────────────────── */

test("exec_stop：请求停止并回状态；被 kill 的退出码是 null 且算失败", async () => {
  const { env, stopped } = fakeEnv();
  const res = await run(env, "exec_stop", { id: " job-1 " });
  assert.deepEqual(stopped, ["job-1"], "id 要去掉首尾空白再传");
  assert.match(res.text, /已请求停止/);
  assert.match(res.text, /status: killed/);
  assert.match(res.text, /exit: null/);
  assert.equal(res.isError, true, "被杀掉的任务不该被当成成功完成");
});

test("exec_stop：runner 拒绝时翻成可读文本", async () => {
  const { env } = fakeEnv({
    stop: () => {
      throw new ExecError("没有这个任务：nope", "not_found");
    },
  });
  const res = await run(env, "exec_stop", { id: "nope" });
  assert.equal(res.isError, true);
  assert.match(res.text, /没有这个任务：nope/);
});
