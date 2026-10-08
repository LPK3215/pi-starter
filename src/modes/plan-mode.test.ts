/**
 * 计划模式测试。
 *
 * 三层各自都要能红：
 *   - 裁决纯函数：写类工具被拒、只读工具放行；改回去（去掉能力标签判定）测试就会红。
 *   - 落盘：重启后模式仍在；把 persist 改成空实现 → 断言「重启后仍生效」用例会红。
 *   - 扩展接线：`tool_call` 真的挂上了、`before_agent_start` 真的改了提示词。
 *     只测纯函数是不够的——「声明了但没接线」正是这个项目反复出现的缺陷形态。
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  MAX_PLAN_MODE_ENTRIES,
  PLAN_MODE_PROMPT_SECTION,
  PlanModeController,
  planModeDenyReason,
  planModeExtension,
} from "./plan-mode.js";

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "pi-plan-")), name);
}

/** 收集扩展注册的事件处理器，用来真正触发钩子。 */
function fakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi = {
    on(event: string, handler: (e: unknown, c: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    fire(event: string, payload: unknown, ctx: unknown): unknown[] {
      return (handlers.get(event) ?? []).map((handler) => handler(payload, ctx));
    },
    has(event: string): boolean {
      return (handlers.get(event) ?? []).length > 0;
    },
  };
}

const ctxFor = (sessionId: string) => ({
  cwd: "/tmp",
  sessionManager: { getSessionId: () => sessionId },
});

test("计划模式：写类工具被拒、只读工具放行，原因可操作", () => {
  assert.ok(planModeDenyReason("write"), "write must be blocked");
  assert.ok(planModeDenyReason("edit"), "edit must be blocked");
  assert.ok(planModeDenyReason("bash"), "bash must be blocked");
  assert.ok(planModeDenyReason("exec"), "exec must be blocked");
  assert.ok(planModeDenyReason("exec_stop"), "exec_stop must be blocked");
  assert.equal(planModeDenyReason("exec_jobs"), undefined);

  const denied = planModeDenyReason("mcp__srv__deploy", ["mcp", "net", "fs.write"])!;
  assert.match(denied, /只读工具/, "the reason must tell the model what to do instead");
  assert.match(denied, /解除计划模式/, "the reason must mention how to get unstuck");
  assert.match(denied, /fs\.write/, "and name the evidence that triggered it");

  assert.equal(planModeDenyReason("read"), undefined);
  assert.equal(planModeDenyReason("grep"), undefined);
  assert.equal(planModeDenyReason("db_query"), undefined);

  // Registry-driven tools are judged by capability, not by name — that is the only way
  // dynamically injected tools (MCP) cannot slip past the gate.
  assert.ok(planModeDenyReason("something_new", ["fs.write"]));
  assert.ok(planModeDenyReason("something_new", ["shell"]));
  assert.equal(planModeDenyReason("something_new", ["mcp", "net"]), undefined);
});

test("计划模式：未显式设置的会话跟随默认档", () => {
  let flag = false;
  const controller = new PlanModeController({ defaultEnabled: () => flag });
  assert.equal(controller.isEnabled("s1"), false);
  flag = true;
  assert.equal(controller.isEnabled("s1"), true, "default must be read lazily, not captured at construction");
  // An explicit choice outranks the default — otherwise flipping the setting would
  // silently override what the user picked for this conversation.
  controller.set("s1", false);
  flag = true;
  assert.equal(controller.isEnabled("s1"), false);
});

test("计划模式：状态落盘，重启后仍生效；坏文件回落而非抛错", () => {
  const filePath = tmpFile("plan-mode.json");
  const first = new PlanModeController({ filePath, defaultEnabled: () => false });
  first.set("sess-a", true);
  first.set("sess-b", false);

  const second = new PlanModeController({ filePath, defaultEnabled: () => false });
  assert.equal(second.isEnabled("sess-a"), true, "plan mode must survive a restart");
  assert.equal(second.isEnabled("sess-b"), false);

  // Corrupt file → fall back, never crash: a bad state file must not stop the service.
  writeFileSync(filePath, "{ not json", "utf8");
  const third = new PlanModeController({
    filePath,
    defaultEnabled: () => false,
    logger: () => {},
  });
  assert.equal(third.isEnabled("sess-a"), false);
});

test("计划模式：落盘内容过滤非法条目，条目数封顶", () => {
  const filePath = tmpFile("plan-mode.json");
  const entries: Record<string, boolean> = {};
  // 非法条目先写、合法条目后写：封顶按插入顺序淘汰最旧的，
  // 所以必须让「应当被保留的」排在后面，否则测的是淘汰顺序而不是过滤逻辑。
  entries["../escape"] = true;
  entries[""] = true;
  // A non-boolean value must be dropped rather than coerced to truthy.
  entries["notBool"] = "yes" as unknown as boolean;
  for (let i = 0; i < MAX_PLAN_MODE_ENTRIES + 20; i += 1) entries[`s${i}`] = true;
  entries["good"] = true;
  writeFileSync(filePath, JSON.stringify({ version: 1, entries }), "utf8");

  const controller = new PlanModeController({ filePath, defaultEnabled: () => false });
  assert.equal(controller.isEnabled("good"), true);
  assert.equal(controller.isEnabled("../escape"), false, "a path-like key must not be trusted");
  assert.equal(controller.isEnabled(""), false, "an empty key must not be trusted");
  assert.equal(controller.isEnabled("notBool"), false, "a non-boolean value must be dropped");
  assert.ok(
    controller.entries().length <= MAX_PLAN_MODE_ENTRIES,
    `entries must be capped, got ${controller.entries().length}`,
  );
  // 旧条目被淘汰、新条目保留：封顶是「保新弃旧」而不是随机丢。
  assert.equal(controller.isEnabled("s0"), false, "the oldest entries must be evicted first");
  assert.equal(controller.isEnabled(`s${MAX_PLAN_MODE_ENTRIES + 19}`), true, "the newest entry survives");
});

test("计划模式：tool_call 钩子真的拦得住，关闭后立刻放行", () => {
  const controller = new PlanModeController({ defaultEnabled: () => false });
  const capabilities = new Map([["write", ["fs.write"]]]);
  const { pi, fire } = fakePi();
  planModeExtension(controller, { capabilitiesOf: (name) => capabilities.get(name) ?? [] })(pi);
  const ctx = ctxFor("sess-x");

  // Off: every tool passes.
  assert.equal(fire("tool_call", { toolName: "write" }, ctx)[0], undefined);

  controller.set("sess-x", true);
  const blocked = fire("tool_call", { toolName: "write" }, ctx)[0] as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true, "the gate must actually block, not merely advise");
  assert.match(String(blocked?.reason), /计划模式/);

  // Read-only tools keep working in plan mode — a gate that blocks reads is useless.
  assert.equal(fire("tool_call", { toolName: "read" }, ctx)[0], undefined);

  // Another conversation is unaffected.
  assert.equal(fire("tool_call", { toolName: "write" }, ctxFor("sess-y"))[0], undefined);

  controller.set("sess-x", false);
  assert.equal(fire("tool_call", { toolName: "write" }, ctx)[0], undefined, "turning it off must restore writes");
});

test("计划模式：before_agent_start 追加提示词段落；关闭时不动提示词", () => {
  const controller = new PlanModeController({ defaultEnabled: () => false });
  const { pi, fire } = fakePi();
  planModeExtension(controller)(pi);
  const ctx = ctxFor("sess-y");
  const event = { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE" };

  assert.equal(fire("before_agent_start", event, ctx)[0], undefined, "no controller state → no change");

  controller.set("sess-y", true);
  const patched = fire("before_agent_start", event, ctx)[0] as { systemPrompt?: string };
  assert.ok(patched?.systemPrompt?.startsWith("BASE"), "the original prompt must be preserved");
  assert.ok(patched?.systemPrompt?.includes(PLAN_MODE_PROMPT_SECTION));
});

test("计划模式：拿不到 session id 时按 cwd 分键，而不是塌缩成同一个键", () => {
  const controller = new PlanModeController({ defaultEnabled: () => false });
  const { pi, fire } = fakePi();
  planModeExtension(controller)(pi);
  // 没有 sessionManager 的上下文：读一个不存在的 ctx.sessionId 会得到 undefined，
  // 于是所有对话共用一个键 —— 这条曾经在审批那边真实发生过。
  const blocked = (cwd: string) =>
    fire("tool_call", { toolName: "write" }, { cwd }) [0] as { block?: boolean } | undefined;
  controller.set("cwd:/tmp", true);
  assert.equal(blocked("/tmp")?.block, true);
  assert.equal(blocked("/var")?.block, undefined, "another cwd must not inherit the mode");
});