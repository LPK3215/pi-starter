/**
 * pi-starter · 计划模式（会话级「只规划、不实施」）
 *
 * 分两层，缺一不可：
 *   - **硬闸门**：`tool_call` 拦截写类工具，直接 block。这才是真正的保证；
 *     只靠提示词，模型照样会调工具（尤其在上下文被压缩之后）。
 *   - **软约束**：`before_agent_start` 追加一段系统提示词，让模型**知道**当前处于计划模式，
 *     从而产出「计划」而不是「计划 + 顺手改了文件」。
 *
 * 拒绝原因必须**可操作**：模型要能据此自我纠正。只说「计划模式下不允许写文件」，
 * 模型会反复重试同一个调用；说清「被拒的工具 + 替代动作 + 如何解除」，它才会转去做计划。
 *
 * 状态按**会话**（= SDK sessionId）存，而不是全局开关——同一连接下的两条对话
 * 一个在规划、一个在实施是正常用法。状态随会话索引落盘，重启后仍生效。
 *
 * 接入方式全部走 `src/extensions/` 的钩子，不改内核：
 *   buildAgent({ extraExtensions: [planModeExtension(controller, {...})] })
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLogger } from "../log.js";

/** 计划模式下必定拒绝的工具名（SDK 内置 + 脚手架约定的写类动作）。 */
const WRITE_LIKE_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "bash",
  "multi_edit",
  "apply_patch",
  "delete_file",
  "create_file",
]);

/** 计划模式下必定拒绝的能力标签。注册表驱动的工具靠它判定，不依赖工具名。 */
const WRITE_LIKE_CAPABILITIES: readonly string[] = ["fs.write", "shell"];

/** 追加到系统提示词的软约束段落。 */
export const PLAN_MODE_PROMPT_SECTION = [
  "## 计划模式（本会话已开启）",
  "",
  "这一轮**只做规划，不要实施**。具体来说：",
  "- 写文件、改文件、执行 shell 一类的工具会被直接拒绝，重试多少次都一样；",
  "- 需要摸清现状时照常使用只读工具（read / grep / find / ls / 知识库 / 数据库查询）；",
  "- 产出物是一份可执行的计划：改哪些文件、每处怎么改、为什么这么改、风险与验证方式；",
  "- 小需求不要写长篇计划——两三句话讲清改法即可，避免为了凑格式而灌水；",
  "- 不要在回答里倾倒整段代码或完整文件内容，只给关键片段与接口签名。",
  "",
  "用户解除计划模式后，你才能开始动手。",
].join("\n");

/**
 * 计划模式下对某个工具的裁决（纯函数，可单测）。
 *
 * 返回拒绝原因字符串 =拒绝；返回 undefined = 放行。
 * 判定同时看工具名与能力标签：只看名字的话，运行期注入的工具（MCP）会全部漏网。
 */
export function planModeDenyReason(
  toolName: string,
  capabilities: readonly string[] = [],
): string | undefined {
  const hit = WRITE_LIKE_CAPABILITIES.find((cap) => capabilities.includes(cap));
  const byCapability = hit !== undefined;
  if (!byCapability && !WRITE_LIKE_TOOLS.has(toolName)) return undefined;
  const via = byCapability ? `能力标签 ${hit}` : `工具名 ${toolName}`;
  return [
    `计划模式已开启，已拒绝 ${toolName}（判定依据：${via}）。`,
    "这一轮只允许规划：改用只读工具（read / grep / find / ls / 知识库 / 数据库查询）摸清现状，",
    "然后把「要改哪些文件、怎么改、怎么验证」写成计划交给用户。",
    "确实必须先执行才能继续时，请明确告诉用户「需要先解除计划模式」，不要重试同一个调用。",
  ].join("\n");
}

/** 计划模式状态文件的条目上限（与其它落盘结构一致，防止无界增长）。 */
export const MAX_PLAN_MODE_ENTRIES = 500;

export interface PlanModeControllerOptions {
  /**
   * 状态文件路径。省略则**不落盘**（纯内存）：库嵌入 / 测试默认不写用户目录。
   */
  filePath?: string;
  /** 未显式设置过的会话是否处于计划模式（读settings.planMode，惰性）。 */
  defaultEnabled: () => boolean;
  logger?: (msg: string, err: unknown) => void;
}

interface PlanModeFile {
  version: 1;
  entries: Record<string, boolean>;
}

/**
 * 计划模式状态控制器。
 *
 * 存「显式设置」而不是「当前值」：没有显式设置的会话跟着 `settings.planMode` 走，
 * 这样用户改一次默认档就同时影响所有新会话，而不必逐个会话改回去。
 */
export class PlanModeController {
  private readonly overrides = new Map<string, boolean>();

  constructor(private readonly opts: PlanModeControllerOptions) {
    this.load();
  }

  /** 该会话当前是否处于计划模式。 */
  isEnabled(sessionId: string): boolean {
    if (!sessionId) return this.opts.defaultEnabled();
    const override = this.overrides.get(sessionId);
    return override ?? this.opts.defaultEnabled();
  }

  /** 显式设置某个会话的模式；写入即落盘。返回设置后的值。 */
  set(sessionId: string, enabled: boolean): boolean {
    if (!sessionId) return this.opts.defaultEnabled();
    this.overrides.set(sessionId, enabled);
    this.persist();
    return enabled;
  }

  /** 取消显式设置（回到跟随默认档）。 */
  clear(sessionId: string): void {
    if (!this.overrides.delete(sessionId)) return;
    this.persist();
  }

  /** 当前所有显式设置（给能力目录 / 调试用）。 */
  entries(): { sessionId: string; enabled: boolean }[] {
    return [...this.overrides].map(([sessionId, enabled]) => ({ sessionId, enabled }));
  }

  private load(): void {
    const filePath = this.opts.filePath;
    if (!filePath || !existsSync(filePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      const entries = (parsed as PlanModeFile | null)?.entries;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        this.opts.logger?.("计划模式状态文件格式不对，已忽略", parsed);
        return;
      }
      for (const [id, value] of Object.entries(entries as Record<string, unknown>)) {
        // 会话 id 来自本地文件，但仍是外部输入：只接受非空、无路径分隔符的字符串。
        if (typeof value !== "boolean") continue;
        if (!id.trim() || id.includes("/") || id.includes("\\")) continue;
        this.overrides.set(id, value);
      }
      this.trimToCap();
    } catch (err) {
      // 状态文件坏了不该让服务起不来：回落成「跟随默认档」。
      this.opts.logger?.("计划模式状态文件无法解析，已回落默认", err);
    }
  }

  private persist(): void {
    const filePath = this.opts.filePath;
    if (!filePath) return;
    this.trimToCap();
    const data: PlanModeFile = { version: 1, entries: Object.fromEntries(this.overrides) };
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      // 同目录 rename 是原子的：要么旧文件要么新文件，不会读到写了一半的 JSON。
      renameSync(tmp, filePath);
    } catch (err) {
      // 落盘失败不撤销内存里的设置，但必须让调用方知道「这次没存上」。
      this.opts.logger?.("计划模式状态落盘失败（改动已在内存生效）", err);
    }
  }

  /** 超出上限时按插入顺序淘汰最旧的（Map 保序）。 */
  private trimToCap(): void {
    while (this.overrides.size > MAX_PLAN_MODE_ENTRIES) {
      const oldest = this.overrides.keys().next();
      if (oldest.done) return;
      this.overrides.delete(oldest.value);
    }
  }
}

/**
 * 扩展工厂：`tool_call` 硬闸门 + `before_agent_start` 软约束。
 *
 * 会话键取 `ctx.sessionManager.getSessionId()`——`ExtensionContext` **没有** `sessionId`
 * 字段，读一个不存在的字段会静默得到 `undefined`，进而把全部会话塌缩到同一个键上
 * （`approvalExtension` 踩过一次这个坑）。取不到时退化为按 cwd 分键，宁可粗一点也不共用。
 */
export function planModeExtension(
  controller: PlanModeController,
  options: {
    capabilitiesOf?: (toolName: string) => readonly string[];
    conversationKey?: (ctx: { cwd: string; sessionManager?: { getSessionId?: () => string } }) => string;
  } = {},
): (pi: ExtensionAPI) => void {
  const keyOf =
    options.conversationKey ??
    ((ctx: { cwd: string; sessionManager?: { getSessionId?: () => string } }) =>
      ctx.sessionManager?.getSessionId?.() ?? `cwd:${ctx.cwd}`);
  const log = getLogger().child({ component: "plan-mode" });

  return (pi: ExtensionAPI) => {
    pi.on("tool_call", (event, ctx) => {
      const key = keyOf(ctx as never);
      if (!controller.isEnabled(key)) return undefined;
      const capabilities = options.capabilitiesOf?.(event.toolName) ?? [];
      const reason = planModeDenyReason(event.toolName, capabilities);
      if (!reason) return undefined;
      // warn 起步：每次被拒都对应模型的一次误判，是需要被看见的事件，不是 debug 噪音。
      log.warn("计划模式下拦截写类工具", { toolName: event.toolName, conversationId: key });
      return { block: true, reason };
    });

    pi.on("before_agent_start", (event, ctx) => {
      const key = keyOf(ctx as never);
      if (!controller.isEnabled(key)) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_PROMPT_SECTION}` };
    });
  };
}