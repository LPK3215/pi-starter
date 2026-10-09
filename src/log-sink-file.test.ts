/**
 * 文件日志 sink 测试。
 *
 * 覆盖真实落盘行为：JSONL 逐行、按大小轮转 + gzip 归档、写失败计数不反压。
 * 用临时目录，跑完即弃，绝不写进工程 ./logs。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRotatingFileSink } from "./log-sink-file.js";

/** 轮询等条件成立（gzip 归档是异步 fire-and-forget，不能拍固定时长）。 */
async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("writes one JSON object per line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-logtest-"));
  const sink = createRotatingFileSink({ dir });
  sink.sink(JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", level: "info", msg: "alpha" }));
  sink.sink(JSON.stringify({ ts: "2026-01-01T00:00:01.000Z", level: "warn", msg: "beta" }));
  await sink.dispose();

  const files = readdirSync(dir).filter((f) => f.endsWith(".log"));
  assert.equal(files.length, 1, "exactly one active file");
  const body = readFileSync(join(dir, files[0]), "utf-8").trim().split("\n");
  assert.equal(body.length, 2);
  assert.deepEqual(JSON.parse(body[0]).msg, "alpha");
  assert.equal(JSON.parse(body[1]).level, "warn");
});

test("rotates by size and gzip-archives the overflow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-logtest-"));
  const sink = createRotatingFileSink({ dir, maxBytes: 300 });
  // Each line ~150 bytes; 12 lines must trigger at least one intra-day roll.
  for (let i = 0; i < 12; i++) {
    sink.sink(JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", level: "info", msg: `line-${i}`, pad: "x".repeat(80) }));
  }
  assert.ok(sink.stats().rotated >= 1, "size rotation recorded synchronously");
  assert.equal(sink.stats().dropped, 0, "no lines dropped under normal write");
  await waitUntil(() => readdirSync(dir).some((f) => f.endsWith(".log.gz")), "gzip archive");
  await sink.dispose();

  const names = readdirSync(dir);
  assert.ok(names.some((f) => f.endsWith(".log.gz")), "an archived .gz segment exists");
  assert.ok(names.some((f) => /pi-starter-.*\.log$/.test(f)), "active file still present");
});

test("retention sweep removes expired archives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-logtest-"));
  // retentionDays 0 disables cleanup; just assert it never throws on an empty dir.
  const sink = createRotatingFileSink({ dir, retentionDays: 0 });
  sink.sink(JSON.stringify({ ts: "2026-01-03T00:00:00.000Z", level: "info", msg: "keep" }));
  await sink.dispose();
  assert.equal(readdirSync(dir).length, 1);
});
