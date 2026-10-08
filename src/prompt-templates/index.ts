/**
 * 提示词模板 = SDK 的 prompt templates。
 *
 * `session.prompt("/name")` 会把模板展开后再发给模型。这里只负责选出要交给
 * `additionalPromptTemplatePaths` 的文件。`noPromptTemplates: true` 关掉
 * `~/.pi/agent/prompts` 和项目 `.pi/prompts` 的默认扫描，和技能、扩展同一规矩。
 *
 * 清单不再自行解析 frontmatter：交给 SDK 的 `DefaultResourceLoader.getPrompts()` 从同一批
 * `additionalPromptTemplatePaths` 直接拿回 `PromptTemplate[]`（名称/说明/正文），与每会话装载器
 * 能展开的那批完全一致——单一真源，清单与可展开命令不可能漂移。
 *
 * 新增模板：`src/prompt-templates/<name>.md`，文件名就是 `/<name>`。
 * 当库用：`buildAgent({ extraPromptTemplatePaths: ["/path/to/dir-or-file.md"] })`。
 * 不要内置示例（`review`）：`buildAgent({ builtinPromptTemplates: false })`。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  getAgentDir,
  type PromptTemplate,
} from "@earendil-works/pi-coding-agent";

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
 * 交给 SDK 装载器读取模板清单（名称/说明/正文），供 /prompt-templates 与 capabilities 展示。
 *
 * 走官方 `DefaultResourceLoader.getPrompts()`——不自己解析 frontmatter。用只加载模板的最小
 * 装载器（不跑扩展工厂、不联网、不调模型）；路径就是随后交给每会话装载器的同一批。
 */
export async function loadScaffoldPromptTemplates(
  paths: readonly string[],
  cwd: string = process.cwd(),
): Promise<LoadedPromptTemplate[]> {
  if (paths.length === 0) return [];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    additionalPromptTemplatePaths: [...paths],
    extensionFactories: [],
  });
  await loader.reload();
  return loader.getPrompts().prompts.map((item) => ({
    name: item.name,
    description: item.description,
    ...(item.argumentHint !== undefined ? { argumentHint: item.argumentHint } : {}),
    content: item.content,
  }));
}
