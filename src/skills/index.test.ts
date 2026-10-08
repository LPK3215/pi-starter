import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSkillsFromDirs, resolveSkillPaths } from "./index.js";

test("扫描 SKILL.md，同名时先登记的赢", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-skills-"));
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(join(first, "summarize"), { recursive: true });
  mkdirSync(join(second, "summarize"), { recursive: true });
  mkdirSync(join(second, "other"), { recursive: true });
  writeFileSync(
    join(first, "summarize", "SKILL.md"),
    "---\nname: summarize\ndescription: first\n---\n# A\n",
  );
  writeFileSync(
    join(second, "summarize", "SKILL.md"),
    "---\nname: summarize\ndescription: second\n---\n# B\n",
  );
  writeFileSync(
    join(second, "other", "SKILL.md"),
    "---\nname: other\ndescription: extra skill\n---\n# C\n",
  );

  const skills = loadSkillsFromDirs([first, second]);
  const names = skills.map((skill) => skill.name);
  assert.ok(names.includes("summarize"));
  assert.ok(names.includes("other"));
  assert.equal(skills.find((skill) => skill.name === "summarize")?.description, "first");
});

test("resolveSkillPaths 去掉不存在的目录，保持顺序", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-skill-path-"));
  const extra = join(root, "extra");
  mkdirSync(extra);
  // 现在返回的是**技能目录本身**，所以扫描根必须真的含技能。
  const skills = join(extra, "summarize");
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, "SKILL.md"), "---\nname: summarize\ndescription: d\n---\n# x\n");

  const paths = resolveSkillPaths([extra, join(root, "missing"), extra]);
  assert.ok(paths.includes(skills), "the qualifying skill dir must be returned");
  assert.equal(paths.filter((item) => item === skills).length, 1, "no duplicates");
  assert.ok(!paths.includes(join(root, "missing")), "missing dirs are dropped");
});

test("超大 SKILL.md 在读取前就被跳过，且不会进技能清单", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-skills-big-"));
  const small = join(root, "small");
  const big = join(root, "big");
  mkdirSync(small, { recursive: true });
  mkdirSync(big, { recursive: true });
  writeFileSync(join(small, "SKILL.md"), "---\nname: small\ndescription: ok\n---\n# a\n");
  writeFileSync(
    join(big, "SKILL.md"),
    `---\nname: big\ndescription: huge\n---\n${"x".repeat(600 * 1024)}`,
  );

  const skipped: Array<{ dir: string; reason: string }> = [];
  const opts = { onSkip: (dir: string, reason: string) => skipped.push({ dir, reason }) };

  // 1) 交给 SDK 的路径里不能有超大的那个——否则 SDK 会把它整个读进内存。
  const paths = resolveSkillPaths([root], opts);
  assert.ok(paths.includes(small), "normal skill passes");
  assert.ok(!paths.includes(big), "oversized skill must not reach the SDK");
  assert.ok(skipped.some((s) => s.dir === big && /超过/.test(s.reason)), "skip is reported");

  // 2) 清单与系统提示词必须一致：这里同样看不到超大的技能。
  const names = loadSkillsFromDirs([root]).map((s) => s.name);
  assert.ok(names.includes("small"));
  assert.ok(!names.includes("big"), "oversized skill must not appear in the inventory");
});

test("技能数量超上限时截断，且不报错", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-skills-many-"));
  for (let i = 0; i < 6; i += 1) {
    const dir = join(root, `s${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: s${i}\ndescription: d\n---\n# a\n`);
  }
  assert.equal(loadSkillsFromDirs([root], { maxSkills: 3 }).length, 3);
  assert.equal(resolveSkillPaths([root], { maxSkills: 2 }).length, 2);
});
