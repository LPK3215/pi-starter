/**
 * SDK 私有形状适配层的测试。
 *
 * 这一层的价值就是「SDK 升级时一处崩、一处改」，所以测试要锁住两件事：
 *   1. 形状**对**时能取到；
 *   2. 形状**不对或缺失**时返回 undefined（显式降级），而不是抛错 ——
 *      否则升级 SDK 会让 UI 操作变成 5xx，而不是「功能安静地不可用」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sdkAbortCompaction,
  sdkAgentState,
  sdkCompact,
  sdkCycleModel,
  sdkCycleThinkingLevel,
  sdkRenameSession,
  sdkSessionManager,
} from "./sdk-adapter.js";

test("sdkSessionManager：形状不对或缺失时返回 undefined，不抛", () => {
  assert.equal(sdkSessionManager({}), undefined);
  assert.equal(sdkSessionManager({ sessionManager: {} }), undefined, "缺 buildContextEntries 视为不可用");
  const manager = { buildContextEntries: () => [] };
  assert.equal(sdkSessionManager({ sessionManager: manager }), manager);
});

test("sdkCompact / sdkAbortCompaction：只放行函数", () => {
  const compact = async () => undefined;
  const abort = () => {};
  assert.equal(sdkCompact({ compact }), compact);
  assert.equal(sdkAbortCompaction({ abortCompaction: abort }), abort);
  // 非函数（SDK 换了字段名 / 变成属性）一律当成「不支持」，不能让它半可用。
  assert.equal(sdkCompact({ compact: true }), undefined);
  assert.equal(sdkAbortCompaction({ abortCompaction: "nope" }), undefined);
  assert.equal(sdkCompact({}), undefined);
});

test("sdkCycleModel / sdkCycleThinkingLevel：只放行函数", () => {
  const cycle = async () => ({ model: { provider: "p", id: "m" } });
  const cycleThinking = () => "high";
  assert.equal(sdkCycleModel({ cycleModel: cycle }), cycle);
  assert.equal(sdkCycleThinkingLevel({ cycleThinkingLevel: cycleThinking }), cycleThinking);
  assert.equal(sdkCycleModel({ cycleModel: 3 }), undefined);
  assert.equal(sdkCycleThinkingLevel({}), undefined);
});

test("sdkAgentState：透传 agent.state，缺失为 undefined", () => {
  const state = { messages: [] };
  assert.equal(sdkAgentState({ agent: { state } }), state);
  assert.equal(sdkAgentState({ agent: {} }), undefined);
  assert.equal(sdkAgentState({}), undefined);
});

test("sdkRenameSession：优先 setSessionName，退回落 appendSessionInfo，都没有则 false", () => {
  const calls: string[] = [];
  const withSetter = {
    setSessionName: (n: string) => calls.push(`set:${n}`),
    sessionManager: { appendSessionInfo: (n: string) => calls.push(`append:${n}`) },
  };
  assert.equal(sdkRenameSession(withSetter, "A"), true);
  assert.deepEqual(calls, ["set:A"], "有官方 setter 时不应退回 sessionManager");

  calls.length = 0;
  const withManagerOnly = { sessionManager: { appendSessionInfo: (n: string) => calls.push(`append:${n}`) } };
  assert.equal(sdkRenameSession(withManagerOnly, "B"), true);
  assert.deepEqual(calls, ["append:B"], "缺 setter 时必须走退化路径，而不是静默不算数");

  assert.equal(sdkRenameSession({}, "C"), false, "两条路都没有时如实返回 false");
});
