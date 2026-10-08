/**
 * pi-starter · 上下文预算引擎（context budget）
 *
 * 在 LLM 全文摘要（compaction）**之前**做梯度裁剪，尽量不动用昂贵的摘要：
 *   1. 先算 token 估算（零依赖启发式，中英混合）；
 *   2. 软上限 = 模型窗口 − reserve，超过就触发裁剪；
 *   3. 分层保留：首条 user（任务定义）+ 最近 N 轮不动，从最旧的中间消息开始丢。
 *
 * 相对 pi-web-ui 的改进：
 *   1. pi-web-ui 的 context-budget 依赖 SDK 消息结构；本模块**对消息形状零假设**，
 *      只认 `{ role, text }`，因此可脱离 SDK 单测，也能给任意垂直 Agent 复用。
 *   2. 裁剪计划是**纯函数**（planContextTrim 返回要丢的下标），不直接改数组，
 *      调用方（会话层）自己决定如何应用，便于审计与回放。
 */

/** 裁剪器能理解的最小消息形状。 */
export interface BudgetMessage {
  role: string;
  text: string;
}

/** token 估算常量：经验值，不求精确，只求同量级可比。 */
const CJK_CHAR = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const CHARS_PER_TOKEN_LATIN = 4;

/**
 * 启发式 token 估算。
 * - CJK 字符 ≈ 1 token/字（保守偏高，宁多算不少算）；
 * - 拉丁字符 ≈ 4 字符/token；
 * - 其余（空白/标点）按拉丁处理。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) cjk += 1;
  }
  const other = text.length - cjk;
  return cjk + Math.ceil(other / CHARS_PER_TOKEN_LATIN);
}

/** 估算一组消息的总 token。 */
export function estimateConversationTokens(messages: readonly BudgetMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message.text) + 4; // +4 消息骨架开销
  return total;
}

/**
 * 计算软上限：模型窗口 − reserve。
 * reserve = clamp(window × ratio, minReserve, window × 0.5)——
 * 上限 50% 是为了避免小窗口模型（如 4k/8k）被 minReserve 吃掉整个窗口导致软上限为 0。
 */
export function computeSoftCap(
  windowTokens: number,
  options: { reserveRatio?: number; minReserve?: number } = {},
): number {
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return 0;
  const reserveRatio = options.reserveRatio ?? 0.15;
  const minReserve = options.minReserve ?? 4096;
  const floor = Math.max(Math.floor(windowTokens * reserveRatio), minReserve);
  const reserve = Math.min(floor, Math.floor(windowTokens * 0.5));
  return Math.max(windowTokens - reserve, 0);
}

export interface TrimPlanInput {
  messages: readonly BudgetMessage[];
  /** 软上限（token）。 */
  maxTokens: number;
  /** 最近保留的轮数（1 轮 = 1 条 user + 1 条 assistant，粗略按消息数算）。 */
  keepRecent?: number;
  /** 是否始终保留首条 user（任务定义）。默认 true。 */
  keepFirstUser?: boolean;
}

export interface TrimPlan {
  /** 建议丢弃的消息下标（升序）。 */
  drop: number[];
  /** 建议保留的消息下标（升序）。 */
  keep: number[];
  estimatedTokens: number;
  /** 裁剪后是否仍在预算内。 */
  withinBudget: boolean;
  /** 是否发生了裁剪。 */
  trimmed: boolean;
}

/**
 * 制定裁剪计划（纯函数，不修改入参）。
 *
 * 分层策略：
 *   1. 首条 user + 最近 keepRecent 条 → 永不丢；
 *   2. 其余消息从最旧开始丢，直到估算 token ≤ maxTokens；
 *   3. 若丢完中间段仍超预算（说明尾部本身就超），保留尾部并在 withinBudget=false 标记，
 *      交给上层决定是否触发摘要压缩。
 */
export function planContextTrim(input: TrimPlanInput): TrimPlan {
  const { messages, maxTokens } = input;
  const keepRecent = Math.max(input.keepRecent ?? 6, 1);
  const keepFirstUser = input.keepFirstUser !== false;

  const estimated = estimateConversationTokens(messages);
  if (estimated <= maxTokens) {
    return {
      drop: [],
      keep: messages.map((_, index) => index),
      estimatedTokens: estimated,
      withinBudget: true,
      trimmed: false,
    };
  }

  const protectedIdx = new Set<number>();
  if (keepFirstUser) {
    const firstUser = messages.findIndex((m) => m.role === "user");
    if (firstUser >= 0) protectedIdx.add(firstUser);
  }
  for (let i = Math.max(messages.length - keepRecent, 0); i < messages.length; i += 1) {
    protectedIdx.add(i);
  }

  const drop: number[] = [];
  let running = estimated;
  for (let i = 0; i < messages.length; i += 1) {
    if (running <= maxTokens) break;
    if (protectedIdx.has(i)) continue;
    const message = messages[i];
    if (!message) continue;
    drop.push(i);
    running -= estimateTokens(message.text) + 4;
  }

  const dropSet = new Set(drop);
  const keep: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (!dropSet.has(i)) keep.push(i);
  }

  return {
    drop,
    keep,
    estimatedTokens: Math.max(running, 0),
    withinBudget: running <= maxTokens,
    trimmed: drop.length > 0,
  };
}

/** 应用裁剪计划，返回新数组（不改原数组）。 */
export function applyTrim<T>(messages: readonly T[], plan: TrimPlan): T[] {
  const dropSet = new Set(plan.drop);
  return messages.filter((_, index) => !dropSet.has(index));
}

/**
 * 上下文占用比例，供 UI 进度条（0–1，超出为 1）。
 */
export function contextUsageRatio(usedTokens: number, softCap: number): number {
  if (softCap <= 0) return 0;
  return Math.min(usedTokens / softCap, 1);
}
