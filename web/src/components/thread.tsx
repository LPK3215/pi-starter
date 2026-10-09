import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import type { FC } from "react";

import { usePiSnapshot } from "@/pi/usePiRuntime";
import { cn } from "@/lib/utils";

/** Markdown 正文：Agent 回复大量使用列表/代码块/表格，纯文本会原样漏出 ** 与 `。 */
const MarkdownText: FC = () => (
  <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="aui-md" />
);

const UserMessage: FC = () => (
  <MessagePrimitive.Root className="flex justify-end">
    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-accent-foreground">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);

/**
 * 工具调用渲染：pi-starter 的工具在后端执行，前端只读状态（官方分类里的 backend tool）。
 * 入参后端不下发（UiMessage 里没有 tool part），所以这里只显示名称、状态、输出与耗时。
 */
const ToolCallFallback: FC<{
  toolName: string;
  toolCallId: string;
  status?: { type: string };
  isError?: boolean;
  result?: unknown;
}> = ({ toolName, status, isError, result }) => {
  const running = status?.type === "running" || status?.type === "partial-call";
  const output = typeof result === "string" ? result : "";
  return (
    <div
      className={cn(
        "mt-2 rounded-lg border px-2.5 py-1.5 font-mono text-xs",
        isError ? "border-destructive/40 text-destructive" : "border-border text-muted-foreground",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("size-1.5 rounded-full", running ? "animate-pulse bg-warning" : "bg-ok")} />
        <span>{toolName}</span>
        {running && <span className="text-[11px]">运行中…</span>}
        {isError && <span className="text-[11px]">失败</span>}
      </div>
      {output && <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap">{output}</div>}
    </div>
  );
};

const AssistantMessage: FC = () => (
  // 气泡：文本走 Markdown，工具轨迹走 tool-call part（tool_status/tool_delta 转译而来）。
  <MessagePrimitive.Root className="group flex justify-start">
    <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-2.5">
      <MessagePrimitive.Parts components={{ Text: MarkdownText, tools: { Fallback: ToolCallFallback as never } }} />
      <MessageActions />
    </div>
  </MessagePrimitive.Root>
);

const MessageActions: FC = () => (
  <ActionBarPrimitive.Root className="mt-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
    <ActionBarPrimitive.Copy className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted">
      复制
    </ActionBarPrimitive.Copy>
    <ActionBarPrimitive.Reload className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted">
      重新生成
    </ActionBarPrimitive.Reload>
  </ActionBarPrimitive.Root>
);

/**
 * Reload 依赖 onReload 回调。当前对接层没有提供它（后端 edit_message / rollback 的语义是
 * "回滚到该条并把原文交回输入框、不自动再发一轮"，不等价于重新生成），
 * 所以此按钮点击暂无效果——留着是为了接上回调后即生效，不必再改 UI 结构。
 */
const Composer: FC = () => {
  // ComposerPrimitive.If 的 running 分支在 0.15 已废弃，直接用后端快照的轮次状态做条件渲染。
  const { runActive } = usePiSnapshot();
  return (
    <ComposerPrimitive.Root className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2">
      <ComposerPrimitive.Input
        className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
        placeholder="给 Agent 一条指令…（Enter 发送，Shift+Enter 换行）"
        submitMode="enter"
        autoFocus
      />
      {runActive ? (
        <ComposerPrimitive.Cancel className="rounded-xl border border-destructive/50 px-3 py-1.5 text-sm text-destructive">
          中止
        </ComposerPrimitive.Cancel>
      ) : (
        <ComposerPrimitive.Send className="rounded-xl bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-40">
          发送
        </ComposerPrimitive.Send>
      )}
    </ComposerPrimitive.Root>
  );
};

/**
 * 运行级工具轨迹条由 App 统一渲染（@/components/pi-panels 的 ToolTrace），
 * 不在这里重复一份：否则换用官方 thread 组件时它会消失，两处都渲染时又会重复。
 */
export const Thread: FC = () => (
  <ThreadPrimitive.Root className="flex h-full flex-col">
    <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 py-6">
      <ThreadPrimitive.Empty>
        <div className="mx-auto mt-16 max-w-md text-center text-sm text-muted-foreground">
          <div className="mb-2 text-2xl">Pi Starter</div>
          连接已就绪。发一条消息，后端 Agent 会带着工具、知识库与审批闸门回你。
        </div>
      </ThreadPrimitive.Empty>

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        <BranchPickerPrimitive.Root className="flex justify-center gap-2 text-xs text-muted-foreground" />
      </div>

      <ThreadPrimitive.ScrollToBottom className="sticky bottom-2 mx-auto block w-fit rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
        滚到最新
      </ThreadPrimitive.ScrollToBottom>
    </ThreadPrimitive.Viewport>

    <ThreadPrimitive.ViewportFooter className="mx-auto w-full max-w-3xl px-4 pb-4">
      <Composer />
    </ThreadPrimitive.ViewportFooter>
  </ThreadPrimitive.Root>
);
