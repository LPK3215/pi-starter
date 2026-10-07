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
  const paths = resolveSkillPaths([extra, join(root, "missing"), extra]);
  assert.ok(paths.includes(extra));
  assert.equal(paths.filter((item) => item === extra).length, 1);
  assert.ok(!paths.includes(join(root, "missing")));
});
