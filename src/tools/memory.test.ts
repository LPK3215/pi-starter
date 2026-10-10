/**
 * 记忆工具层测试。
 *
 * 工具层是**模型直接看到**的那一层，所以要验的是「呈现给模型的内容」：
 * 参数校验失败时是不是给了一句能改的话，而不是抛异常收场；
 * 写成功时有没有回报 id 与淘汰信息。存储行为本身由 `memory/store.test.ts` 覆盖。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRecallTool, createRememberTool } from "./memory.js";
import { MemoryStore } from "../memory/store.js";

function makeStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-tool-"));
  return new MemoryStore({ filePath: join(dir, "memory.jsonl") });
}

async function runTool(
  tool: { execute: unknown },
  params: unknown,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const result = await (
    tool.execute as (id: string, params: unknown, signal: undefined, update: undefined, ctx: never) => Promise<{
      content: Array<{ type: string; text?: string }>;
      details: Record<string, unknown>;
    }>
  )("call-1", params, undefined, undefined, undefined as never);
  return {
    text: result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join(""),
    details: result.details,
  };
}

test("remember：写入成功后回报 id，且内容真的进了 store", async () => {
  const store = makeStore();
  const run = await runTool(createRememberTool(store), { text: "偏好中文", tags: ["preference"] });
  assert.equal(run.details.ok, true);
  assert.match(run.text, /已记住/);
  assert.equal(store.size, 1);
  assert.deepEqual(store.list()[0]?.tags, ["preference"]);
});

test("remember：正文超限时返回可读说明而不是抛异常", async () => {
  const store = makeStore();
  const run = await runTool(createRememberTool(store), { text: "x".repeat(5000) });
  assert.equal(run.details.ok, false);
  assert.match(run.text, /没能记住/);
  assert.match(run.text, /exceeds/);
  assert.equal(store.size, 0, "被拒的记忆不该落库");
});

test("remember：两个分支的 details 同形状（SDK 的类型推断靠它）", async () => {
  const store = makeStore();
  const ok = await runTool(createRememberTool(store), { text: "好" });
  const bad = await runTool(createRememberTool(store), { text: "" });
  assert.deepEqual(Object.keys(ok.details).sort(), Object.keys(bad.details).sort());
});

test("remember：超出总条数上限时把「淘汰了几条」说给模型听", async () => {
  const store = makeStore();
  const tool = createRememberTool(store);
  // 直接塞满存储上限，避免 2000 次工具调用拖慢测试。
  for (let i = 0; i < 2000; i += 1) store.remember({ text: `seed-${i}` });
  const run = await runTool(tool, { text: "最新的一条" });
  assert.equal(run.details.ok, true);
  assert.equal(run.details.evicted, 1);
  assert.match(run.text, /淘汰 1 条/);
});

test("recall：空查询列出最近记过的", async () => {
  const store = makeStore();
  store.remember({ text: "第一条" });
  store.remember({ text: "第二条" });
  const run = await runTool(createRecallTool(store), {});
  assert.equal((run.details.total as number), 2);
  assert.match(run.text, /第一条/);
  assert.match(run.text, /第二条/);
});

test("recall：没有记忆时明说没有，不假装有", async () => {
  const store = makeStore();
  const empty = await runTool(createRecallTool(store), {});
  assert.match(empty.text, /还没有任何记忆/);
  assert.deepEqual(empty.details.hits, []);

  store.remember({ text: "偏好中文" });
  const miss = await runTool(createRecallTool(store), { query: "不存在的词" });
  assert.match(miss.text, /没有匹配「不存在的词」的记忆/);
});

test("recall：命中时逐条带 id 与标签，供模型引用", async () => {
  const store = makeStore();
  store.remember({ text: "项目用 Node 22", tags: ["project"] });
  const run = await runTool(createRecallTool(store), { query: "Node" });
  assert.match(run.text, /\[project\]/);
  assert.match(run.text, /项目用 Node 22/);
  assert.equal((run.details.hits as unknown[]).length, 1);
});
