/**
 * 回归测试：审批闸门 / 会话编排 / 协议 / 上下文预算 的接线正确性。
 *
 * 这些用例针对「声明了但没接线」的一类缺陷——类型检查与既有单测都发现不了，
 * 只有断言运行期行为才能锁住。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalGate, approvalExtension } from "./approval/gate.js";
import { ApprovalRulesStore, evaluateRules } from "./approval/rules.js";
import { decideApproval } from "./approval/policy.js";
import { composePrompt, defaultPromptTemplate, unknownTokens } from "./prompts/composer.js";
import {
  applyTrim,
  computeSoftCap,
  contextUsageRatio,
  estimateTokens,
  planContextTrim,
} from "./context/budget.js";
import { PROTOCOL_VERSION, CLIENT_MESSAGE_TYPES, isClientMessage } from "./protocol.js";
import { RUNTIME_DEFAULTS, resolveRuntimeConfig } from "./config.js";

/* ─────────────────── D1：审批会话键不得恒为 "default" ─────────────────── */

/** 复刻 SDK 的 ExtensionContext 形状：只有 sessionManager，没有 sessionId。 */
function sdkContext(sessionId: string, cwd = "/work") {
  return { cwd, sessionManager: { getSessionId: () => sessionId } };
}

test("D1 会话键取自 sessionManager.getSessionId()，不再坍缩到 default", async () => {
  const seen: string[] = [];
  const gate = new ApprovalGate({
    rules: () => [],
    enabled: () => false, // 不真的问人，只观察 key
    onRequest: (key) => seen.push(key),
  });

  // 捕获 SDK 注册的 tool_call 处理器，喂入真实形状的 ctx。
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  const fakePi = {
    on(event: string, fn: unknown) {
      if (event === "tool_call") handler = fn as typeof handler;
    },
  };
  approvalExtension(gate)(fakePi as never);
  assert.ok(handler, "tool_call handler should be registered");

  await handler!({ toolName: "read", input: { path: "a.txt" } }, sdkContext("conv-A"));
  await handler!({ toolName: "read", input: { path: "a.txt" } }, sdkContext("conv-B"));

  // 两个会话必须拿到不同的 key（审批选择才不会跨对话泄漏）。
  assert.equal(seen.length, 0, "no approval should be raised when rules are empty");

  // 直接验证默认 key 解析：用规则强制命中 ask。
  const askGate = new ApprovalGate({
    rules: () => [
      {
        id: "builtin:test.ask",
        description: "ask always",
        tools: "*",
        field: "params",
        match: { kind: "contains", value: "secret" },
        action: "ask",
      },
    ],
    enabled: () => true,
    onRequest: (key) => seen.push(key),
  });
  let handler2: ((event: unknown, ctx: unknown) => Promise<{ block?: boolean } | undefined>) | undefined;
  approvalExtension(askGate)({
    on(event: string, fn: unknown) {
      if (event === "tool_call") {
        handler2 = fn as typeof handler2;
      }
    },
  } as never);

  const p1 = handler2!({ toolName: "read", input: { path: "secret.env" } }, sdkContext("conv-A"));
  const p2 = handler2!({ toolName: "read", input: { path: "secret.env" } }, sdkContext("conv-B"));
  // 两个请求都在等待人类应答；key 必须不同。
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seen.sort(), ["conv-A", "conv-B"]);
  assert.equal(askGate.pendingCount, 2);

  // 清理：dispose 会把在途请求判为 deny，避免测试悬挂。
  // 被拒时扩展返回 SDK 契约里的 { block: true }，而不是内部 outcome。
  askGate.dispose();
  assert.equal((await p1)?.block, true);
  assert.equal((await p2)?.block, true);
});

test("D1 conversationOf 能定位到真正拥有该请求的会话", () => {
  const gate = new ApprovalGate({ rules: () => [], enabled: () => false, onRequest: () => {} });
  // enabled=false 时不会产生 pending，这里只断言接口不抛。
  assert.equal(gate.conversationOf("nope"), undefined);
  gate.dispose();
});

test("D1 approvalMode 通过 defaultPolicy 生效，而不是硬编码 off", () => {
  const gate = new ApprovalGate({
    rules: () => [],
    enabled: () => false,
    defaultPolicy: () => ({ mode: "category", categories: ["bash.rm-rf"] }),
    onRequest: () => {},
  });
  assert.equal(gate.policyFor("conv-1").mode, "category");
  assert.deepEqual(gate.policyFor("conv-1").categories, ["bash.rm-rf"]);
  // 不同会话各自独立，且默认值被拷贝（改一个不影响另一个）。
  const other = gate.policyFor("conv-2");
  other.categories.push("fs.write");
  assert.deepEqual(gate.policyFor("conv-1").categories, ["bash.rm-rf"]);
  gate.dispose();
});

test("D1 deny 不可被任何策略覆盖（关审批也不放过）", () => {
  const rules = [
    {
      id: "builtin:bash.mkfs",
      description: "mkfs",
      tools: ["bash"],
      field: "command" as const,
      match: { kind: "regex" as const, value: "\\bmkfs\\b" },
      action: "deny" as const,
    },
  ];
  // 即便 approvalMode=all 且全局开关关闭，deny 依然拒绝。
  const result = decideApproval({
    rules,
    policy: { mode: "all", categories: [] },
    context: { toolName: "bash", args: { command: "mkfs.ext4 /dev/sda1" }, cwd: "/w" },
    enabled: false,
  });
  assert.equal(result.action, "deny");
  assert.equal(result.suppressed, false);
});

/* ─────────────────── D2：规则引擎行为 ─────────────────── */

test("D2 capability 匹配让新工具自动落网", () => {
  const verdict = evaluateRules(
    [
      {
        id: "cap:fs.write",
        description: "any write-capable tool",
        tools: "*",
        field: "params",
        match: { kind: "capability", value: "fs.write" },
        action: "ask",
      },
    ],
    { toolName: "brand_new_writer", args: {}, cwd: "/w", capabilities: ["fs.write"] },
  );
  assert.ok(verdict);
  assert.equal(verdict.action, "ask");
  assert.equal(verdict.ruleId, "cap:fs.write");
});

test("D2 用户规则覆盖同名内置规则（用户在前）", () => {
  const store = new ApprovalRulesStore({
    userRules: [
      {
        id: "builtin:bash.rm-rf",
        description: "user allows rm -rf",
        tools: ["bash"],
        field: "command",
        match: { kind: "regex", value: "rm\\s+-" },
        action: "allow",
      },
    ],
  });
  const verdict = store.evaluate({
    toolName: "bash",
    args: { command: "rm -rf ./tmp" },
    cwd: "/w",
    capabilities: ["shell"],
  });
  assert.equal(verdict?.action, "allow");
});

test("D2 写坏的正则不命中也不影响后续规则", () => {
  const verdict = evaluateRules(
    [
      {
        id: "broken",
        description: "bad regex",
        tools: "*",
        field: "params",
        match: { kind: "regex", value: "([unclosed" },
        action: "ask",
      },
      {
        id: "fallback",
        description: "catch all",
        tools: "*",
        field: "params",
        match: { kind: "contains", value: "rm" },
        action: "ask",
      },
    ],
    { toolName: "bash", args: { command: "rm x" }, cwd: "/w" },
  );
  assert.equal(verdict?.ruleId, "fallback");
});

/* ─────────────────── D3：提示词组合 ─────────────────── */

test("D3 默认模板渲染等价于 persona+rules 拼接，且不残留占位符", () => {
  const out = composePrompt(defaultPromptTemplate(), {
    persona: "P",
    rules: "R",
    knowledge: "K",
  });
  assert.equal(out, "P\n\nR\n\nK");
  assert.ok(!out.includes("{{"), "no literal placeholder may leak into the prompt");
});

test("D3 缺失的已知层渲染为空串，未知 token 原样保留", () => {
  const out = composePrompt("{{persona}}\n\n{{nope}}", { persona: "P", rules: "" });
  assert.ok(out.includes("{{nope}}"), "unknown token must stay visible to surface typos");
  assert.ok(!out.includes("{{rules}}"), "known-but-missing layer must render empty");
  assert.deepEqual(unknownTokens("{{a}}{{b}}{{a}}"), ["a", "b"]);
});

/* ─────────────────── D4：上下文预算 ─────────────────── */

test("D4 软上限为窗口减 reserve，且小窗口不会被吃成 0", () => {
  assert.equal(computeSoftCap(100000), 100000 - Math.max(15000, 4096));
  assert.equal(computeSoftCap(0), 0, "unknown window → 0");
  const tiny = computeSoftCap(4096);
  assert.ok(tiny > 0, "small window must still leave headroom");
});

test("D4 裁剪计划保留首条 user 与最近若干条，且不改原数组", () => {
  const messages = [
    { role: "user", text: "task definition" },
    ...Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: "x".repeat(400),
    })),
  ];
  const snapshot = JSON.stringify(messages);
  const plan = planContextTrim({ messages, maxTokens: 500, keepRecent: 4 });

  assert.equal(plan.trimmed, true);
  assert.ok(plan.keep.includes(0), "first user message must be preserved");
  const lastKept = Math.max(...plan.keep);
  assert.equal(lastKept, messages.length - 1, "tail must be preserved");
  assert.equal(JSON.stringify(messages), snapshot, "planner must not mutate input");

  const trimmed = applyTrim(messages, plan);
  assert.equal(trimmed.length, messages.length - plan.drop.length);
  assert.equal(trimmed[0].text, "task definition");
});

test("D4 未超预算时不裁剪，进度比例被夹在 [0,1]", () => {
  const messages = [{ role: "user", text: "hi" }];
  const plan = planContextTrim({ messages, maxTokens: 100000 });
  assert.equal(plan.trimmed, false);
  assert.deepEqual(plan.drop, []);
  assert.equal(contextUsageRatio(50, 100), 0.5);
  assert.equal(contextUsageRatio(500, 100), 1, "clamped to 1");
  assert.equal(contextUsageRatio(50, 0), 0, "unknown cap → 0");
  assert.equal(estimateTokens(""), 0);
});

/* ─────────────────── D5：协议单源 ─────────────────── */

test("D5 协议版本默认值来自 PROTOCOL_VERSION，不会各自漂移", () => {
  assert.equal(RUNTIME_DEFAULTS.protocolVersion, PROTOCOL_VERSION);
  // 环境变量可覆盖（用于刻意的错配构建），但缺省必须一致。
  assert.equal(resolveRuntimeConfig({}).protocolVersion, PROTOCOL_VERSION);
  assert.equal(resolveRuntimeConfig({ PI_PROTOCOL_VERSION: "9" }).protocolVersion, 9);
});

test("D5 消息守卫只认对象且必须有 type 判别式", () => {
  assert.equal(isClientMessage({ type: "prompt", text: "x" }), true);
  assert.equal(isClientMessage(null), false);
  assert.equal(isClientMessage("prompt"), false);
  assert.equal(isClientMessage({}), false);
  assert.ok(CLIENT_MESSAGE_TYPES.includes("prompt"));
});

test("D5 运行时配置默认绑定 loopback 并可被环境变量覆盖", () => {
  const cfg = resolveRuntimeConfig({});
  assert.equal(cfg.host, "127.0.0.1", "must default to loopback");
  assert.equal(cfg.wsPath, "/ws");
  // 缺少前导斜杠时自动补全，避免升级路径被静默改成非法值。
  assert.equal(resolveRuntimeConfig({ PI_WS_PATH: "socket" }).wsPath, "/socket");
  assert.equal(resolveRuntimeConfig({ PI_HOST: "0.0.0.0" }).host, "0.0.0.0");
});
