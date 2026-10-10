/**
 * `ask_user_question` 测试。
 *
 * 这是 HITL（human-in-the-loop）工具：它在**回合中途阻塞等人类输入**，所以在它身上
 * 出错不是「答得不对」，而是「整轮卡死」或「悄悄跳过」。这里的断言围绕两件事：
 *   1. 没有可应答界面时**绝不假装等待**，如实交回模型；
 *   2. 用户取消 / 超时 / 无选项（`undefined`）与 confirm 选「否」（`false`）都算未作答，
 *      而且这两种「未作答」必须能区分于「已回答」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { askUserQuestionTool } from "./ask-user-question.js";

interface UiCalls {
  input: Array<{ question: string; placeholder?: string }>;
  select: Array<{ question: string; options: readonly string[] }>;
  confirm: Array<{ question: string }>;
}

/** `ctx.ui` 替身：记录被调用形态，并按脚本返回答案。 */
function fakeCtx(options: { hasUI?: boolean; answer?: string | boolean | undefined } = {}) {
  const calls: UiCalls = { input: [], select: [], confirm: [] };
  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: {
      async input(question: string, placeholder?: string) {
        calls.input.push({ question, placeholder });
        return options.answer as string | undefined;
      },
      async select(question: string, choices: readonly string[]) {
        calls.select.push({ question, options: choices });
        return options.answer as string | undefined;
      },
      async confirm(question: string) {
        calls.confirm.push({ question });
        return options.answer as boolean | undefined;
      },
    },
  };
  return { ctx, calls };
}

/** 调工具，抽出文本与 details。 */
async function run(
  params: unknown,
  ctx: unknown,
  signal?: AbortSignal,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const result = await (
    askUserQuestionTool.execute as unknown as (
      id: string,
      params: unknown,
      signal: AbortSignal | undefined,
      update: undefined,
      ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>
  )("call-1", params, signal, undefined, ctx);
  return {
    text: result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join(""),
    details: result.details,
  };
}

test("没有可应答界面时如实交回模型，且**不调用任何 ui 方法**", async () => {
  const { ctx, calls } = fakeCtx({ hasUI: false });
  const res = await run({ question: "你多大？" }, ctx);
  assert.equal(res.details.answered, false);
  assert.equal(res.details.mode, "no-ui");
  assert.match(res.text, /没有可即时应答的人类界面/);
  assert.match(res.text, /正常回复里直接向用户提问/, "要给出替代做法，而不是只说做不到");
  assert.deepEqual(calls, { input: [], select: [], confirm: [] }, "无 UI 时不该发起任何提问");
});

test("默认 type=text 走 ctx.ui.input，并透传 placeholder", async () => {
  const { ctx, calls } = fakeCtx({ answer: "42" });
  const res = await run({ question: "你多大？", placeholder: "填数字" }, ctx);
  assert.equal(calls.input.length, 1);
  assert.equal(calls.input[0]?.question, "你多大？");
  assert.equal(calls.input[0]?.placeholder, "填数字");
  assert.equal(res.details.answered, true);
  assert.equal(res.details.mode, "text");
  assert.equal(res.details.value, "42");
  assert.equal(res.text, "用户回答：42");
});

test("type=select 走 ctx.ui.select；未给 options 时传空数组而不是 undefined", async () => {
  const { ctx, calls } = fakeCtx({ answer: "B" });
  await run({ question: "选一个", type: "select", options: ["A", "B"] }, ctx);
  assert.deepEqual(calls.select[0]?.options, ["A", "B"]);

  await run({ question: "选一个", type: "select" }, ctx);
  assert.deepEqual(calls.select[1]?.options, [], "SDK 的 select 需要数组，不能塞 undefined");
});

test("type=confirm 走 ctx.ui.confirm；选「否」与取消一样算未作答", async () => {
  const yes = fakeCtx({ answer: true });
  const yesRun = await run({ question: "继续吗？", type: "confirm" }, yes.ctx);
  assert.equal(yesRun.details.answered, true);
  assert.equal(yesRun.text, "用户已确认。");

  // false（明确否）与 undefined（取消/超时）都算未作答 —— 但对模型而言 false 也是信息，
  // 所以文案统一成「未作答」并提示它重新决策，而不是把它当成 yes。
  for (const answer of [false, undefined]) {
    const { ctx } = fakeCtx({ answer });
    const res = await run({ question: "继续吗？", type: "confirm" }, ctx);
    assert.equal(res.details.answered, false, `${String(answer)} 必须算未作答`);
    assert.equal(res.details.mode, "confirm");
    assert.match(res.text, /用户未作答（已取消或超时）/);
  }
});

test("AbortSignal 原样传给 ui，让超时/断线能真的取消等待", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const ctx = {
    hasUI: true,
    ui: {
      async input(_question: string, _placeholder?: string, options?: { signal?: AbortSignal }) {
        received = options?.signal;
        return "ok";
      },
      async select() {
        return undefined;
      },
      async confirm() {
        return undefined;
      },
    },
  };
  await run({ question: "在吗" }, ctx, controller.signal);
  assert.equal(received, controller.signal, "不传 signal 的话桥那头没法取消，会一直挂到超时");
});
