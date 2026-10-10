/**
 * 工具调用审计扩展（`auditExtension`）测试。
 *
 * 这个扩展的价值**全在「记什么、不记什么」**上：它的历史版本直接
 * `JSON.stringify(event.args)` 落盘，于是 `db_query` 的 SQL、`write` 的文件内容、
 * 入参里的密钥原文全都进了日志。现在只记元信息。所以这里的核心断言不是「有日志」，
 * 而是**日志里绝不能出现参数值**（尤其是密钥）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { auditExtension } from "./audit.js";
import { resolveLogLevel } from "../log.js";

/**
 * 把全局 logger 换成写进数组的实例。
 *
 * `auditExtension` 内部走 `getLogger()`，所以只能改全局的；跑完必须还原成模块初始
 * 的那个形态（`resolveLogLevel()` + 默认 console sink），否则后面的测试会静默输出
 * 或把日志写进已废弃的数组。
 */
async function withCapturedLog(fn: (lines: string[]) => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const logModule = await import("../log.js");
  logModule.configureLog({ level: "debug", sink: (line) => lines.push(line) });
  try {
    await fn(lines);
  } finally {
    logModule.configureLog({ level: resolveLogLevel() });
  }
  return lines;
}

/** 只捕获需要的两个事件的 ExtensionAPI 替身。 */
function fakePi() {
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  const pi = {
    on(name: string, handler: (event: unknown) => void) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    emit(name: string, event: unknown) {
      for (const handler of handlers.get(name) ?? []) handler(event);
    },
    registered: () => [...handlers.keys()].sort(),
  };
}

const startEvent = (toolCallId: string, toolName: string, args: unknown = {}) => ({
  toolCallId,
  toolName,
  args,
});
const endEvent = (toolCallId: string, toolName: string, isError = false) => ({ toolCallId, toolName, isError });

test("只挂在 tool_execution_start / end 两个事件上", () => {
  const { pi, registered } = fakePi();
  auditExtension(pi);
  assert.deepEqual(registered(), ["tool_execution_end", "tool_execution_start"]);
});

test("参数只记**字段名**（排序后），绝不记值——密钥不能进日志", async () => {
  const lines = await withCapturedLog(() => {
    const { pi, emit } = fakePi();
    auditExtension(pi);
    emit(
      "tool_execution_start",
      startEvent("c1", "db_query", {
        sql: "SELECT * FROM users WHERE token='sk-live-super-secret'",
        apiKey: "sk-live-super-secret",
        limit: 10,
      }),
    );
  });
  const text = lines.join("\n");
  assert.match(text, /"toolName":"db_query"/);
  // 字段名在（排序后），值一个都不在。
  assert.match(text, /"argKeys":\["apiKey","limit","sql"\]/);
  assert.ok(!text.includes("sk-live-super-secret"), "参数值（含密钥）绝不能出现在日志里");
  assert.ok(!text.includes("SELECT * FROM users"), "SQL 原文绝不能出现在日志里");
});

test("logArgKeys=false 时连字段名都不记（只留工具名）", async () => {
  const lines = await withCapturedLog(() => {
    const { pi, emit } = fakePi();
    auditExtension(pi, { logArgKeys: false });
    emit("tool_execution_start", startEvent("c1", "write", { path: "a.txt", content: "秘密内容" }));
  });
  const text = lines.join("\n");
  assert.match(text, /"toolName":"write"/);
  assert.ok(!text.includes("argKeys"), "关闭后不该出现 argKeys 字段");
  assert.ok(!text.includes("秘密内容"));
});

test("end 事件配对算出耗时；失败的调用走 warn", async () => {
  const lines = await withCapturedLog(() => {
    const { pi, emit } = fakePi();
    auditExtension(pi);
    emit("tool_execution_start", startEvent("c1", "bash"));
    emit("tool_execution_end", endEvent("c1", "bash"));
    emit("tool_execution_start", startEvent("c2", "exec"));
    emit("tool_execution_end", endEvent("c2", "exec", true));
  });
  const parsed = lines.map((line) => JSON.parse(line) as { level: string; msg: string; durationMs?: number; isError?: boolean });
  const end = parsed.filter((entry) => entry.msg === "工具调用结束");
  assert.equal(end.length, 2);
  assert.equal(typeof end[0]?.durationMs, "number", "配对上之后必须有耗时");
  assert.equal(end[0]?.isError, false);
  assert.equal(end[1]?.level, "warn", "失败的调用必须是 warn，否则会被 info 噪声淹没");
  assert.equal(end[1]?.isError, true);
});

test("没有对应 start 的 end 不崩，只是没有耗时", async () => {
  const lines = await withCapturedLog(() => {
    const { pi, emit } = fakePi();
    auditExtension(pi);
    emit("tool_execution_end", endEvent("never-started", "bash"));
  });
  const end = JSON.parse(lines.at(-1) ?? "{}") as { durationMs?: number };
  assert.equal(end.durationMs, undefined);
});

test("进行中调用有上限：超过 256 条后最早的被淘汰，不会无界增长", async () => {
  const lines = await withCapturedLog(() => {
    const { pi, emit } = fakePi();
    auditExtension(pi);
    // 塞满上限再多一条，然后结束最早那条：它应该已经被淘汰（没有耗时）。
    for (let i = 0; i < 257; i += 1) emit("tool_execution_start", startEvent(`c${i}`, "bash"));
    emit("tool_execution_end", endEvent("c0", "bash"));
    emit("tool_execution_end", endEvent("c256", "bash"));
  });
  const ends = lines
    .map((line) => JSON.parse(line) as { msg: string; toolCallId?: string; durationMs?: number })
    .filter((entry) => entry.msg === "工具调用结束");
  const evicted = ends.find((entry) => entry.toolCallId === "c0");
  const kept = ends.find((entry) => entry.toolCallId === "c256");
  assert.equal(evicted?.durationMs, undefined, "第 257 条进来时，最早那条应被淘汰");
  assert.equal(typeof kept?.durationMs, "number", "最新那条必须还在表里");
});
