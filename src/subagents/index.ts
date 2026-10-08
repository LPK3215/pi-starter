/**
 * pi-starter · 子代理（把子任务派给一条独立对话执行）
 *
 * 主对话把子任务丢给一条**新会话**跑完，把结果拿回来继续。它复用的是同一套编排栈
 * （`buildAgent().createSession()`），没有另造一套 agent 循环——另造一套的结果是
 * 两边的工具策略、审批、看门狗、上下文预算立刻开始分叉。
 *
 * 三条设计约束，每条都对应一个真实的失败模式：
 *
 *   1. **不占主对话的并发额度**。子会话由 `createSession()` 直接建，**不进** `ClientSession`
 *      的 `convs`，所以 `maxOpenConversations` / LRU 只统计用户可见的对话。
 *      走 `newConversation()` 的话，派 3 个子代理就会把用户的对话挤掉。
 *   2. **失败必须让主对话知道**。静默丢结果等于让模型以为子任务成功了；
 *      所以失败既作为工具结果文本回给模型（可据此改写计划），也推一条 notice 给客户端。
 *   3. **输出必须截断**。子代理可能吐出几十万字符，原样灌进主上下文会当场击穿预算。
 *      截断时**如实标记**，让模型知道这不是全文。
 *
 * 派发本身要能被审批规则管住（子代理跑 bash 是高危动作）：工具带 `subagent` 能力标签，
 * 由 `builtin:subagent.delegate` 这条规则在开启审批时过问。
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLogger } from "../log.js";

/** 派发工具名。 */
export const DELEGATE_TOOL_NAME = "delegate_task";

/** 派发工具的能力标签，供审批规则的 `capability` 匹配器使用。 */
export const SUBAGENT_CAPABILITY = "subagent";

/** 回传上限（字符）。子代理输出直接进主上下文，不设上限等于允许它击穿上下文预算。 */
export const MAX_SUBAGENT_OUTPUT_CHARS = 8000;

/** 单个子代理的默认执行上限。超时即中止，并把中止原因如实回传。 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;

/** 同时运行的子代理上限。防止模型一轮里连派几十个把进程打满。 */
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 3;

/** 子会话所需的最小契约（与 SDK AgentSession 一致，便于用替身驱动）。 */
export interface SubagentSession {
  readonly sessionId: string;
  messages: readonly unknown[];
  prompt(text: string): Promise<void>;
  abort(): Promise<void> | void;
  dispose(): void;
}

export interface SubagentRunnerOptions {
  /** 建一条独立会话（通常是 `agent.createSession()`）。 */
  createSession: () => Promise<SubagentSession>;
  /** 通知出口（推 WS notice）。缺省则只回给模型。 */
  notify?: (level: "info" | "warn" | "error", text: string) => void;
  maxOutputChars?: number;
  timeoutMs?: number;
  maxConcurrent?: number;
}

/**
 * 截断超长输出。
 *
 * 头尾都留：结论通常在开头，中间是大段过程，而末尾常有「所以要做什么」。
 * 只留头部会把行动项切掉，只留尾部会让模型看不到任务到底成没成。
 */
export function truncateSubagentOutput(
  text: string,
  maxChars: number = MAX_SUBAGENT_OUTPUT_CHARS,
): { text: string; truncated: boolean; originalLength: number } {
  if (text.length <= maxChars) return { text, truncated: false, originalLength: text.length };
  const marker = `\n\n…[已截断：原始 ${text.length} 字符，只保留头尾各 ${Math.floor(maxChars / 2)} 字符]…\n\n`;
  const half = Math.floor(maxChars / 2);
  return {
    text: `${text.slice(0, half)}${marker}${text.slice(-half)}`,
    truncated: true,
    originalLength: text.length,
  };
}

/** 从子会话消息里取最后一条 assistant 文本。 */
export function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (!message || message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) continue;
    let out = "";
    for (const part of content) {
      if (part && typeof part === "object") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") out += text;
      }
    }
    if (out) return out;
  }
  return "";
}

/** 给子代理的提示词。强调「只回结论」，否则主对话会被过程噪声淹没。 */
export function buildSubagentPrompt(task: string, context?: string): string {
  return [
    "你是一个被主对话派出的子代理。独立完成下面这个子任务，然后把结论写清楚。",
    "",
    "## 任务",
    task.trim(),
    context?.trim() ? `\n## 上下文（来自主对话）\n${context.trim()}` : "",
    "",
    "## 输出要求",
    "- 先给结论，再给必要的依据；",
    "- 列出具体涉及的文件 / 函数 / 命令，不要只说「已处理」；",
    "- 遇到阻碍就直说阻碍是什么，不要假装完成；",
    "- 不要复述本提示词，不要写客套话。",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 派发结果的结构化字段。
 *
 * 显式声明而不是让 TS 反推：三条返回路径（空参 / 正常 / 失败）的字段集合不同，
 * 推断出来的类型会把 `error` 收窄成必填 `boolean`，于是正常路径反而编译不过。
 */
export interface DelegateDetails {
  /** true 表示这次派发失败，模型据此知道不能采信结果。 */
  error?: boolean;
  sessionId?: string;
  label?: string;
  /** true 表示输出被截断（不是全文）。 */
  truncated?: boolean;
  originalLength?: number;
}

/**
 * 派发工具。
 *
 * 并发上限用计数 + 等待队列实现：超限时**排队**而不是直接失败——
 * 模型一轮里派 4 个子任务、并发上限 3 是正常用法，直接报错会让它白白重试。
 */
export function createDelegateTool(options: SubagentRunnerOptions): ToolDefinition {
  const maxOutputChars = options.maxOutputChars ?? MAX_SUBAGENT_OUTPUT_CHARS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS);
  const waiters: Array<() => void> = [];
  let running = 0;

  const acquire = async (): Promise<void> => {
    if (running < maxConcurrent) {
      running += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    running += 1;
  };
  const release = (): void => {
    running -= 1;
    const next = waiters.shift();
    if (next) next();
  };

  return defineTool({
    name: DELEGATE_TOOL_NAME,
    label: "派发子代理",
    description: [
      "把一个自包含的子任务派给独立的子代理执行，并取回它的结论。",
      "适合「读一堆文件后回答一个问题」「独立验证一个假设」这类与主对话上下文无关的工作。",
      "子代理有自己的上下文，主对话不会看到它的中间过程，只会拿到最终结论。",
      "子任务的描述必须自包含：子代理看不到主对话的上下文。",
    ].join(""),
    parameters: Type.Object({
      task: Type.String({ description: "交给子代理的任务描述，必须自包含（含需要的文件路径 / 目标）" }),
      context: Type.Optional(
        Type.String({ description: "可选，来自主对话的补充背景（会一并交给子代理）" }),
      ),
      label: Type.Optional(
        Type.String({ maxLength: 60, description: "可选，用于在界面上区分这次派发" }),
      ),
    }),

    async execute(_id, params: { task: string; context?: string; label?: string }, signal): Promise<{
      content: { type: "text"; text: string }[];
      details: DelegateDetails;
    }> {
      const log = getLogger().child({ component: "subagent" });
      const label = params.label?.trim() || params.task.trim().slice(0, 40);
      /** 统一失败出口：既给模型可读文本，也推一条 notice。 */
      const fail = (text: string) => {
        options.notify?.("error", `子代理「${label}」失败：${text}`);
        return {
          content: [{ type: "text" as const, text: `${text}\n不要假设它完成了。请根据已知信息调整计划。` }],
          details: { error: true, label } satisfies DelegateDetails,
        };
      };
      if (!params.task.trim()) {
        // 参数校验已挡住空串，这里是双保险：返回文本而不是抛错，让模型能读到原因。
        return fail("派发失败：task 不能为空。");
      }

      await acquire();
      let session: SubagentSession | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        // acquire() 可能等了很久才排到，这期间用户可能已经停了手。那次 abort 不会有
        // 监听器接住（监听器在下面才挂），所以必须显式补查一次——漏掉就是「用户已取消，
        // 子代理还在后台烧 token」。
        if (signal?.aborted) return fail("派发已取消（中止信号在排队期间就已发出）");
        session = await options.createSession();
        // 外部中止（用户 abort / 停机）要传导给子会话，否则它会在后台继续烧 token。
        onAbort = () => {
          void session?.abort();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        // 同理：createSession 期间发出的 abort 同样早于监听器。
        if (signal?.aborted) onAbort();

        await Promise.race([
          session.prompt(buildSubagentPrompt(params.task, params.context)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              void session?.abort();
              reject(new Error(`子代理执行超过 ${Math.round(timeoutMs / 1000)}s，已中止`));
            }, timeoutMs);
          }),
        ]);

        const raw = lastAssistantText(session.messages);
        const trimmed = truncateSubagentOutput(raw, maxOutputChars);
        log.info("子代理完成", { sessionId: session.sessionId, chars: trimmed.originalLength });
        return {
          content: [
            {
              type: "text",
              text: trimmed.truncated
                ? `${trimmed.text}\n\n（以上为子代理输出，已按上限截断）`
                : trimmed.text || "(子代理没有产出文本)",
            },
          ],
          details: {
            sessionId: session.sessionId,
            label,
            truncated: trimmed.truncated,
            originalLength: trimmed.originalLength,
          },
        };
      } catch (err) {
        // 失败要**两头**都通知：工具结果让模型能改写计划，notice 让人看得见。
        const message = err instanceof Error ? err.message : String(err);
        log.warn("子代理失败", { sessionId: session?.sessionId, error: message });
        options.notify?.("error", `子代理「${label}」失败：${message}`);
        return {
          content: [
            {
              type: "text",
              text:
                `子代理「${label}」执行失败：${message}\n` +
                "不要假设它完成了。请根据已知信息调整计划，或改为自己直接执行。",
            },
          ],
          details: { error: true, sessionId: session?.sessionId, label },
        };
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        // 无论如何都要回收：漏掉就是一条挂着 loader 与订阅的僵尸会话。
        try {
          session?.dispose();
        } catch {
          /* already disposed */
        }
        release();
      }
    },
  });
}