/**
 * HITL 反问桥的回归测试。
 *
 * 这些用例是「改回缺陷就会变红」的：id 不匹配、超时不兜底、断开不解除、取消不回落默认值，
 * 任何一条退化都会被抓住。不依赖网络、不依赖模型。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createExtensionUiBridge } from "./extension-ui-bridge.js";
import type { UiExtensionRequest } from "./protocol.js";

/** 造一个把请求收集到数组的桥，返回 [bridge, 已发出的请求]。 */
function harness(startId = 0) {
  const sent: UiExtensionRequest[] = [];
  let seq = startId;
  const bridge = createExtensionUiBridge((req) => {
    sent.push(req);
  }, { newId: () => `id-${seq++}` });
  return { bridge, sent };
}

test("input：按 id 命中应答，返回用户输入的文本", async () => {
  const { bridge, sent } = harness();
  const p = bridge.uiContext.input("您今年多大了？", "请输入年龄");
  // 请求已推给客户端，带官方线形。
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "input");
  assert.equal(bridge.pendingCount, 1);
  // 客户端回同一 id。
  assert.equal(bridge.resolve("id-0", { id: "id-0", value: "28" }), true);
  assert.equal(await p, "28");
  assert.equal(bridge.pendingCount, 0);
});

test("confirm：cancelled 回落 false（fail-safe，取消即拒绝）", async () => {
  const { bridge } = harness();
  const p = bridge.uiContext.confirm("危险操作", "允许执行？");
  bridge.resolve("id-0", { id: "id-0", cancelled: true });
  assert.equal(await p, false);
});

test("confirm：confirmed:true 放行", async () => {
  const { bridge } = harness();
  const p = bridge.uiContext.confirm("确认", "继续？");
  bridge.resolve("id-0", { id: "id-0", confirmed: true });
  assert.equal(await p, true);
});

test("select：返回选中值", async () => {
  const { bridge, sent } = harness();
  const p = bridge.uiContext.select("选一个", ["A", "B", "C"]);
  const sentReq = sent[0];
  assert.equal(sentReq.method, "select");
  assert.deepEqual(sentReq.method === "select" ? sentReq.options : null, ["A", "B", "C"]);
  bridge.resolve("id-0", { id: "id-0", value: "B" });
  assert.equal(await p, "B");
});

test("超时：到点无人应答返回默认值，不永久阻塞（定时器不能 unref）", async () => {
  const { bridge } = harness();
  const p = bridge.uiContext.input("等不到回答", undefined, { timeout: 20 });
  assert.equal(bridge.pendingCount, 1);
  assert.equal(await p, undefined); // 20ms 后自动兜底
  assert.equal(bridge.pendingCount, 0);
});

test("AbortSignal：中止即按取消解除，返回默认值", async () => {
  const { bridge } = harness();
  const controller = new AbortController();
  const p = bridge.uiContext.input("会被打断", undefined, { signal: controller.signal });
  controller.abort();
  assert.equal(await p, undefined);
  assert.equal(bridge.pendingCount, 0);
});

test("未知 id 的应答被拒绝（伪造 / 已超时的悬挂请求）", () => {
  const { bridge } = harness();
  assert.equal(bridge.resolve("nope", { id: "nope", value: "x" }), false);
});

test("emit 抛错（连接已断）时按默认值解除，不晾着工具", async () => {
  const bridge = createExtensionUiBridge(() => {
    throw new Error("socket closed");
  }, { newId: () => "id-0" });
  const p = bridge.uiContext.input("没人能收到", undefined);
  assert.equal(await p, undefined);
  assert.equal(bridge.pendingCount, 0);
});

test("dispose：把所有挂起请求按默认值解除", async () => {
  const { bridge } = harness();
  const p1 = bridge.uiContext.input("问题一");
  const p2 = bridge.uiContext.confirm("问题二", "确认？");
  assert.equal(bridge.pendingCount, 2);
  bridge.dispose();
  assert.equal(await p1, undefined);
  assert.equal(await p2, false);
  assert.equal(bridge.pendingCount, 0);
});

test("notify：fire-and-forget 推一帧，不产生挂起请求", () => {
  const { bridge, sent } = harness();
  bridge.uiContext.notify("已完成", "info");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "notify");
  assert.equal(bridge.pendingCount, 0);
});
