/**
 * provider / input / resources_discover 示例扩展的行为测试。
 *
 * 不依赖 SDK 运行时——用最小 `pi` 替身捕获 `pi.on` 注册，再直接调用登记的 handler，
 * 断言官方契约（原地改 headers、返回替换 payload、input transform/handled、resources 动态贡献路径）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providerHooksExtension } from "./provider-hooks.example.js";
import { inputResourcesExtension } from "./input-resources.example.js";
import { toolResultRedactionExtension } from "./tool-result-redaction.example.js";

type Handler = (event: any, ctx?: any) => any;

/** 造一个只记录 handler 的 pi 替身。 */
function stubPi() {
  const handlers: Record<string, Handler> = {};
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers[name] = handler;
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

test("before_provider_headers：原地注入头（返回值被忽略）", () => {
  const { pi, handlers } = stubPi();
  providerHooksExtension({ headers: () => ({ "x-trace": "s1", "x-drop": null }) })(pi);
  const event = { type: "before_provider_headers", headers: { accept: "application/json" } as Record<string, string | null> };
  handlers.before_provider_headers!(event);
  assert.equal(event.headers["x-trace"], "s1");
  assert.equal(event.headers["x-drop"], null); // null = 删除该头，官方契约
  assert.equal(event.headers.accept, "application/json"); // 原有头不动
});

test("before_provider_request：返回值替换 payload；不给改写器则原样透传", () => {
  const withRewrite = stubPi();
  providerHooksExtension({ rewritePayload: (p) => ({ ...(p as object), injected: true }) })(withRewrite.pi);
  const out = withRewrite.handlers.before_provider_request!({ type: "before_provider_request", payload: { a: 1 } });
  assert.deepEqual(out, { a: 1, injected: true });

  const passthrough = stubPi();
  providerHooksExtension()(passthrough.pi);
  assert.equal(passthrough.handlers.before_provider_request!({ type: "before_provider_request", payload: { a: 1 } }), undefined);
});

test("input：transform 改写、swallow 短路 handled、无操作时 undefined", () => {
  const { pi, handlers } = stubPi();
  inputResourcesExtension({ transformInput: (e) => e.text.trim() })(pi);
  const transformed = handlers.input!({ type: "input", text: "  hi  ", source: "user" });
  assert.deepEqual(transformed, { action: "transform", text: "hi" });
  // 未改写（trim 后相同）应返回 undefined，不打扰 Agent
  const same = handlers.input!({ type: "input", text: "hi", source: "user" });
  assert.equal(same, undefined);

  const swallowStub = stubPi();
  inputResourcesExtension({ swallow: (e) => e.text === "quit" })(swallowStub.pi);
  assert.deepEqual(swallowStub.handlers.input!({ type: "input", text: "quit", source: "user" }), { action: "handled" });
});

test("resources_discover：仅有贡献时返回路径集，否则 undefined", () => {
  const withPaths = stubPi();
  inputResourcesExtension({ skillPaths: ["./ext-skills"] })(withPaths.pi);
  assert.deepEqual(withPaths.handlers.resources_discover!({ type: "resources_discover", cwd: "/x", reason: "startup" }), {
    skillPaths: ["./ext-skills"],
  });

  const none = stubPi();
  inputResourcesExtension()(none.pi);
  assert.equal(none.handlers.resources_discover!({ type: "resources_discover", cwd: "/x", reason: "startup" }), undefined);
});

test("tool_result：命中规则时替换 text，无命中返回 undefined", () => {
  const { pi, handlers } = stubPi();
  toolResultRedactionExtension({ rules: [{ pattern: /sk-[A-Za-z0-9]+/g, replacement: "[REDACTED]" }] })(pi);
  const out = handlers.tool_result!({
    type: "tool_result",
    toolName: "exec",
    toolCallId: "t1",
    input: {},
    isError: false,
    content: [{ type: "text", text: "key=sk-abcdef123 done" }],
  });
  assert.deepEqual(out.content, [{ type: "text", text: "key=[REDACTED] done" }]);

  // 无命中 → 不改写（不打扰模型可见内容）。
  const clean = handlers.tool_result!({
    type: "tool_result", toolName: "read", toolCallId: "t2", input: {}, isError: false,
    content: [{ type: "text", text: "nothing secret here" }],
  });
  assert.equal(clean, undefined);
});

test("tool_result：tools 白名单作范围限定，不在名单内不处理", () => {
  const { pi, handlers } = stubPi();
  toolResultRedactionExtension({ rules: [{ pattern: /secret/g, replacement: "[X]" }], tools: ["exec"] })(pi);
  assert.equal(
    handlers.tool_result!({ type: "tool_result", toolName: "read", toolCallId: "t", input: {}, isError: false, content: [{ type: "text", text: "secret" }] }),
    undefined,
  );
  const hit = handlers.tool_result!({ type: "tool_result", toolName: "exec", toolCallId: "t", input: {}, isError: false, content: [{ type: "text", text: "secret" }] });
  assert.deepEqual(hit.content, [{ type: "text", text: "[X]" }]);
});
