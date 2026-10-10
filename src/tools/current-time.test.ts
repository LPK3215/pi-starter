/**
 * `current_time` 测试。
 *
 * 别看它最小，它的 `execute` 此前**从未被执行过**（覆盖率 70.59%，函数覆盖 0%）——
 * 而它的时区参数是模型直接填的。模型写时区最常见的两种写法 `UTC+8` / `GMT+8`
 * 在 Node 里都是 `RangeError`：不处理就会让这个「查现在几点」的工具直接抛异常收场。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { currentTimeTool } from "./current-time.js";

async function run(params: unknown): Promise<{ text: string; details: Record<string, unknown> }> {
  const result = await (
    currentTimeTool.execute as unknown as (
      id: string,
      params: unknown,
      signal: undefined,
      update: undefined,
      ctx: never,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>
  )("call-1", params, undefined, undefined, undefined as never);
  return {
    text: result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join(""),
    details: result.details,
  };
}

test("不传时区时回本地时间，并标明是本地时区", async () => {
  const res = await run({});
  assert.match(res.text, /^当前时间：.+/);
  assert.match(res.text, /（本地时区）$/);
});

test("合法 IANA 时区：回时间并回显时区名", async () => {
  const res = await run({ timezone: "Asia/Shanghai" });
  assert.match(res.text, /^当前时间：.+/);
  assert.match(res.text, /（Asia\/Shanghai）$/);

  // 关键性质：两个不同时区算出的**绝对时刻**一致，只是显示不同。
  // 这里退一步只断言两者都能给出结果（同一秒内字符串可能相同，不能拿来比较）。
  const utc = await run({ timezone: "UTC" });
  assert.match(utc.text, /（UTC）$/);
});

test("模型常写的 UTC+8 / GMT+8 不再抛异常，而是给出可用写法", async () => {
  for (const timezone of ["UTC+8", "GMT+8", "CST+8", "随便写的"]) {
    const res = await run({ timezone });
    assert.match(res.text, /无法识别的时区/, `${timezone} 应被如实拒绝而不是抛异常`);
    assert.ok(res.text.includes(timezone), "要回显模型给的那个值，它才知道自己写错了");
    assert.match(res.text, /IANA/);
    assert.match(res.text, /Etc\/GMT-8/, "给出「东八区该怎么写」这个最可能的替代写法");
    assert.equal(res.details.ok, false);
  }
});

test("失败的时区约定：details.ok=false，不会让调用方以为拿到了时间", async () => {
  const res = await run({ timezone: "Mars/Phobos" });
  assert.equal(res.details.ok, false);
  assert.ok(!res.text.startsWith("当前时间："), "失败时绝不能返回一个看起来像时间的字符串");
});
