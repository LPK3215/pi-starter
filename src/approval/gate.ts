/**
 * pi-starter · 审批闸门（HITL：把决策引擎接到 SDK tool_call 钩子上）
 *
 * 职责边界：
 *   rules.ts   → 这条调用危险吗（规则匹配）
 *   policy.ts  → 还要不要问人（三档放行策略）
 *   gate.ts    → 真的问人：发请求、等应答、超时兜底、把结果翻译成 SDK 的 block / 入参改写
 *
 * 关键设计：
 *   1. **超时即拒绝（fail-safe）**：人类不响应时不放行，避免「审批卡住 → 静默执行」。
 *      该定时器刻意不 `unref()`——它必须触发，否则事件循环空闲时工具会永久挂起。
 *   2. 决策与等待分离：`decide()` 是纯逻辑可单测；`request()` 才涉及异步等待。
 *   3. 闸门不依赖传输层——通过 `onRequest` 回调把请求交给上层（Web 推送 / CLI 提示）。
 *   4. `decision = "modify"` 时把改写后的入参**回传给调用方**，由扩展合并进 `event.input`。
 *   5. 档位记忆走 `normalizeCategory()` 统一口径，写入与读取不会因 `builtin:` 前缀错位。
 *   6. **应答也是 fail-closed**：只有协议里的 allow / modify 才放行，未知取值一律当拒绝。
 *      （协议类型只是编译期约束，WS 上收到的是任意 JSON——只判 `"deny"` 会让非法值变成放行。）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyApprovalResponse,
  decideApproval,
  defaultApprovalPolicy,
  normalizeCategory,
  type ApprovalPolicy,
} from "./policy.js";
import type { ApprovalRule } from "./rules.js";
import type { UiApproval } from "../protocol.js";

export interface ApprovalContextInput {
  toolName: string;
  args: Record<string, unknown>;
  cwd: string;
  capabilities?: readonly string[];
}

/** 闸门对外返回的裁决：是否放行 + 可选改写后的入参。 */
export interface ApprovalOutcome {
  decision: "allow" | "deny";
  /** decision = allow 且人类选择了 modify 时的改写入参。 */
  modifiedArgs?: Record<string, unknown>;
}

export interface ApprovalGateOptions {
  /** Current effective rules (user rules first, then builtin). */
  rules: () => readonly ApprovalRule[];
  /** Global approval switch. Disabling it suppresses *asking*, never *denying*. */
  enabled: () => boolean;
  /**
   * Policy applied to conversations that have not made a choice yet.
   * Wire this to `settings.approvalMode` so the setting is not inert.
   */
  defaultPolicy?: () => ApprovalPolicy;
  /** Called when a request needs a human decision. */
  onRequest: (key: string, request: UiApproval) => void;
  /** Timeout for a human response; on timeout the request is denied. Default 5 min. */
  timeoutMs?: number;
}

/** 只有真正的「对象」才算改写入参（数组 / null / 标量都不算）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PendingEntry {
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  request: UiApproval;
  key: string;
  /** Normalized category id, used to remember a "allow for this category" choice. */
  category: string;
}

export class ApprovalGate {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly policies = new Map<string, ApprovalPolicy>();
  private seq = 0;
  private disposed = false;

  constructor(private readonly opts: ApprovalGateOptions) {}

  /**
   * Per-conversation policy (created lazily).
   * New conversations inherit `defaultPolicy()` so `settings.approvalMode` actually takes effect
   * (previously every conversation started hardcoded at "off", making the setting inert).
   */
  policyFor(key: string): ApprovalPolicy {
    let policy = this.policies.get(key);
    if (!policy) {
      const base = this.opts.defaultPolicy?.() ?? defaultApprovalPolicy();
      // Copy so a shared default object is never mutated by a later per-conversation choice.
      policy = { mode: base.mode, categories: [...base.categories] };
      this.policies.set(key, policy);
    }
    return policy;
  }

  setPolicy(key: string, policy: ApprovalPolicy): void {
    this.policies.set(key, policy);
  }

  /** Pure decision (no waiting). Useful for tests and for dry-run previews. */
  decide(key: string, ctx: ApprovalContextInput) {
    return decideApproval({
      rules: this.opts.rules(),
      policy: this.policyFor(key),
      context: ctx,
      enabled: this.opts.enabled(),
    });
  }

  /**
   * Evaluate and, when the verdict is "ask", wait for a human decision.
   * Timeout, disposal, or an unknown request resolves to deny (fail-safe).
   */
  async request(key: string, ctx: ApprovalContextInput): Promise<ApprovalOutcome> {
    const verdict = this.decide(key, ctx);
    if (verdict.action === "allow") return { decision: "allow" };
    if (verdict.action === "deny") return { decision: "deny" };
    // A disposed gate must never block a tool call.
    if (this.disposed) return { decision: "deny" };

    const requestId = `appr-${++this.seq}`;
    const request: UiApproval = {
      requestId,
      toolName: ctx.toolName,
      ruleId: verdict.ruleId ?? "unknown",
      reason: verdict.reason,
      preview: verdict.preview,
    };
    const category = normalizeCategory(verdict.ruleId, ctx.capabilities ?? []);

    return await new Promise<ApprovalOutcome>((resolve) => {
      const timeoutMs = this.opts.timeoutMs ?? 5 * 60 * 1000;
      // Deliberately NOT unref'd: this timer must fire, otherwise a pending approval
      // would hang the tool call forever when nothing else keeps the event loop alive.
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ decision: "deny" }); // fail-safe: no response means no
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer, request, key, category });
      this.opts.onRequest(key, request);
    });
  }

  /** Resolve a pending request with a human response. Returns false when unknown. */
  resolve(
    requestId: string,
    response: { decision: string; scope?: string; modifiedArgs?: Record<string, unknown> },
  ): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);

    const policy = this.policyFor(entry.key);
    this.setPolicy(entry.key, applyApprovalResponse(policy, response, entry.category));

    // **fail-closed**：只有协议里定义的 allow / modify 才放行，其余（未知字符串、缺字段、
    // 大小写不符，甚至 "deny"）一律拒绝。以前只特判 "deny"，于是 `{"decision":"x"}` 会落进
    // allow 分支——一个非法字段值就能让 ask 档工具在无人同意时执行，审批形同虚设。
    const allowed = response.decision === "allow";
    const modified = response.decision === "modify" && isRecord(response.modifiedArgs);
    if (!allowed && !modified) {
      entry.resolve({ decision: "deny" });
      return true;
    }
    const outcome: ApprovalOutcome = { decision: "allow" };
    if (modified) outcome.modifiedArgs = response.modifiedArgs;
    entry.resolve(outcome);
    return true;
  }

  /** Number of requests currently waiting for a human. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Conversation key that owns a pending request, or undefined when unknown.
   * The transport uses this to clear the approval on the *owning* conversation instead of
   * guessing the active one — a client can switch conversations while a request is pending.
   */
  conversationOf(requestId: string): string | undefined {
    return this.pending.get(requestId)?.key;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ decision: "deny" });
    }
    this.pending.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

/**
 * Extension factory: hooks `tool_call` and consults the gate.
 * Pass via `buildAgent({ extraExtensions: [approvalExtension(gate)] })`.
 *
 * The SDK blocks by returning `{ block: true, reason }`. To rewrite arguments the handler
 * must mutate `event.input` in place (documented contract) — that is what "modify" does here.
 */
export function approvalExtension(
  gate: ApprovalGate,
  options: {
    /**
     * Derive the conversation key from the hook context. Defaults to the SDK session id.
     *
     * The SDK's `ExtensionContext` has **no** `sessionId` field — the session identity lives on
     * `ctx.sessionManager.getSessionId()`. Reading a non-existent `ctx.sessionId` silently yields
     * `undefined`, which used to collapse **every** conversation onto the shared `"default"` key and
     * leak approval choices across conversations. `AgentSession.sessionId` is defined as exactly
     * `sessionManager.getSessionId()`, so this yields the same id that `Conversation.id` uses.
     */
    conversationKey?: (ctx: {
      cwd: string;
      sessionManager?: { getSessionId?: () => string };
    }) => string;
    /** Capability lookup for the tool (used by capability rules). */
    capabilitiesOf?: (toolName: string) => readonly string[];
  } = {},
): (pi: ExtensionAPI) => void {
  const keyOf =
    options.conversationKey ??
    ((ctx: { cwd: string; sessionManager?: { getSessionId?: () => string } }) => {
      // No session manager (e.g. a hand-rolled context in tests) → a stable per-cwd key.
      return ctx.sessionManager?.getSessionId?.() ?? `cwd:${ctx.cwd}`;
    });
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event, ctx) => {
      const context = ctx as unknown as {
        cwd: string;
        sessionManager?: { getSessionId?: () => string };
      };
      const key = keyOf(context);
      const input = (event as { input?: Record<string, unknown> }).input;
      const args = input ?? {};

      const outcome = await gate.request(key, {
        toolName: event.toolName,
        args,
        cwd: context.cwd,
        capabilities: options.capabilitiesOf?.(event.toolName),
      });

      if (outcome.decision === "deny") {
        return { block: true, reason: "Denied by approval policy" };
      }
      if (outcome.modifiedArgs && input) {
        // Documented contract: mutate event.input in place to rewrite arguments.
        for (const [field, value] of Object.entries(outcome.modifiedArgs)) {
          input[field] = value;
        }
      }
      return undefined;
    });
  };
}
