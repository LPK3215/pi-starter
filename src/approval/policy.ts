/**
 * pi-starter · 审批放行策略（三档）
 *
 * 规则引擎（rules.ts）回答「这条调用危险吗」；本模块回答「还要不要问人」。
 *
 * 三档（与 pi-web-ui 对齐，但去掉插件档位，改成能力档位）：
 *   ① off       全局关审批 → 所有工具直接放行（默认档，适合可信本地脚本）
 *   ② all       本对话全部允许 → 命中 ask 也直接放行
 *   ③ category  本对话同档位允许 → 命中过同一档位的工具不再问
 *
 * 档位 id 稳定（如 `bash.rm-rf` / `cap:fs.write`），保证「记住这次选择」跨会话可复现。
 *
 * 关键设计：**deny 不可被策略覆盖**。策略只压制 ask，不放过 deny——否则「全允许」会
 * 变成提权后门。这是相对 pi-web-ui 更保守、也更安全的一处差异。
 */

import {
  evaluateRules,
  type ApprovalAction,
  type ApprovalInput,
  type ApprovalRule,
  type ApprovalVerdict,
} from "./rules.js";

/** 放行策略模式。 */
export type ApprovalMode = "off" | "all" | "category";

export interface ApprovalPolicy {
  mode: ApprovalMode;
  /** mode = category 时已记住的档位 id。 */
  categories: string[];
}

/** 默认策略：off（本地脚手架默认不问人；生产接入时按需打开）。 */
export function defaultApprovalPolicy(): ApprovalPolicy {
  return { mode: "off", categories: [] };
}

/** 工具调用的完整审批上下文。 */
export interface ApprovalContext {
  toolName: string;
  args: Record<string, unknown>;
  cwd: string;
  capabilities?: readonly string[];
}

/** 最终决策。 */
export interface ApprovalDecisionResult {
  action: ApprovalAction;
  /** 命中的规则 id；无命中时为 null。 */
  ruleId: string | null;
  reason: string;
  preview: string;
  /** true 表示「命中 ask 但被策略压制放行」。 */
  suppressed: boolean;
}

/**
 * 把「原始 ruleId」归一化成稳定的档位 id。
 * 这是档位记忆的**唯一口径**：写入（人类应答）与读取（策略匹配）必须都走这里，
 * 否则 `builtin:bash.rm-rf` 与 `bash.rm-rf` 会被当成两个档位，「记住这次选择」永远不生效。
 */
export function normalizeCategory(ruleId: string | null, capabilities: readonly string[]): string {
  if (ruleId) return ruleId.replace(/^builtin:/, "");
  return `cap:${capabilities[0] ?? "custom"}`;
}

/**
 * 计算档位 id：优先用命中的规则 id（如 `builtin:bash.rm-rf` → `bash.rm-rf`），
 * 无规则时用能力标签（如 `cap:fs.write`）。稳定、可跨会话记忆。
 */
export function categoryIdFor(verdict: ApprovalVerdict | null, capabilities: readonly string[]): string {
  return normalizeCategory(verdict?.ruleId ?? null, capabilities);
}

/**
 * 决策纯函数：给定规则库、策略与调用上下文，得出 allow / deny / ask。
 *
 * 优先级：deny（不可覆盖） > 策略压制 > 规则 ask > 默认 allow。
 */
export function decideApproval(params: {
  rules: readonly ApprovalRule[];
  policy: ApprovalPolicy;
  context: ApprovalContext;
  /** 全局审批开关（settings.toolApprovalEnabled）。false 时不再「问人」，但 deny 仍生效。 */
  enabled: boolean;
}): ApprovalDecisionResult {
  const { rules, policy, context, enabled } = params;

  const input: ApprovalInput = {
    toolName: context.toolName,
    args: context.args,
    cwd: context.cwd,
    capabilities: context.capabilities,
  };
  const verdict = evaluateRules(rules, input);

  // deny 是**无条件**硬闸门：全局开关只压制「询问」，绝不放行 deny。
  // 否则关掉审批就等于关掉 mkfs / dd / fork-bomb / shutdown 的拦截，成为提权后门。
  if (verdict?.action === "deny") {
    return {
      action: "deny",
      ruleId: verdict.ruleId,
      reason: verdict.reason,
      preview: verdict.preview,
      suppressed: false,
    };
  }

  if (!enabled) {
    return {
      action: "allow",
      ruleId: verdict?.ruleId ?? null,
      reason: "approval disabled (asks suppressed)",
      preview: verdict?.preview ?? "",
      suppressed: Boolean(verdict),
    };
  }

  if (!verdict) {
    return { action: "allow", ruleId: null, reason: "no rule matched", preview: "", suppressed: false };
  }

  if (verdict.action === "allow") {
    return {
      action: "allow",
      ruleId: verdict.ruleId,
      reason: verdict.reason,
      preview: verdict.preview,
      suppressed: false,
    };
  }

  // action === "ask"：看策略能否压制。
  const category = categoryIdFor(verdict, context.capabilities ?? []);
  if (policy.mode === "all" || (policy.mode === "category" && policy.categories.includes(category))) {
    return {
      action: "allow",
      ruleId: verdict.ruleId,
      reason: verdict.reason,
      preview: verdict.preview,
      suppressed: true,
    };
  }

  return {
    action: "ask",
    ruleId: verdict.ruleId,
    reason: verdict.reason,
    preview: verdict.preview,
    suppressed: false,
  };
}

/**
 * 处理一次人类应答，返回更新后的策略。
 * - decision=allow 且 scope=all    → mode 升到 all
 * - decision=allow 且 scope=category → 记住档位
 * - 其余不变
 */
export function applyApprovalResponse(
  policy: ApprovalPolicy,
  response: { decision: string; scope?: string },
  category: string,
): ApprovalPolicy {
  if (response.decision !== "allow") return policy;
  if (response.scope === "all") return { mode: "all", categories: policy.categories };
  if (response.scope === "category" && !policy.categories.includes(category)) {
    return { mode: policy.mode === "all" ? "all" : "category", categories: [...policy.categories, category] };
  }
  return policy;
}
