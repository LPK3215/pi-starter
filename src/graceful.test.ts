/**
 * 优雅停机的测试。
 *
 * 为什么值得单独测：这条链路负责回收审批闸门、WS 连接、会话、扩展与 MCP 子进程，
 * 而 E2E 全程用 SIGKILL，**直接绕过它**。没被跑过的清理代码等于没有清理。
 *
 * 另外 Windows 上 Node **不投递可捕获的 SIGTERM**（`child.kill("SIGTERM")` 是硬杀，
 * 实测退出码为 null、handler 从不运行），所以真信号路径只能在 POSIX 上测；这里用替身
 * 覆盖编排逻辑本身，任何平台都跑得到。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGracefulShutdown, type ShutdownStep } from "./graceful.js";

/** 收集日志与退出调用的替身。 */
function harness(steps: ShutdownStep[], closeServer: () => Promise<void>, bailMs = 1000) {
  const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const exits: number[] = [];
  const shutdown = createGracefulShutdown({
    steps,
    closeServer,
    bailMs,
    logger: {
      info: (msg, fields) => logs.push({ level: "info", msg, fields }),
      warn: (msg, fields) => logs.push({ level: "warn", msg, fields }),
    },
    exit: (code) => exits.push(code),
  });
  return { shutdown, logs, exits };
}

test("停机：按声明顺序执行步骤，最后关闭 listener 并退出 0", async () => {
  const order: string[] = [];
  const { shutdown, logs, exits } = harness(
    [
      { name: "a", run: () => { order.push("a"); } },
      { name: "b", run: async () => { order.push("b"); } },
      { name: "c", run: () => { order.push("c"); } },
    ],
    async () => { order.push("close"); },
  );

  await shutdown();

  assert.deepEqual(order, ["a", "b", "c", "close"], "拆解必须按声明顺序，且 close 在最后");
  assert.deepEqual(exits, [0]);
  assert.ok(logs.some((l) => l.msg === "开始优雅停机"));
  assert.ok(logs.some((l) => l.msg === "已停机"));
});

test("停机：某一步抛错**不会**阻断其余步骤，也不会阻断退出（曾是真 bug）", async () => {
  // 原先的写法把兜底定时器与 server.close 放在所有步骤**之后**：任何一步抛错，
  // shutdown() 就 reject（信号处理器是 `void shutdown()`，成了未捕获拒绝），
  // 兜底没建、server.close 没调，进程永久挂死。
  const order: string[] = [];
  const { shutdown, logs, exits } = harness(
    [
      { name: "boom", run: () => { order.push("boom"); throw new Error("闸门拆解失败"); } },
      { name: "after-sync", run: () => { order.push("after-sync"); } },
      { name: "boom-async", run: async () => { order.push("boom-async"); throw new Error("WS close 拒绝"); } },
      { name: "after-async", run: () => { order.push("after-async"); } },
    ],
    async () => { order.push("close"); },
  );

  await shutdown();

  assert.deepEqual(
    order,
    ["boom", "after-sync", "boom-async", "after-async", "close"],
    "同步抛错与异步拒绝都不能跳过后续步骤",
  );
  assert.deepEqual(exits, [0], "无论如何都要退出——否则编排器只能 SIGKILL");
  const warns = logs.filter((l) => l.level === "warn");
  assert.equal(warns.length, 2, "两个失败各记一条，不吞掉");
  assert.ok(warns.some((w) => w.fields?.step === "boom" && String(w.fields.error).includes("闸门拆解失败")));
  assert.ok(warns.some((w) => w.fields?.step === "boom-async"));
});

test("停机：幂等——重复调用（SIGINT 紧跟 SIGTERM）只生效一次", async () => {
  let closed = 0;
  const run: string[] = [];
  const { shutdown, exits } = harness([{ name: "only", run: () => { run.push("x"); } }], async () => { closed += 1; });

  const first = shutdown();
  const second = shutdown();
  await Promise.all([first, second]);

  assert.equal(run.length, 1, "步骤不能跑两遍（有副作用）");
  assert.equal(closed, 1, "listener 不能关两次");
  assert.deepEqual(exits, [0]);
});

test("停机：listener 关不掉时，兜底超时强退（不会挂死）", async () => {
  // 有 socket 拒绝关闭时 server.close 永不回调——必须有兜底。
  const { shutdown, logs, exits } = harness([], () => new Promise<void>(() => {}), 40);

  await shutdown();

  assert.deepEqual(exits, [0], "兜底必须退出");
  assert.ok(
    logs.some((l) => l.level === "warn" && l.msg.includes("超时")),
    "且要留下「为什么是强退」的痕迹",
  );
});

test("停机：正常关掉时不走兜底（否则只是被超时掩盖）", async () => {
  const { shutdown, logs } = harness([], async () => {});

  await shutdown();
  // 让兜底定时器有机会触发，若它被正确清除就不会有任何输出
  await new Promise((r) => setTimeout(r, 60));

  assert.ok(!logs.some((l) => l.msg.includes("超时")), "正常关闭不该留下超时日志");
  assert.ok(logs.some((l) => l.msg === "已停机"));
});

test("停机：关闭 listener 本身失败也要退出，且清理兜底定时器", async () => {
  const { shutdown, logs, exits } = harness([], async () => {
    throw new Error("listen handle 已损坏");
  }, 40);

  await shutdown();
  await new Promise((r) => setTimeout(r, 60));

  assert.deepEqual(exits, [0]);
  assert.ok(logs.some((l) => l.level === "warn" && String(l.fields?.error).includes("listen handle 已损坏")));
  assert.ok(!logs.some((l) => l.msg.includes("超时")), "失败路径也要清掉兜底，避免二次退出");
});
