/**
 * 索引容量护栏测试。
 *
 * 没有上限时，索引随对话数无限增长，而每次 upsert 都要全量重写整个 JSON——
 * O(n) 写放大。本项目其它三处无界增长（会话数 / SQL 行数 / 快照消息数）都加了护栏，
 * 索引也必须有，否则「跑久了变慢」会表现为无法定位的性能退化。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { test } from "node:test";
import { MAX_INDEX_ENTRIES, sessionCatalog, type StoredConversation } from "./store.js";
import { tempDir } from "../test-tmp.js";

function fixture(): { dir: string; catalog: ReturnType<typeof sessionCatalog>; sessions: string } {
  const root = tempDir("pi-cap-");
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  const catalog = sessionCatalog(join(root, "index.json"), [sessions], root, {
    maxEntries: 5,
  });
  return { dir: root, catalog, sessions };
}

/** 造一条合法条目（含真实存在的会话文件）。 */
function entry(sessions: string, id: string, updatedAt: number): StoredConversation {
  const file = join(sessions, `2026-10-08T10-00-00_${id}.jsonl`);
  writeFileSync(file, "{}\n");
  return { sessionId: id, sessionFile: file, title: `T${id}`, updatedAt, messageCount: 1 };
}

test("索引：超过上限时淘汰最旧的，且保留最近的", () => {
  const { catalog, sessions } = fixture();
  for (let i = 0; i < 20; i += 1) {
    catalog.upsert(entry(sessions, `s${i}`, 1000 + i));
  }
  const list = catalog.list();
  assert.equal(list.length, 5, "must stay within the cap");
  // 保留的是 updatedAt 最大的 5 条，也就是 s15..s19。
  const ids = list.map((e) => e.sessionId).sort();
  assert.deepEqual(ids, ["s15", "s16", "s17", "s18", "s19"]);
});

test("索引：上限不丢当前这一条（用户最想保住的是最近的对话）", () => {
  const { catalog, sessions } = fixture();
  for (let i = 0; i < 30; i += 1) {
    catalog.upsert(entry(sessions, `s${i}`, 1000 + i));
  }
  const newest = catalog.list().find((e) => e.sessionId === "s29");
  assert.ok(newest, "the just-written entry must survive eviction");
});

test("索引：重复 upsert 同一 id 不增长条目数", () => {
  const { catalog, sessions } = fixture();
  for (let i = 0; i < 10; i += 1) {
    catalog.upsert({ ...entry(sessions, "same", 1000 + i), title: `T${i}` });
  }
  assert.equal(catalog.list().length, 1, "same id must replace, not accumulate");
  assert.equal(catalog.list()[0]?.title, "T9", "latest wins");
});

test("索引：默认上限有值且为正", () => {
  assert.ok(Number.isInteger(MAX_INDEX_ENTRIES) && MAX_INDEX_ENTRIES >= 1);
  assert.ok(MAX_INDEX_ENTRIES <= 5000, "must stay a sane bound");
});

test("索引：读回一个超大的文件也会被截断（不因为读就放行无界数据）", () => {
  const { dir, sessions } = fixture();
  // 手工造一个远超上限的索引文件。
  const indexFile = join(dir, "huge.json");
  const conversations = Array.from({ length: 50 }, (_, i) => {
    const file = join(sessions, `2026-10-08T10-00-00_h${i}.jsonl`);
    writeFileSync(file, "{}\n");
    return { sessionId: `h${i}`, sessionFile: file, title: `H${i}`, updatedAt: 2000 + i, messageCount: 1 };
  });
  writeFileSync(indexFile, JSON.stringify({ version: 1, cwd: dir, conversations }));

  // 用默认上限重新打开（fixture 里的 catalog 用了 maxEntries=5，这里直接用 port）。
  const loaded = sessionCatalog(indexFile, [sessions], dir).list();
  assert.ok(
    loaded.length <= MAX_INDEX_ENTRIES,
    `a hand-enlarged index must be trimmed on load, got ${loaded.length}`,
  );
});
