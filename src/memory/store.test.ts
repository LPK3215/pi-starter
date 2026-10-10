/**
 * 跨会话记忆的存储层测试。
 *
 * 这里要证明的不是「set 再 get 相等」，而是三件容易做错的事：
 *   1. **落盘后重启还在**（记忆的全部意义就是跨会话）；
 *   2. **重复写入同一段正文是覆盖而不是新增**（模型重复「记住」是常态）；
 *   3. **有界**（单条超限拒绝、总条数超限淘汰最旧）。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_MEMORY_BYTES,
  MAX_MEMORY_ENTRIES,
  MemoryStore,
} from "./store.js";
import { tempDir } from "../test-tmp.js";

function makeStore(): { store: MemoryStore; file: string } {
  const dir = tempDir("pi-memory-");
  const file = join(dir, "memory.jsonl");
  return { store: new MemoryStore({ filePath: file }), file };
}

test("记忆：写入后落盘，重建实例仍在（跨会话的前提）", () => {
  const { store, file } = makeStore();
  const { entry, evicted } = store.remember({ text: "用户偏好中文回答", tags: ["preference"] });
  assert.equal(evicted, 0);
  assert.ok(entry.id);
  assert.ok(existsSync(file), "写入即落盘");
  // 落盘内容必须是可解析的 JSONL（单行一条）。
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).text, "用户偏好中文回答");

  const reopened = new MemoryStore({ filePath: file });
  assert.equal(reopened.size, 1);
  assert.equal(reopened.list()[0]?.text, "用户偏好中文回答");
  assert.deepEqual(reopened.list()[0]?.tags, ["preference"]);
});

test("记忆：同一段正文重复写入是覆盖，不产生重复条目", () => {
  const { store } = makeStore();
  store.remember({ text: "偏好简洁", tags: ["a"] });
  const { entry: second } = store.remember({ text: "偏好简洁", tags: ["b"] });
  assert.equal(store.size, 1, "重复正文只应有一条");
  assert.equal(second.tags[0], "b", "覆盖时刷新标签");
});

test("记忆：空正文与超字节上限都被拒绝（不静默截断）", () => {
  const { store } = makeStore();
  assert.throws(() => store.remember({ text: "   " }), /empty/);
  assert.throws(
    () => store.remember({ text: "x".repeat(MAX_MEMORY_BYTES + 1) }),
    /exceeds/,
  );
  // 恰好等于上限应被接受（边界，差一错误的常见形态）。
  store.remember({ text: "y".repeat(MAX_MEMORY_BYTES) });
  assert.equal(store.size, 1);
});

test("记忆：超出总条数上限时淘汰最旧的并回报条数", () => {
  const { store } = makeStore();
  for (let i = 0; i < MAX_MEMORY_ENTRIES; i += 1) {
    store.remember({ text: `memory-${i}` });
  }
  assert.equal(store.size, MAX_MEMORY_ENTRIES);
  const { evicted } = store.remember({ text: "memory-overflow" });
  assert.equal(evicted, 1, "超限要如实回报淘汰了几条");
  assert.equal(store.size, MAX_MEMORY_ENTRIES);
  assert.ok(store.recall("memory-overflow").length > 0, "新写入的必须在");
});

test("记忆：recall 空查询列出最近的，关键词按正文与标签打分", () => {
  const { store } = makeStore();
  store.remember({ text: "项目用 Node 22", tags: ["project"] });
  store.remember({ text: "用户偏好英文回复", tags: ["preference"] });

  const recent = store.recall("");
  assert.equal(recent.length, 2, "空查询列出全部（在上限内）");

  const byText = store.recall("Node");
  assert.equal(byText[0]?.text, "项目用 Node 22");

  const byTag = store.recall("preference");
  assert.equal(byTag[0]?.text, "用户偏好英文回复");

  assert.equal(store.recall("不存在的词").length, 0);
});

test("记忆：recall 的 limit 被夹到 [1, 50]，非法值回落默认", () => {
  const { store } = makeStore();
  store.remember({ text: "a" });
  store.remember({ text: "b" });
  store.remember({ text: "c" });
  assert.equal(store.recall("", 100).length, 3, "超上限不会报错，只是被夹住");
  assert.equal(store.recall("", 0).length, 1, "0 夹到 1");
  assert.equal(store.recall("", -5).length, 1);
  assert.equal(store.recall("", Number.NaN).length, 3, "NaN 回落默认（5）");
});

test("记忆：forget 按 id 删除，未命中返回 false", () => {
  const { store } = makeStore();
  const { entry } = store.remember({ text: "待删除" });
  assert.equal(store.forget("no-such-id"), false);
  assert.equal(store.forget(entry.id), true);
  assert.equal(store.size, 0);
});

test("记忆：文件里混入损坏行时跳过它，其余仍可读（不整库报废）", () => {
  const dir = tempDir("pi-memory-bad-");
  const file = join(dir, "memory.jsonl");
  const good = JSON.stringify({ id: "g", text: "好的", tags: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  writeFileSync(file, `not json\n${good}\n{"text":""}\n`);
  const store = new MemoryStore({ filePath: file });
  assert.equal(store.size, 1);
  assert.equal(store.list()[0]?.text, "好的");
});

test("记忆：落盘是原子写（写完后不留同目录临时文件）", () => {
  const { store, file } = makeStore();
  store.remember({ text: "原子写" });
  const dir = join(file, "..");
  const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftovers, [], "不应留下临时文件");
  assert.ok(statSync(file).size > 0);
});
