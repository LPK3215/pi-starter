/**
 * 临时目录助手的回归。
 *
 * 它自己就是「测试不再往 %TEMP% 漏目录」的根据（实测漏到 8528 个目录 / 5.0 GB），
 * 所以这里验的是**真的删掉了**，不是「返回了一个路径」——只断言前者会把漏资源这件事
 * 又变成一句看不见的注释。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDirs, tempDir } from "./test-tmp.js";

test("tempDir 建的目录真实存在，cleanup 连内容一起删掉", () => {
  const dir = tempDir("pi-selftest-");
  assert.ok(existsSync(dir), "tempDir 要真的建出目录");
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "nested", "session.jsonl"), "{}\n", "utf8");

  const failed = cleanupTempDirs();
  assert.deepEqual(failed, [], "不该有清理失败项（有失败会被打印，但这里必须为 0）");
  assert.ok(!existsSync(dir), "目录必须真的消失，而不是只从登记表里去掉");
});

test("没有待清理项时 cleanup 是空操作，不报错也不留下东西", () => {
  assert.deepEqual(cleanupTempDirs(), [], "登记表已空时应直接返回空数组");
});
