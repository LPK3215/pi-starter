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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isPathInsideCwd } from "../extensions/guard.js";
import { validationFailed } from "../http/errors.js";
import { getLogger } from "../log.js";

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

/** 用户规则条数上限。内置规则之外再堆太多，评估成本与维护成本都不划算。 */
export const MAX_USER_RULES = 500;

export interface ApprovalRulesStoreOptions {
  /** 用户自定义规则（自顶向下，排在内置之前，便于覆盖）。 */
  userRules?: readonly ApprovalRule[];
  /** 是否附带内置规则。默认 true。 */
  includeBuiltin?: boolean;
  /**
   * 改动即落盘的回调。**不要**改成「停机时写」——那会用内存副本覆盖运行期间的外部修改。
   * 回调抛错不影响规则在内存中的生效。
   */
  onChange?: (rules: readonly ApprovalRule[]) => void;
}

/**
 * 规则库：合并「用户规则 + 内置规则」，用户规则优先。
 * 纯内存实现；持久化由调用方（settings / 文件层）负责，保持本模块零 IO。
 */
export class ApprovalRulesStore {
  private userRules: ApprovalRule[];
  private readonly includeBuiltin: boolean;
  /**
   * 改动回调：每次规则变化后立刻触发，由调用方在此**立即落盘**。
   *
   * 为什么是「改动即写」而不是「停机时写」：后者会在运行期间被外部修改（用户手改
   * 规则文件）时，用启动时读入的内存副本覆盖掉那次修改——把别人的改动悄悄抹掉。
   * 改成只有「我们自己改动」这一个写盘时机后，停机不再需要写盘，那类覆盖也就不存在了。
   */
  private onChange: ((rules: readonly ApprovalRule[]) => void) | undefined;

  constructor(options: ApprovalRulesStoreOptions = {}) {
  this.userRules = [...(options.userRules ?? [])];
    this.includeBuiltin = options.includeBuiltin !== false;
    this.onChange = options.onChange;
  }

  /** 设置改动回调（装配后注入，避免构造期就要引用文件路径）。 */
  setOnChange(fn: ((rules: readonly ApprovalRule[]) => void) | undefined): void {
    this.onChange = fn;
  }

  /** 生效规则（用户规则在前）。 */
  rules(): ApprovalRule[] {
    return this.includeBuiltin ? [...this.userRules, ...builtinApprovalRules()] : [...this.userRules];
  }

  /** 用户规则列表。 */
  listUserRules(): ApprovalRule[] {
 return [...this.userRules];
  }

  /** 整体替换用户规则（会触发落盘回调）。 */
  setUserRules(rules: readonly ApprovalRule[]): void {
    this.userRules = [...rules];
    this.onChange?.(this.listUserRules());
  }

  private notifyChanged(): void {
    try {
 this.onChange?.(this.listUserRules());
    } catch (err) {
      // 落盘失败不能连带让规则改动回滚——规则已经在内存里生效了，静默失败更糟。
      getLogger()
        .child({ component: "approval-rules" })
        .error("规则落盘失败（改动已在内存生效）", {
   error: err instanceof Error ? err.message : String(err),
        });
    }
  }

  /** 新增 / 覆盖一条用户规则（同 id 覆盖）。 */
  upsert(rule: ApprovalRule): void {
    const index = this.userRules.findIndex((item) => item.id === rule.id);
    if (index >= 0) this.userRules[index] = rule;
    else this.userRules.push(rule);
    this.notifyChanged();
  }

  /** 删除一条用户规则（内置规则不可删）。 */
  remove(id: string): boolean {
    const before = this.userRules.length;
    this.userRules = this.userRules.filter((rule) => rule.id !== id);
    const removed = this.userRules.length < before;
    if (removed) this.notifyChanged();
    return removed;
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

/**
 * 文件持久化：与 `fileSettingsPort` 同一套语义（原子写 + 损坏回落）。
 *
 * 规则库损坏的后果比设置更严重——它决定哪些命令被拦。所以读回时**逐条校验**，
 * 非法规则只跳过并告警，而不是让一份坏文件把整个审批机制变成空规则（= 全部放行）。
 */
export function loadApprovalRulesFromFile(
  filePath: string,
  options: { logger?: (msg: string, err: unknown) => void } = {},
): ApprovalRulesStore {
  const log = options.logger;
  if (!existsSync(filePath)) return new ApprovalRulesStore();
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    const rawRules =
      parsed && typeof parsed === "object" && Array.isArray((parsed as { userRules?: unknown }).userRules)
        ? ((parsed as { userRules: unknown[] }).userRules)
        : [];
    const valid: ApprovalRule[] = [];
    const capped = rawRules.slice(0, MAX_USER_RULES);
    if (rawRules.length > MAX_USER_RULES) {
      log?.("审批规则条数超限，只保留前若干条", rawRules.length);
    }
    for (const item of capped) {
      // 用与 API 入口**同一个**校验器：否则会出现「手写文件被拦、API 却能塞进去」
      // 这种两条路径标准不一致的漏洞。
      try {
        valid.push(validateApprovalRule(item));
      } catch (err) {
        log?.("跳过非法的审批规则", err instanceof Error ? err.message : String(err));
      }
    }
    return ApprovalRulesStore.fromJSON({ userRules: valid });
  } catch (err) {
    log?.("审批规则文件无法解析，已回落到内置规则", err);
    return new ApprovalRulesStore();
  }
}

/**
 * 装配一个「读盘 + 改动即写盘」的规则库。
 *
 * 抽出来而不是让调用方自己拼 `load` + `setOnChange`：那两步一旦漏掉其中之一，
 * 规则就变成「能改但重启丢」，而这种半成品从代码上完全看不出来。
 * 单一入口也让测试能复现与生产一致的装配。
 */
export function createPersistentRulesStore(
  filePath: string,
  options: { logger?: (msg: string, err: unknown) => void } = {},
): ApprovalRulesStore {
  const log = options.logger;
  const store = loadApprovalRulesFromFile(filePath, { logger: log });
  store.setOnChange((rules) => {
    try {
      saveApprovalRulesToFile(filePath, rules);
    } catch (err) {
      // 落盘失败不阻断内存里的生效，但必须可见——否则用户以为存上了。
      log?.("审批规则落盘失败（改动已在内存生效）", err);
    }
  });
  return store;
}

/**
 * 把用户规则写回文件（原子写）。
 *
 * 直接收规则数组而不是 store：写盘的唯一时机是「刚刚改动过」，调用方手上就是规则数组，
 * 没必要为了拿它先构造一个 store。
 */
export function saveApprovalRulesToFile(
  filePath: string,
  userRules: readonly ApprovalRule[],
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const payload = { userRules: sanitizeUserRules(userRules) };
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

/** 写盘前再过一次校验：落盘的内容必须是能被读回来的合法规则。 */
function sanitizeUserRules(rules: readonly ApprovalRule[]): ApprovalRule[] {
  const out: ApprovalRule[] = [];
  for (const rule of rules.slice(0, MAX_USER_RULES)) {
    try {
      out.push(validateApprovalRule(rule));
    } catch {
      // 静默丢弃非法项：内存里可能已被绕过校验塞进畸形规则，写盘时不放行它。
    }
  }
  return out;
}

/**
 * 结构校验：宁少勿错——一条畸形规则绝不能被当成「无规则」从而放行高危命令。
 *
 * `value` 的存在性必须一起校验。只查 `kind` 是不够的：
 *   - `{kind:"glob"}` 缺 value → `globToRegExp(undefined)` 在**匹配时**才抛
 *     （加载时不炸，跑到审批路径上崩，等于规则库把审批机制带崩）；
 *   - `{kind:"regex"}` 缺 value → `new RegExp(undefined)` 匹配字面量 "undefined"，
 *     **静默错配**，比崩更糟。
 */
export function validateApprovalRule(value: unknown): ApprovalRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationFailed("规则必须是对象");
  }
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.trim() === "") {
    throw validationFailed("规则缺少 id");
  }
  if (typeof r.description !== "string" || r.description.trim() === "") {
    throw validationFailed(`规则 ${r.id} 缺少 description`);
  }
  if (!(Array.isArray(r.tools) && r.tools.every((t) => typeof t === "string" && t !== "")) && r.tools !== "*") {
    throw validationFailed(`规则 ${r.id} 的 tools 必须是字符串数组或 "*"`);
  }
  if (!["command", "path", "params"].includes(String(r.field))) {
    throw validationFailed(`规则 ${r.id} 的 field 必须是 command / path / params 之一`);
  }
  if (!["allow", "deny", "ask"].includes(String(r.action))) {
    throw validationFailed(`规则 ${r.id} 的 action 必须是 allow / deny / ask 之一`);
  }
  const m = r.match;
  if (!m || typeof m !== "object") throw validationFailed(`规则 ${r.id} 缺少 match`);
  const match = m as Record<string, unknown>;
  const kind = match.kind;
  // builtin 必须原样保留：它是「系统预置」的标记，丢了会让调用方的
  // 「内置规则不可经此写入」检查变成永远不触发的死代码。
  const builtin = r.builtin === true ? true : undefined;
  if (kind === "outside_workspace") {
    return {
      id: r.id,
      description: r.description,
      tools: r.tools as string[] | "*",
      field: r.field as ApprovalField,
      match: { kind: "outside_workspace" },
      action: r.action as ApprovalAction,
      ...(builtin ? { builtin } : {}),
    };
  }
  if (!["regex", "glob", "contains", "prefix", "capability"].includes(String(kind))) {
    throw validationFailed(`规则 ${r.id} 的 match.kind 非法：${String(kind)}`);
  }
  if (typeof match.value !== "string" || match.value === "") {
    throw validationFailed(`规则 ${r.id} 的 match.value 必须是非空字符串`);
  }
  return {
    id: r.id,
    description: r.description,
    tools: r.tools as string[] | "*",
    field: r.field as ApprovalField,
    match: { kind, value: match.value } as ApprovalMatch,
    action: r.action as ApprovalAction,
    ...(builtin ? { builtin } : {}),
  };
}

/** 判断是否是一条结构合法的规则（不抛错，供调用方需要布尔结果的场合）。 */
export function isApprovalRule(value: unknown): value is ApprovalRule {
  try {
    validateApprovalRule(value);
    return true;
  } catch {
    return false;
  }
}
