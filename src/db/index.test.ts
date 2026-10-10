import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { isReadOnlySql, openDatabase, scanReadOnlySql, MAX_SQL_LENGTH } from "./index.js";
import { tempDir } from "../test-tmp.js";

test("isReadOnlySql 只放过单条 SELECT / WITH", () => {
  assert.equal(isReadOnlySql("SELECT 1"), true);
  assert.equal(isReadOnlySql("  with x as (select 1) select * from x  "), true);
  assert.equal(isReadOnlySql("SELECT 1; SELECT 2"), false);
  assert.equal(isReadOnlySql("INSERT INTO notes (title, body) VALUES ('a','b')"), false);
  assert.equal(isReadOnlySql("DROP TABLE notes"), false);
  assert.equal(isReadOnlySql("PRAGMA table_info(notes)"), false);
  assert.equal(isReadOnlySql("SELECT 1; DELETE FROM notes"), false);
});

/**
 * 回归：改造前的 `/^(with|select)/i` 开头匹配可被 CTE 内写入绕过。
 * 断言的是**校验器本身**必须拒绝，而不是依赖 SQLite 兜底报错。
 */
test("只读校验拦得住 CTE 内藏的写操作（旧实现会放过）", () => {
  const attacks = [
    "WITH x AS (DELETE FROM notes RETURNING *) SELECT * FROM x",
    "WITH x AS (UPDATE notes SET body='p' RETURNING *) SELECT * FROM x",
    "WITH x AS (INSERT INTO notes(title,body) VALUES('a','b') RETURNING *) SELECT * FROM x",
    "WITH x AS (PRAGMA writable_schema=ON) SELECT 1",
    "WITH x AS (DROP TABLE notes RETURNING *) SELECT * FROM x",
  ];
  for (const sql of attacks) {
    assert.equal(isReadOnlySql(sql), false, `must reject: ${sql}`);
  }
});

test("只读校验不被注释/字符串字面量绕过", () => {
  // 关键字只出现在注释或字符串里 → 语句本身仍是只读，应放行
  assert.equal(isReadOnlySql("SELECT 1 /* DELETE FROM notes */"), true);
  assert.equal(isReadOnlySql("SELECT 'DROP TABLE notes' AS s"), true);
  assert.equal(isReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x WHERE s='DELETE'"), true);
  // 但注释里藏第二条语句 → 必须拒绝
  assert.equal(isReadOnlySql("SELECT 1; DELETE FROM notes /* c */"), false);
});

test("语法不完整（未闭合注释/引号）一律拒绝而非放行", () => {
  assert.equal(isReadOnlySql("SELECT 1 /* unterminated"), false);
  assert.equal(isReadOnlySql("SELECT 'unterminated"), false);
  assert.equal(isReadOnlySql(""), false);
  assert.equal(isReadOnlySql("   "), false);
  // 正常的多行/带注释查询仍放行
  assert.equal(isReadOnlySql("SELECT 1 /* ; */"), true);
  assert.equal(isReadOnlySql("\n\n  SELECT 1  \n"), true);
});

test("超长 SQL 被拒（避免超长输入成为攻击面）", () => {
  const huge = `SELECT ${"a,".repeat(MAX_SQL_LENGTH)}1`;
  assert.equal(isReadOnlySql(huge), false);
  assert.match(scanReadOnlySql(huge).reason ?? "", /上限/);
});

test("拒绝时给出可操作的具体原因，而非统一文案", () => {
  // 模型据此自我纠正，比「非法 SQL」有用得多
  assert.match(scanReadOnlySql("DELETE FROM notes").reason ?? "", /SELECT 或 WITH/);
  assert.match(
    scanReadOnlySql("WITH x AS (DELETE FROM notes RETURNING *) SELECT * FROM x").reason ?? "",
    /DELETE/,
  );
  assert.match(scanReadOnlySql("SELECT 1; SELECT 2").reason ?? "", /单条语句/);
  assert.equal(scanReadOnlySql("SELECT 1").reason, null);
});

test("query 结果受行数上限保护，并如实报告截断", () => {
  const db = openDatabase({ seed: true, maxRows: 10 });
  try {
    for (let i = 0; i < 25; i += 1) db.insertNote({ title: `t${i}`, body: "b" });
    const result = db.query("SELECT id, title FROM notes");
    assert.equal(result.rows.length, 10, "must cap returned rows");
    assert.equal(result.truncated, true);
    assert.equal(result.totalRows, 27, "must report the true total");
  } finally {
    db.close();
  }
});

test("未超上限时 truncated=false，不做无谓提示", () => {
  const db = openDatabase({ seed: true });
  try {
    const result = db.query("SELECT id FROM notes");
    assert.equal(result.truncated, false);
    assert.equal(result.totalRows, result.rows.length);
  } finally {
    db.close();
  }
});

test("内存库能探活、读种子、按关键词搜、拒绝写 SQL", () => {
  const db = openDatabase({ seed: true });
  try {
    const ping = db.ping();
    assert.equal(ping.ok, true);
    assert.equal(ping.driver, "sqlite");
    assert.equal(ping.path, ":memory:");

    const notes = db.listNotes();
    assert.ok(notes.length >= 2);
    assert.equal(notes[0]?.title, "welcome");

    const hits = db.searchNotes("additionalSkillPaths");
    assert.equal(hits[0]?.title, "skills");

    const created = db.insertNote({ title: "fixture", body: "虚拟数据" });
    assert.equal(db.getNote(created.id)?.body, "虚拟数据");

    const queried = db.query("SELECT title FROM notes WHERE title = ?", ["fixture"]);
    assert.deepEqual(queried.rows, [{ title: "fixture" }]);

    assert.throws(() => db.query("DELETE FROM notes"), /只允许以 SELECT 或 WITH 开头/);
  } finally {
    db.close();
  }
});

test("文件库能连上并读回写入的行", () => {
  const dir = tempDir("pi-db-");
  const path = join(dir, "app.db");
  const db = openDatabase({ path, seed: false });
  try {
    db.insertNote({ title: "disk", body: "落盘" });
    assert.equal(db.ping().path, path);
    assert.equal(db.listNotes()[0]?.title, "disk");
  } finally {
    db.close();
  }

  const again = openDatabase({ path, seed: false });
  try {
    assert.equal(again.listNotes()[0]?.body, "落盘");
  } finally {
    again.close();
  }
});
