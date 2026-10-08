/**
 * 工具执行看门狗的回归测试。
 *
 * 这是**真实计时**的测试：看门狗的全部价值就是「超时后一定会触发」，
 * 而这恰恰是 `unref()` 会悄悄破坏的性质（见 ApprovalGate 里踩过的同一个坑）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolWatchdog, DEFAULT_TOOL_TIMEOUT_MS } from "./watchdog.js";

/** 等 n 毫秒（真实计时）。 */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("挂死的工具在超时后被中止", async () => {
  let aborted = 0;
  const wd = new ToolWatchdog({ timeoutMs: 60, abort: () => { aborted += 1; } });
  wd.arm("t1", "bash");
  await wait(30);
  assert.equal(aborted, 0, "must not abort before the timeout");
  await wait(90);
  assert.equal(aborted, 1, "must abort once the tool overruns");
  assert.equal(wd.timeouts, 1);
  assert.equal(wd.pendingCount, 0, "fired timer must be cleaned up");
  wd.dispose();
});

test("正常结束的工具不会被误杀", async () => {
  let aborted = 0;
  const wd = new ToolWatchdog({ timeoutMs: 60, abort: () => { aborted += 1; } });
  wd.arm("t1", "bash");
  wd.disarm("t1");
  await wait(120);
  assert.equal(aborted, 0, "a disarmed call must never be aborted");
  wd.dispose();
});

test("等待人类的工具被豁免，不会被看门狗杀掉", async () => {
  const killed: string[] = [];
  const wd = new ToolWatchdog({
    timeoutMs: 60,
    abort: () => {},
    exempt: (name) => name === "ask_user_question",
    onTimeout: (tool, id) => killed.push(`${id}/${tool}`),
  });
  wd.arm("t1", "bash");
  wd.arm("t2", "ask_user_question");
  wd.arm("t3", "read");
  await wait(130);
  assert.deepEqual(killed.sort(), ["t1/bash", "t3/read"], "exempt tool must be skipped");
  wd.dispose();
});

test("豁免的工具不计入 pending（否则会虚报占用）", () => {
  const wd = new ToolWatchdog({ timeoutMs: 1000, abort: () => {}, exempt: () => true });
  wd.arm("t1", "ask_user_question");
  assert.equal(wd.pendingCount, 0);
  wd.dispose();
});

test("重复 arm 同一 id 会重置计时，不会累积多个定时器", async () => {
  let aborted = 0;
  const wd = new ToolWatchdog({ timeoutMs: 100, abort: () => { aborted += 1; } });
  wd.arm("t1", "bash");
  await wait(60);
  wd.arm("t1", "bash"); // 续期
  await wait(60);
  assert.equal(aborted, 0, "re-arm must restart the clock");
  await wait(80);
  assert.equal(aborted, 1, "only the latest timer may fire");
  wd.dispose();
});

test("dispose 后拒绝新 arm 并清空在途定时器", async () => {
  let aborted = 0;
  const wd = new ToolWatchdog({ timeoutMs: 50, abort: () => { aborted += 1; } });
  wd.arm("t1", "bash");
  wd.dispose();
  wd.arm("t2", "bash");
  assert.equal(wd.pendingCount, 0);
  await wait(120);
  assert.equal(aborted, 0, "dispose must prevent any further aborts");
});

test("elapsed 报告在途耗时，未跟踪时返回 undefined", async () => {
  const wd = new ToolWatchdog({ timeoutMs: 1000, abort: () => {} });
  assert.equal(wd.elapsed("nope"), undefined);
  wd.arm("t1", "bash");
  await wait(40);
  const elapsed = wd.elapsed("t1");
  assert.ok(elapsed !== undefined && elapsed >= 30, `elapsed should be >= 30, got ${elapsed}`);
  wd.dispose();
});

test("非法超时回落默认值，绝不立即中止", () => {
  // A zero/negative timeout would abort instantly — far worse than no watchdog at all.
  const wd = new ToolWatchdog({ timeoutMs: 0, abort: () => {} });
  wd.arm("t1", "bash");
  assert.equal(wd.pendingCount, 1, "must still arm with the default timeout");
  wd.dispose();
  assert.ok(DEFAULT_TOOL_TIMEOUT_MS > 60_000, "default must leave room for slow tools");
});

test("在途 id 数量有上限，异常调用方不会撑爆内存", () => {
  const wd = new ToolWatchdog({ timeoutMs: 60_000, abort: () => {} });
  for (let i = 0; i < 600; i += 1) wd.arm(`tool-${i}`, "bash");
  assert.ok(wd.pendingCount <= 512, `pending must stay bounded, got ${wd.pendingCount}`);
  wd.dispose();
});
