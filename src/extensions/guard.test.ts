import assert from "node:assert/strict";
import { test } from "node:test";
import { findDangerousBash, isPathInsideCwd } from "./guard.js";

test("危险 bash 命中常见破坏性命令，放过普通命令", () => {
  assert.equal(findDangerousBash("rm -rf /")?.id, "rm-rf");
  assert.equal(findDangerousBash("sudo rm -fr /tmp/x")?.id, "rm-rf");
  assert.equal(findDangerousBash("rm -r /tmp")?.id, undefined);
  assert.equal(findDangerousBash("mkfs.ext4 /dev/sda1")?.id, "mkfs");
  assert.equal(findDangerousBash("dd if=/dev/zero of=/dev/sda")?.id, "dd");
  assert.equal(findDangerousBash("Remove-Item -Recurse C:\\temp")?.id, "windows-destructive");
  assert.equal(findDangerousBash("echo hello"), undefined);
  assert.equal(findDangerousBash("ls -la"), undefined);
});

test("路径必须落在 cwd 内，跨目录和绝对路径越界被拦", () => {
  const cwd = process.cwd();
  assert.equal(isPathInsideCwd("src/agent.ts", cwd), true);
  assert.equal(isPathInsideCwd(".", cwd), true);
  assert.equal(isPathInsideCwd("../secret", cwd), false);
  assert.equal(isPathInsideCwd("src/../../secret", cwd), false);
});
