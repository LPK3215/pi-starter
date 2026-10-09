/**
 * pi-starter · 危险 shell 命令的单一事实源
 *
 * 改造前 `extensions/guard.ts`（硬拦截）与 `approval/rules.ts`（ask / deny 规则）各维护
 * 一份正则表，并且已经漂移：approval 多了 `git-destructive` / `chmod-recursive` 两条，
 * guard 里没有。两边各改一处、互不知情，迟早出现「拦截了一条、审批不认识」的错配。
 *
 * 现在两边都从这份表派生：
 *   - guard 只对 `guardBlocks: true` 的条目硬拦（保持原有 6 条的**行为完全不变**，
 *     只是正则来源统一）；
 *   - 其余条目交给审批规则（ask / deny）处理——guard 不能抢先把「可放行」的操作直接拒掉。
 *
 * 新增一条危险命令只需改这一处，两张表同步生效。
 */

export interface DangerousShellRule {
  /** 短 id；审批规则 id 为 `builtin:bash.<id>`。 */
  id: string;
  /** 审批规则描述（英文，与既有 builtin 规则文案一致）。 */
  description: string;
  /** guard 拦截时给出的可读原因（中文）。 */
  reason: string;
  /** 正则源码，匹配时统一加 `i`。 */
  pattern: string;
  /** guard 是否硬拦截。 */
  guardBlocks: boolean;
  /** 审批命中后的动作。 */
  action: "ask" | "deny";
}

export const DANGEROUS_SHELL_RULES: readonly DangerousShellRule[] = [
  {
    id: "rm-rf",
    description: "Recursive force delete (rm -rf)",
    reason: "递归强制删除（rm -rf）",
    pattern: "\\brm\\s+-(?=[a-zA-Z]*r)(?=[a-zA-Z]*f)[a-zA-Z]+\\b|\\brm\\s+--recursive\\b",
    guardBlocks: true,
    action: "ask",
  },
  {
    id: "mkfs",
    description: "Disk format (mkfs)",
    reason: "格式化磁盘（mkfs）",
    pattern: "\\bmkfs(\\.\\w+)?\\b",
    guardBlocks: true,
    action: "deny",
  },
  {
    id: "dd",
    description: "Raw device write (dd of=)",
    reason: "裸设备写入（dd of=）",
    pattern: "\\bdd\\b[\\s\\S]*\\bof\\s*=",
    guardBlocks: true,
    action: "deny",
  },
  {
    id: "fork-bomb",
    description: "Fork bomb",
    reason: "fork bomb",
    pattern: ":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;",
    guardBlocks: true,
    action: "deny",
  },
  {
    id: "shutdown",
    description: "Shutdown / reboot",
    reason: "关机 / 重启",
    pattern: "\\b(shutdown|reboot|halt|poweroff)\\b",
    guardBlocks: true,
    action: "deny",
  },
  {
    id: "windows-destructive",
    description: "Windows destructive delete / format",
    reason: "Windows 破坏性删除 / 格式化",
    pattern:
      "\\bRemove-Item\\b[\\s\\S]*-(Recurse|Force)\\b|\\bdel\\s+/s\\b|\\brd\\s+/s\\b|\\bformat\\s+[a-z]:",
    guardBlocks: true,
    action: "ask",
  },
  {
    id: "git-destructive",
    description: "Destructive git (reset --hard / push --force / clean -fd)",
    reason: "破坏性 git（reset --hard / push --force / clean -fd）",
    pattern: "\\bgit\\s+reset\\s+--hard\\b|\\bgit\\s+push\\b[\\s\\S]*--force\\b|\\bgit\\s+clean\\s+-[a-z]*f",
    guardBlocks: false,
    action: "ask",
  },
  {
    id: "chmod-recursive",
    description: "Recursive chmod (chmod -R / 777)",
    reason: "递归 chmod（chmod -R / 777）",
    pattern: "\\bchmod\\s+-R\\b|\\bchmod\\s+777\\b",
    guardBlocks: false,
    action: "ask",
  },
];

/** 模块级编译一次，避免每次工具调用重新 `new RegExp`。 */
const COMPILED: ReadonlyArray<{ rule: DangerousShellRule; re: RegExp }> = DANGEROUS_SHELL_RULES.map(
  (rule) => ({ rule, re: new RegExp(rule.pattern, "i") }),
);

/** guard 用：命中第一条**需要硬拦截**的规则；没有则 undefined。 */
export function matchGuardShellRule(command: string): DangerousShellRule | undefined {
  for (const { rule, re } of COMPILED) {
    if (rule.guardBlocks && re.test(command)) return rule;
  }
  return undefined;
}

/** approval 用：把全部 shell 规则派生成审批规则（供 `BUILTIN_RULES` 拼装）。 */
export function shellApprovalRuleSpecs(): ReadonlyArray<{
  id: string;
  description: string;
  pattern: string;
  action: "ask" | "deny";
}> {
  return DANGEROUS_SHELL_RULES.map((rule) => ({
    id: `builtin:bash.${rule.id}`,
    description: rule.description,
    pattern: rule.pattern,
    action: rule.action,
  }));
}
