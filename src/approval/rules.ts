/**
 * pi-starter · 审批规则引擎
 *
 * 把「高危工具调用要不要问人」从硬编码正则升级成**声明式规则库**：
 *   - 规则自顶向下匹配，首个命中即生效（与 pi-web-ui 的 ApprovalRulesStore 同语义）；
 *   - 内置 10 项高危检测转成 builtin:true 的默认规则，可被用户规则覆盖；
 *   - 规则库可持久化成 JSON，也可纯内存用（测试 / 库嵌入）。
 *
 * 相对 pi-web-ui 的改进：
 *   1. pi-web-ui 的规则字段 tools×field×match 三轴，本方案保持一致但**收窄到脚手架场景**：
 *      去掉插件档位（plugin:<id>），新增 capability 匹配——因为脚手架的工具是数据驱动的，
 *      按能力标签（fs.write / shell）匹配比按工具名更稳，新工具自动纳入策略。
 *   2. 评估是**纯函数**（evaluateRules），不依赖 store / 文件 / 网络，可直接单测。
 */

import { isPathInsideCwd } from "../extensions/guard.js";

/** 规则命中后的动作。 */
export type ApprovalAction = "allow" | "deny" | "ask";

/** 规则匹配的字段。 */
export type ApprovalField = "command" | "path" | "params";

/** 匹配方式。 */
export type ApprovalMatch =
  | { kind: "regex"; value: string }
  | { kind: "glob"; value: string }
  | { kind: "contains"; value: string }
  | { kind: "prefix"; value: string }
  | { kind: "outside_workspace" }
  | { kind: "capability"; value: string };

export interface ApprovalRule {
  /** 稳定 id，用户规则与内置规则共用一个命名空间。 */
  id: string;
  description: string;
  /** 命中的工具：`*` 表示全部，也可写多个工具名。 */
  tools: string[] | "*";
  field: ApprovalField;
  match: ApprovalMatch;
  action: ApprovalAction;
  /** 内置规则标记：用户可覆盖，但 UI 会标注为「系统预置」。 */
  builtin?: boolean;
}

/** 规则评估的输入。 */
export interface ApprovalInput {
  toolName: string;
  /** 工具入参（原始 JSON）。 */
  args: Record<string, unknown>;
  /** 工作目录，用于 outside_workspace 判定。 */
  cwd: string;
  /** 工具的能力标签（由注册表提供），用于 capability 匹配。 */
  capabilities?: readonly string[];
}

/** 规则评估结果。 */
export interface ApprovalVerdict {
  action: ApprovalAction;
  ruleId: string;
  reason: string;
  /** 触发字段的文本摘录，供 UI 展示。 */
  preview: string;
}

/* ────────────────────────── 内置高危规则 ────────────────────────── */

const BUILTIN_RULES: ApprovalRule[] = [
  {
    id: "builtin:bash.rm-rf",
    description: "Recursive force delete (rm -rf)",
    tools: ["bash"],
    field: "command",
    match: {
      kind: "regex",
      value: "\\brm\\s+-(?=[a-zA-Z]*r)(?=[a-zA-Z]*f)[a-zA-Z]+\\b|\\brm\\s+--recursive\\b",
    },
    action: "ask",
    builtin: true,
  },
  {
    id: "builtin:bash.mkfs",
    description: "Disk format (mkfs)",
    tools: ["bash"],
    field: "command",
    match: { kind: "regex", value: "\\bmkfs(\\.\\w+)?\\b" },
    action: "deny",
    builtin: true,
  },
  {
    id: "builtin:bash.dd",
    description: "Raw device write (dd of=)",
    tools: ["bash"],
    field: "command",
    match: { kind: "regex", value: "\\bdd\\b[\\s\\S]*\\bof\\s*=" },
    action: "deny",
    builtin: true,
  },
  {
    id: "builtin:bash.fork-bomb",
    description: "Fork bomb",
    tools: ["bash"],
    field: "command",
    match: { kind: "regex", value: ":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;" },
    action: "deny",
    builtin: true,
  },
  {
    id: "builtin:bash.shutdown",
    description: "Shutdown / reboot",
    tools: ["bash"],
    field: "command",
    match: { kind: "regex", value: "\\b(shutdown|reboot|halt|poweroff)\\b" },
    action: "deny",
    builtin: true,
  },
  {
    id: "builtin:bash.windows-destructive",
    description: "Windows destructive delete / format",
    tools: ["bash"],
    field: "command",
    match: {
      kind: "regex",
      value:
        "\\bRemove-Item\\b[\\s\\S]*-(Recurse|Force)\\b|\\bdel\\s+/s\\b|\\brd\\s+/s\\b|\\bformat\\s+[a-z]:",
    },
    action: "ask",
    builtin: true,
  },
  {
    id: "builtin:bash.git-destructive",
    description: "Destructive git (reset --hard / push --force / clean -fd)",
    tools: ["bash"],
    field: "command",
    match: {
      kind: "regex",
      value: "\\bgit\\s+reset\\s+--hard\\b|\\bgit\\s+push\\b[\\s\\S]*--force\\b|\\bgit\\s+clean\\s+-[a-z]*f",
    },
    action: "ask",
    builtin: true,
  },
  {
    id: "builtin:bash.chmod-recursive",
    description: "Recursive chmod (chmod -R / 777)",
    tools: ["bash"],
    field: "command",
    match: { kind: "regex", value: "\\bchmod\\s+-R\\b|\\bchmod\\s+777\\b" },
    action: "ask",
    builtin: true,
  },
  {
    id: "builtin:path.outside-workspace-write",
    description: "Write outside workspace",
    tools: ["write", "edit"],
    field: "path",
    match: { kind: "outside_workspace" },
    action: "ask",
    builtin: true,
  },
  {
    id: "builtin:secret.access",
    description: "Secret / credential file access (.env / .ssh / id_rsa / credentials)",
    tools: "*",
    field: "params",
    match: { kind: "regex", value: "(\\.env\\b|\\.ssh\\b|id_rsa|credentials|\\.pem\\b|auth\\.json)" },
    action: "ask",
    builtin: true,
  },
];

/** 内置规则（只读副本，供 store 合并与 UI 展示）。 */
export function builtinApprovalRules(): ApprovalRule[] {
  return BUILTIN_RULES.map((rule) => ({ ...rule, tools: cloneTools(rule.tools) }));
}

function cloneTools(tools: ApprovalRule["tools"]): ApprovalRule["tools"] {
  return tools === "*" ? "*" : [...tools];
}

/* ────────────────────────── 匹配实现 ────────────────────────── */

const PATH_KEYS = ["path", "file_path", "file"] as const;

/** 从工具入参里抽出目标路径（认 path / file_path / file 三种写法）。 */
export function extractTargetPath(args: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** 把入参序列化成可匹配的文本（field=params 用）。 */
function paramsText(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** 规则 tools 是否覆盖该工具。 */
export function ruleMatchesTool(rule: ApprovalRule, toolName: string): boolean {
  return rule.tools === "*" || rule.tools.includes(toolName);
}

/** 规则 match 是否命中给定文本 / 输入。 */
export function ruleMatches(rule: ApprovalRule, input: ApprovalInput): boolean {
  if (!ruleMatchesTool(rule, input.toolName)) return false;

  if (rule.match.kind === "capability") {
    return (input.capabilities ?? []).includes(rule.match.value);
  }

  if (rule.match.kind === "outside_workspace") {
    const target = extractTargetPath(input.args);
    if (!target) return false;
    return !isPathInsideCwd(target, input.cwd);
  }

  const text =
    rule.field === "command"
      ? typeof input.args.command === "string"
        ? input.args.command
        : ""
      : rule.field === "path"
        ? (extractTargetPath(input.args) ?? "")
        : paramsText(input.args);

  if (!text) return false;

  switch (rule.match.kind) {
    case "regex":
      try {
        return new RegExp(rule.match.value, "i").test(text);
      } catch {
        return false; // 用户规则写坏正则 → 视为不命中，不影响其它规则
      }
    case "glob":
      return globToRegExp(rule.match.value).test(text);
    case "contains":
      return text.toLowerCase().includes(rule.match.value.toLowerCase());
    case "prefix":
      return text.toLowerCase().startsWith(rule.match.value.toLowerCase());
  }
}

/**
 * 自顶向下评估规则库，返回首个命中；无命中返回 null（由调用方按默认策略决定）。
 * 纯函数：同样的 (rules, input) 必然得到同样的结果。
 */
export function evaluateRules(
  rules: readonly ApprovalRule[],
  input: ApprovalInput,
): ApprovalVerdict | null {
  for (const rule of rules) {
    if (ruleMatches(rule, input)) {
      return {
        action: rule.action,
        ruleId: rule.id,
        reason: rule.description,
        preview: previewFor(rule, input),
      };
    }
  }
  return null;
}

function previewFor(rule: ApprovalRule, input: ApprovalInput): string {
  if (rule.field === "command" && typeof input.args.command === "string") {
    return truncate(input.args.command);
  }
  if (rule.field === "path") {
    return truncate(extractTargetPath(input.args) ?? "");
  }
  return truncate(paramsText(input.args));
}

function truncate(text: string, limit = 200): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/* ────────────────────────── 规则库（可持久化） ────────────────────────── */

export interface ApprovalRulesStoreOptions {
  /** 用户自定义规则（自顶向下，排在内置之前，便于覆盖）。 */
  userRules?: readonly ApprovalRule[];
  /** 是否附带内置规则。默认 true。 */
  includeBuiltin?: boolean;
}

/**
 * 规则库：合并「用户规则 + 内置规则」，用户规则优先。
 * 纯内存实现；持久化由调用方（settings / 文件层）负责，保持本模块零 IO。
 */
export class ApprovalRulesStore {
  private userRules: ApprovalRule[];
  private readonly includeBuiltin: boolean;

  constructor(options: ApprovalRulesStoreOptions = {}) {
    this.userRules = [...(options.userRules ?? [])];
    this.includeBuiltin = options.includeBuiltin !== false;
  }

  /** 生效规则（用户规则在前）。 */
  rules(): ApprovalRule[] {
    return this.includeBuiltin ? [...this.userRules, ...builtinApprovalRules()] : [...this.userRules];
  }

  /** 用户规则列表。 */
  listUserRules(): ApprovalRule[] {
    return [...this.userRules];
  }

  /** 整体替换用户规则。 */
  setUserRules(rules: readonly ApprovalRule[]): void {
    this.userRules = [...rules];
  }

  /** 新增 / 覆盖一条用户规则（同 id 覆盖）。 */
  upsert(rule: ApprovalRule): void {
    const index = this.userRules.findIndex((item) => item.id === rule.id);
    if (index >= 0) this.userRules[index] = rule;
    else this.userRules.push(rule);
  }

  /** 删除一条用户规则（内置规则不可删）。 */
  remove(id: string): boolean {
    const before = this.userRules.length;
    this.userRules = this.userRules.filter((rule) => rule.id !== id);
    return this.userRules.length < before;
  }

  /** 评估一个工具调用。 */
  evaluate(input: ApprovalInput): ApprovalVerdict | null {
    return evaluateRules(this.rules(), input);
  }

  /** 导出成可持久化的 JSON 结构。 */
  toJSON(): { userRules: ApprovalRule[] } {
    return { userRules: this.listUserRules() };
  }

  /** 从持久化结构还原。 */
  static fromJSON(
    data: { userRules?: ApprovalRule[] } | undefined,
    options: Omit<ApprovalRulesStoreOptions, "userRules"> = {},
  ): ApprovalRulesStore {
    return new ApprovalRulesStore({ userRules: data?.userRules ?? [], ...options });
  }
}
