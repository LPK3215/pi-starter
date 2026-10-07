import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isReadOnlySql, openDatabase } from "./index.js";

test("isReadOnlySql 只放过单条 SELECT / WITH", () => {
  assert.equal(isReadOnlySql("SELECT 1"), true);
  assert.equal(isReadOnlySql("  with x as (select 1) select * from x  "), true);
  assert.equal(isReadOnlySql("SELECT 1; SELECT 2"), false);
  assert.equal(isReadOnlySql("INSERT INTO notes (title, body) VALUES ('a','b')"), false);
  assert.equal(isReadOnlySql("DROP TABLE notes"), false);
  assert.equal(isReadOnlySql("PRAGMA table_info(notes)"), false);
  assert.equal(isReadOnlySql("SELECT 1; DELETE FROM notes"), false);
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

    assert.throws(() => db.query("DELETE FROM notes"), /只允许单条 SELECT/);
  } finally {
    db.close();
  }
});

test("文件库能连上并读回写入的行", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-db-"));
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
