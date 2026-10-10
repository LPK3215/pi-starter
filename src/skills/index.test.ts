import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadSkillsFromDirs, loadScaffoldSkills, resolveSkillPaths } from "./index.js";
import { tempDir } from "../test-tmp.js";

test("扫描 SKILL.md，同名时先登记的赢", () => {
  const root = tempDir("pi-skills-");
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
  const root = tempDir("pi-skill-path-");
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
  const root = tempDir("pi-skills-big-");
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
  const root = tempDir("pi-skills-many-");
  for (let i = 0; i < 6; i += 1) {
    const dir = join(root, `s${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: s${i}\ndescription: d\n---\n# a\n`);
  }
  assert.equal(loadSkillsFromDirs([root], { maxSkills: 3 }).length, 3);
  assert.equal(resolveSkillPaths([root], { maxSkills: 2 }).length, 2);
});

test("includeBuiltin: false 同时清掉清单与交给 SDK 的路径", () => {
  const extra = tempDir("pi-skills-only-");
  const mine = join(extra, "my-skill");
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, "SKILL.md"), "---\nname: my-skill\ndescription: d\n---\n# mine\n");

  // 默认：内置示例技能 summarize 在清单里。
  assert.ok(loadScaffoldSkills([]).some((s) => s.name === "summarize"), "默认带内置示例");

  // 关掉后清单里只剩业务技能——注意不能只改清单：additionalSkillPaths 不跟着清的话，
  // SDK 照样会把 summarize 写进 <available_skills>，提示词与 /skills 就会漂移。
  assert.deepEqual(loadScaffoldSkills([extra], { includeBuiltin: false }).map((s) => s.name), [
    "my-skill",
  ]);
  const paths = resolveSkillPaths([extra], { includeBuiltin: false });
  assert.deepEqual(paths, [mine], "交给 SDK 的路径里也不能有内置技能目录");
  assert.ok(!paths.some((p) => p.includes("summarize")), "内置技能目录不得进 additionalSkillPaths");

  // 没有额外目录时关掉内置 = 空。
  assert.deepEqual(loadScaffoldSkills([], { includeBuiltin: false }), []);
  assert.deepEqual(resolveSkillPaths([], { includeBuiltin: false }), []);
});
