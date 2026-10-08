/**
 * 内置示例内容的设置开关：读、改、落盘、再读回来。
 *
 * 这两个字段的价值在于「业务方接自己的知识库/技能后能关掉示例」——而它们是**装配期**
 * 生效的（写进系统提示词），所以真正要证明的不是「patch 成功」，而是「落盘的值
 * 真的会在下次组装时被读走」。后者由 `scripts/e2e-restart.mjs` 端到端覆盖。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SettingsService, fileSettingsPort, SETTINGS_DEFAULTS } from "./settings.js";

function makeService(): { svc: SettingsService; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-builtin-"));
  const file = join(dir, "settings.json");
  const svc = new SettingsService(fileSettingsPort(file));
  return { svc, file };
}

test("设置：内置示例内容默认开启（示例对零嵌入方有用）", () => {
  const { svc } = makeService();
  const s = svc.get();
  assert.equal(s.builtinKnowledge, true);
  assert.equal(s.builtinSkills, true);
  assert.equal(SETTINGS_DEFAULTS.builtinKnowledge, true, "默认值本身也要一致");
});

test("设置：可关掉内置示例内容，且立刻反映在get() 上", () => {
  const { svc } = makeService();
  const after = svc.patch({ builtinKnowledge: false, builtinSkills: false });
  assert.equal(after.builtinKnowledge, false);
  assert.equal(after.builtinSkills, false);
  assert.equal(svc.get().builtinKnowledge, false, "get() 必须是当前值而不是默认值");
  assert.equal(svc.get().builtinSkills, false);
});

test("设置：只改一个不影响另一个（不能连带把另一个也关掉）", () => {
  const { svc } = makeService();
  svc.patch({ builtinKnowledge: false });
  const s = svc.get();
  assert.equal(s.builtinKnowledge, false);
  assert.equal(s.builtinSkills, true, "未提及的字段必须保持原值");
});

test("设置：内置示例内容开关会落盘，重建service 后仍在", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-builtin-"));
  const file = join(dir, "settings.json");
  new SettingsService(fileSettingsPort(file)).patch({ builtinKnowledge: false, builtinSkills: false });

  // 真从磁盘重建，而不是复用同一个实例——复用会掩盖「没写进去」这种失败
  const reloaded = new SettingsService(fileSettingsPort(file));
  assert.equal(reloaded.get().builtinKnowledge, false);
  assert.equal(reloaded.get().builtinSkills, false);

  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.equal(raw.builtinKnowledge, false, "必须是显式的 false，不能靠缺省表达");
  assert.equal(raw.builtinSkills, false);
});

test("设置：内置示例内容开关拒绝非布尔值（静默忽略比报错更糟）", () => {
  const { svc } = makeService();
  assert.throws(() => svc.patch({ builtinKnowledge: "off" as never }), /builtinKnowledge/);
  assert.throws(() => svc.patch({ builtinSkills: 1 as never }), /builtinSkills/);
  assert.equal(svc.get().builtinKnowledge, true, "被拒的patch 不能留下半成品");
  assert.equal(svc.get().builtinSkills, true);
});
