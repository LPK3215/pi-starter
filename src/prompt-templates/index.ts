/**
 * 提示词模板 = SDK 的 prompt templates。
 *
 * `session.prompt("/name")` 会把模板展开后再发给模型。这里只负责选出要交给
 * `additionalPromptTemplatePaths` 的文件。`noPromptTemplates: true` 关掉
 * `~/.pi/agent/prompts` 和项目 `.pi/prompts` 的默认扫描，和技能、扩展同一规矩。
 *
 * 新增模板：`src/prompt-templates/<name>.md`，文件名就是 `/<name>`。
 * 当库用：`buildAgent({ extraPromptTemplatePaths: ["/path/to/dir-or-file.md"] })`。
 * 不要内置示例（`review`）：`buildAgent({ builtinPromptTemplates: false })`。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptTemplate } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MAX_PROMPT_TEMPLATES = 32;
export const MAX_PROMPT_TEMPLATE_BYTES = 64 * 1024;

export type LoadedPromptTemplate = Pick<
  PromptTemplate,
  "name" | "description" | "argumentHint" | "content"
>;

export interface LoadPromptTemplateOptions {
  /** 是否带上包内的 `review`。默认 true。 */
  includeBuiltin?: boolean;
  maxTemplates?: number;
  maxBytes?: number;
  onSkip?: (file: string, reason: string) => void;
}

export function resolvePromptTemplatesDir(): string | undefined {
  const candidates = [
    __dirname,
    join(__dirname, "..", "src", "prompt-templates"),
    join(__dirname, "..", "prompt-templates"),
  ];
  return candidates.find((dir) => existsSync(dir));
}

function markdownFiles(root: string): string[] {
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(root);
  } catch {
    return [];
  }
  if (info.isFile()) return root.endsWith(".md") ? [root] : [];
  if (!info.isDirectory()) return [];
  try {
    return readdirSync(root)
      .filter((name) => name.endsWith(".md"))
      .map((name) => join(root, name));
  } catch {
    return [];
  }
}

/**
 * 交给 SDK 的模板文件路径。目录会展开成一层 `*.md`。
 * 超限的文件不放进列表，这样 SDK 不会把它们读进内存。
 */
export function resolvePromptTemplatePaths(
  extraPaths: readonly string[] = [],
  options: LoadPromptTemplateOptions = {},
): string[] {
  const maxTemplates = options.maxTemplates ?? MAX_PROMPT_TEMPLATES;
  const maxBytes = options.maxBytes ?? MAX_PROMPT_TEMPLATE_BYTES;
  const roots: string[] = [];
  if (options.includeBuiltin !== false) {
    const builtin = resolvePromptTemplatesDir();
    if (builtin) roots.push(builtin);
  }
  roots.push(...extraPaths);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!root) continue;
    for (const file of markdownFiles(root)) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (out.length >= maxTemplates) {
        options.onSkip?.(file, `模板超过 ${maxTemplates} 个`);
        continue;
      }
      try {
        const size = statSync(file).size;
        if (size > maxBytes) {
          options.onSkip?.(file, `超过 ${maxBytes} 字节（${size}）`);
          continue;
        }
      } catch {
        continue;
      }
      out.push(file);
    }
  }
  return out;
}

/**
 * 解析模板，只要名称/说明/正文，供 /prompt-templates 与 capabilities 展示。
 *
 * 真正的 `/name` 展开仍由 SDK 的 `DefaultResourceLoader` 完成（见 `additionalPromptTemplatePaths`）；
 * 这里不能依赖 `loadPromptTemplates`——它不是包的主入口导出（主包只 re-export 了 `PromptTemplate` 类型），
 * 所以清单自行解析 frontmatter，与交给 SDK 的是同一批文件。
 */
export function loadScaffoldPromptTemplates(
  paths: readonly string[],
): LoadedPromptTemplate[] {
  const out: LoadedPromptTemplate[] = [];
  for (const file of paths) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = splitFrontmatter(raw);
    const name = basename(file).replace(/\.md$/, "");
    const description = frontmatter.description ?? firstNonEmptyLine(body) ?? name;
    const template: LoadedPromptTemplate = { name, description, content: body };
    const hint = frontmatter["argument-hint"];
    if (hint) template.argumentHint = hint;
    out.push(template);
  }
  return out;
}

/** Split a leading `---` frontmatter block from the body, parsing flat `key: value` lines. */
function splitFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  const [, block, body] = match;
  const frontmatter: Record<string, string> = {};
  for (const line of (block ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (kv) {
      const key = kv[1]!;
      const value = kv[2]!.trim().replace(/^['"]|['"]$/g, "");
      if (value) frontmatter[key] = value;
    }
  }
  return { frontmatter, body: body ?? "" };
}

/** First non-empty line of the body (used as the description fallback, matching the spec). */
function firstNonEmptyLine(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.replace(/^#+\s*/, "");
  }
  return undefined;
}
