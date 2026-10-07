import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { sse, toolResultPreview, translateEvent } from "./sse.js";

function asEvent(event: object): AgentSessionEvent {
  return event as unknown as AgentSessionEvent;
}

function parseSse(raw: string | null): { type: string; data: unknown } | null {
  if (!raw) return null;
  assert.match(raw, /^data: .+\n\n$/);
  return JSON.parse(raw.slice(6).trim());
}

test("text / thinking delta 翻成对应 SSE 事件", () => {
  const text = parseSse(
    translateEvent(asEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "你好" },
    })),
  );
  assert.deepEqual(text, { type: "text", data: { delta: "你好" } });

  const thinking = parseSse(
    translateEvent(asEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "想一下" },
    })),
  );
  assert.deepEqual(thinking, { type: "thinking", data: { delta: "想一下" } });
});

test("工具起止翻成 tool_start / tool_end，结果截断", () => {
  const start = parseSse(
    translateEvent(asEvent({
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "current_time",
      args: { timezone: "Asia/Shanghai" },
    })),
  );
  assert.deepEqual(start, {
    type: "tool_start",
    data: { id: "1", name: "current_time", args: { timezone: "Asia/Shanghai" } },
  });

  const long = "x".repeat(600);
  const end = parseSse(
    translateEvent(asEvent({
      type: "tool_execution_end",
      toolCallId: "1",
      toolName: "current_time",
      result: { content: [{ type: "text", text: long }] },
      isError: false,
    })),
  );
  assert.equal(end?.type, "tool_end");
  const data = end?.data as { result: string; isError: boolean; name: string };
  assert.equal(data.name, "current_time");
  assert.equal(data.isError, false);
  assert.equal(data.result.length, 501);
  assert.equal(data.result.endsWith("…"), true);
});

test("无关事件返回 null，sse 信封符合规范", () => {
  assert.equal(translateEvent(asEvent({ type: "agent_settled" })), null);
  assert.equal(sse("done", {}), `data: ${JSON.stringify({ type: "done", data: {} })}\n\n`);
  assert.equal(toolResultPreview({ content: [{ type: "text", text: "ok" }] }), "ok");
});
