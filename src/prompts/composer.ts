/**
 * pi-starter · 系统提示词组合引擎（prompt composer）
 *
 * pi-web-ui 的 prompt-composer 把 SDK 组装的各来源暴露成 {{token}}，让用户自由组合。
 * 本方案保留这个思路，但**收窄到脚手架真实拥有的层**：
 *   {{persona}} {{rules}} {{tools}} {{knowledge}} {{skills}} {{cwd}} {{append}} {{context}}
 *
 * 关键设计（相对 pi-web-ui 的简化）：
 *   1. 纯函数引擎，无 IO、无 SDK 依赖，可单测；
 *   2. **未自定义模板时零开销**：直接按默认顺序拼接，等价于改造前 agent.ts 的行为，
 *      不引入任何额外字符串处理；
 *   3. 占位符语义分两类：
 *      - **已知层**（DEFAULT_PROMPT_ORDER 内）缺失 → 渲染为空串，绝不把 `{{tools}}`
 *        这类字面量漏进系统提示词；
 *      - **未知 token** → 原样保留，方便用户发现自己写错的占位符。
 */

/** 可注入的提示词层。缺省层按空串处理。 */
export interface PromptLayers {
  /** 人设：prompts/persona.md */
  persona: string;
  /** 工作规则：prompts/rules.md */
  rules: string;
  /** 工具清单摘要（可选，默认空——工具信息已由 SDK 注入）。 */
  tools?: string;
  /** 知识库目录：formatKnowledgeCatalog() */
  knowledge?: string;
  /** 技能目录摘要（可选）。 */
  skills?: string;
  /** 工作目录。 */
  cwd?: string;
  /** 业务追加段（垂直 Agent 注入领域规则）。 */
  append?: string;
  /** 动态上下文（如用户偏好、会话记忆）。 */
  context?: string;
}

/** 默认拼接顺序（等价于改造前的 persona + rules + knowledge）。
 * 注意：`skills` 不在默认顺序里——技能目录由 SDK 的 `buildSystemPrompt` 以 `<available_skills>`
 * 追加（见 A1），这里再拼一份就会出现两份清单。`{{skills}}` 仍是**已知** token（渲染为空），
 * 仅为兼容旧模板不报错，不再作为清单注入点。 */
export const DEFAULT_PROMPT_ORDER = ["persona", "rules", "append", "tools", "knowledge", "context"] as const;

/** 引擎认识的全部层 token（含不在默认顺序里的 skills / cwd），供 renderToken 与 unknownTokens 共用。 */
export const PROMPT_LAYER_KEYS = [
  "persona",
  "rules",
  "tools",
  "knowledge",
  "skills",
  "cwd",
  "append",
  "context",
] as const;

/** 引擎认识的 token 集合。已知层缺失渲染空串；未知 token 原样保留。 */
const KNOWN_TOKENS: ReadonlySet<string> = new Set<string>(PROMPT_LAYER_KEYS);

/** 默认模板：按 DEFAULT_PROMPT_ORDER 用空行连接。 */
export function defaultPromptTemplate(): string {
  return DEFAULT_PROMPT_ORDER.map((key) => `{{${key}}}`).join("\n\n");
}

const TOKEN_RE = /\{\{(\w+)\}\}/g;

/**
 * 渲染单个 token：
 *   - 已知层 → 取该层值（缺失即空串）；
 *   - 未知 token → 原样保留。
 */
export function renderToken(name: string, layers: PromptLayers): string {
  if (!KNOWN_TOKENS.has(name)) return `{{${name}}}`;
  const value = (layers as unknown as Record<string, unknown>)[name];
  return typeof value === "string" ? value : "";
}

/**
 * 用模板渲染提示词。
 * 渲染后按空行分段，丢弃空段，避免出现连续空行。
 */
export function composePrompt(template: string, layers: PromptLayers): string {
  const rendered = template.replace(TOKEN_RE, (_match, name: string) => renderToken(name, layers));
  return rendered
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 从层直接组装（不自定义模板）。
 * 这是 agent.ts 的默认路径，零额外处理。
 */
export function composeFromLayers(layers: PromptLayers): string {
  return composePrompt(defaultPromptTemplate(), layers);
}

/** 校验模板里的 token 是否都被支持（返回未知 token 列表）。 */
export function unknownTokens(
  template: string,
  allowed: readonly string[] = PROMPT_LAYER_KEYS,
): string[] {
  const allowedSet = new Set<string>(allowed);
  const unknown: string[] = [];
  for (const match of template.matchAll(TOKEN_RE)) {
    const name = match[1];
    if (name && !allowedSet.has(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}
