/**
 * pi-starter · 技能层
 *
 * 技能 = Agent Skills 标准的 SKILL.md。加载走 SDK：
 *   DefaultResourceLoader({ noSkills: true, additionalSkillPaths })
 * noSkills 只关掉 ~/.pi 和 <cwd>/.pi 的默认扫描，additionalSkillPaths 仍会加载。
 *
 * 系统提示词目录由 SDK formatSkillsForPrompt 注入（需要 read 在工具列表里）。
 * 模型按 <location> 用内置 read 读 SKILL.md，不要再包一层 read_skill。
 *
 * 新增技能：src/skills/<name>/SKILL.md，重启即可。
 * 当库用：buildAgent({ extraSkillPaths: ["/path/to/skills"] })
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type LoadedSkill = Pick<Skill, "name" | "description" | "filePath" | "baseDir">;

export function resolveSkillsDir(): string | undefined {
  const candidates = [
    __dirname,
    join(__dirname, "..", "src", "skills"),
    join(__dirname, "..", "skills"),
  ];
  return candidates.find((dir) => existsSync(dir));
}

function uniqueExisting(dirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    if (!dir || !existsSync(dir) || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

/** 交给 DefaultResourceLoader.additionalSkillPaths。仓库内置在前，同名时它赢。 */
export function resolveSkillPaths(extraPaths: readonly string[] = []): string[] {
  return uniqueExisting([resolveSkillsDir() ?? "", ...extraPaths]);
}

function loadFromDir(dir: string): LoadedSkill[] {
  const { skills } = loadSkillsFromDir({ dir, source: "path" });
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
  }));
}

/** 按给定目录加载。同名时先出现的赢。不经过 ResourceLoader，给单测和 HTTP 夹具用。 */
export function loadSkillsFromDirs(dirs: readonly string[]): LoadedSkill[] {
  const seen = new Set<string>();
  const out: LoadedSkill[] = [];
  for (const dir of uniqueExisting(dirs)) {
    for (const skill of loadFromDir(dir)) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      out.push(skill);
    }
  }
  return out;
}

/** 脚手架技能目录 + extraSkillPaths。同名时仓库内置优先。 */
export function loadScaffoldSkills(extraPaths: readonly string[] = []): LoadedSkill[] {
  return loadSkillsFromDirs(resolveSkillPaths(extraPaths));
}
