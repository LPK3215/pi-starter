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

import { existsSync, readdirSync, statSync } from "node:fs";
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

/**
 * Caps applied while loading skills.
 *
 * The SDK's skill loader has no ceiling, and every skill's name/description lands in the
 * system prompt. A runaway directory would therefore inflate every single request.
 */
export const MAX_SKILL_PATHS = 32;
export const MAX_SKILLS = 200;
/**
 * 单个 `SKILL.md` 的大小上限。
 *
 * SDK 会把每个 SKILL.md **完整读进内存**才解析 frontmatter，而它自己没有任何上限。
 * 200 个技能 × 大文件足以把一个本地进程压垮，所以在交给 SDK **之前**用 stat 拦掉。
 * （正文其实不会进系统提示词——只有 frontmatter 的 name/description 会——但内存照样吃。）
 */
export const MAX_SKILL_BYTES = 256 * 1024;

export interface LoadSkillsOptions {
  /** Max skill directories to scan. Default MAX_SKILL_PATHS. */
  maxPaths?: number;
  /** Max skills kept overall. Default MAX_SKILLS. */
  maxSkills?: number;
  /** Skip SKILL.md files larger than this (bytes). Default MAX_SKILL_BYTES. */
  maxBytes?: number;
  /** Report skipped skills (defaults, tests). */
  onSkip?: (skillDir: string, reason: string) => void;
}

function uniqueExisting(dirs: readonly string[], maxPaths = MAX_SKILL_PATHS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    if (!dir || !existsSync(dir) || seen.has(dir)) continue;
    if (out.length >= maxPaths) break;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

/** A directory is a skill iff it holds a SKILL.md. */
function isSkillDir(dir: string): boolean {
  try {
    return statSync(join(dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

/**
 * 列出某个扫描根目录下的技能目录，范围与 SDK 一致：目录自身，或它的一层子目录。
 *
 * SDK 的 `loadSkillsFromDir` 正是这个范围，所以枚举它不会漏技能、也不会多算。
 */
export function enumerateSkillDirs(dir: string): string[] {
  if (isSkillDir(dir)) return [dir];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(dir, entry.name))
      .filter((child) => isSkillDir(child));
  } catch {
    return [];
  }
}

/** 展开成合格技能目录，并施加大小门——在 SDK 读取任何文件之前完成。 */
function collectSkillDirs(
  roots: readonly string[],
  options: LoadSkillsOptions,
): { ok: string[]; skipped: number } {
  const maxBytes = options.maxBytes ?? MAX_SKILL_BYTES;
  const maxSkills = options.maxSkills ?? MAX_SKILLS;
  const ok: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const root of roots) {
    for (const skillDir of enumerateSkillDirs(root)) {
      if (seen.has(skillDir)) continue;
      seen.add(skillDir);
      if (ok.length >= maxSkills) {
        skipped += 1;
        options.onSkip?.(skillDir, `技能总数超过 ${maxSkills} 上限`);
        continue;
      }
      try {
        const size = statSync(join(skillDir, "SKILL.md")).size;
        if (size > maxBytes) {
          skipped += 1;
          options.onSkip?.(skillDir, `SKILL.md 超过 ${maxBytes} 字节上限（${size}）`);
          continue;
        }
      } catch {
        skipped += 1;
        continue;
      }
      ok.push(skillDir);
    }
  }
  return { ok, skipped };
}

/**
 * 交给 `DefaultResourceLoader.additionalSkillPaths` 的路径。
 *
 * 返回**每个技能自己的目录**，而不是它们的父目录。这有两个原因：
 *   1. 只有这种粒度才能在 SDK 读取前按大小过滤——父目录会让 SDK 无差别读满所有 SKILL.md；
 *   2. 实测确认 SDK 接受单个技能目录（`additionalSkillPaths: [<skillDir>]` 能正常加载）。
 * 因此这里过滤掉的大小、技能上限对系统提示词是真实生效的，与 `/skills` 清单保持一致。
 */
export function resolveSkillPaths(
  extraPaths: readonly string[] = [],
  options: LoadSkillsOptions = {},
): string[] {
  const roots = uniqueExisting(
    [resolveSkillsDir() ?? "", ...extraPaths],
    options.maxPaths ?? MAX_SKILL_PATHS,
  );
  return collectSkillDirs(roots, options).ok;
}

function loadFromSkillDir(skillDir: string): LoadedSkill[] {
  const { skills } = loadSkillsFromDir({ dir: skillDir, source: "path" });
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
  }));
}

/** 按给定目录加载。同名时先出现的赢。不经过 ResourceLoader，给单测和 HTTP 夹具用。 */
export function loadSkillsFromDirs(
  dirs: readonly string[],
  options: LoadSkillsOptions = {},
): LoadedSkill[] {
  const roots = uniqueExisting(dirs, options.maxPaths ?? MAX_SKILL_PATHS);
  const { ok } = collectSkillDirs(roots, options);
  const seen = new Set<string>();
  const out: LoadedSkill[] = [];
  for (const skillDir of ok) {
    for (const skill of loadFromSkillDir(skillDir)) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      out.push(skill);
    }
  }
  return out;
}

/** 脚手架技能目录 + extraSkillPaths。同名时仓库内置优先。 */
export function loadScaffoldSkills(
  extraPaths: readonly string[] = [],
  options: LoadSkillsOptions = {},
): LoadedSkill[] {
  return loadSkillsFromDirs(resolveSkillPaths(extraPaths, options), options);
}
