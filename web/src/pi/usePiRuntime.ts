/**
 * assistant-ui ↔ pi-starter 的对接层（★ 唯一需要手写的工程）
 *
 * 选型：ExternalStoreRuntime —— 消息状态由后端快照持有，前端只做翻译与回调转发。
 * 官方其它三条自定义路径都不合适：
 *   - LocalRuntime：由 runtime 管消息状态，和后端的 snapshot/rollback/fork 语义打架。
 *   - DataStream / AssistantTransport：要求后端按它的线格式吐数据，违反"不改后端"。
 *
 * 后端 → 前端的每一帧都有落点（对应 docs/assistant-ui.md §7 的映射表）：
 *   snapshot/snapshot_delta/message_delta → messages + convertMessage
 *   run_start/run_end + isStreaming       → isRunning
 *   tool_status/tool_delta                → 末条 assistant 消息上的 tool-call parts
 *   conversations + new/switch/open/close → adapters.threadList
 *   abort                                 → onCancel
 *   approval_request / extension_ui_request → 自绘卡片（见 components/pi-panels.tsx）：
 *       后端的审批与反问不走 assistant-ui 的 toolApproval 通道，因为它的审批要挂在
 *       带 approval 元数据的 tool-call part 上，而 UiMessage 里根本没有 tool part。
 *   models / capabilities / settings      → 控制面自绘，assistant-ui 不接管
 *
 * 没有提供的回调（onEdit / onReload / setMessages）＝ 对应 UI 能力自动关闭，这是
 * ExternalStore 的设计：功能按回调存在与否开启。不硬凑的原因是后端语义不同——
 * `edit_message` 是"回滚到该条 + 把原文交回输入框、不自动再发一轮"，
 * 而 assistant-ui 期望编辑即产生新一轮；凑上去会得到一条和后端树状态不一致的分支。
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { AppendMessage, ExternalStoreAdapter, ThreadMessageLike } from "@assistant-ui/react";

import { piClient, projectMessages, type PiSnapshot } from "./client";
import type { UiConversation, UiMessage, UiToolCall } from "@pi/protocol";

/** 订阅后端快照（客户端与 React 之间的唯一桥）。 */
export function usePiSnapshot(): PiSnapshot {
  return useSyncExternalStore(piClient.subscribe, piClient.getSnapshot, piClient.getSnapshot);
}

/** 消息自带的工具调用 → assistant-ui 的 tool-call part（官方 ToolGroup / ToolFallback 就吃这个）。 */
function toolParts(calls: UiToolCall[]) {
  return calls.map((c) => ({
    type: "tool-call" as const,
    toolCallId: c.id,
    toolName: c.name,
    // 入参现在是真的了（后端从 SDK toolCall.arguments 投影），不再置空。
    // 只给 argsText：官方 ToolFallback 展示的就是它；结构化 args 要的是 ReadonlyJSONObject，
    // 而我们没有注册带类型的 tool renderer，传 args 只会多一道类型妥协。
    argsText: c.args ? JSON.stringify(c.args) : "",
    result: c.result,
    isError: c.isError,
  }));
}

function appendText(message: AppendMessage): { text: string; images: { mimeType: string; data: string }[] } {
  let text = "";
  const images: { mimeType: string; data: string }[] = [];
  for (const part of message.content) {
    if (part.type === "text") text += part.text;
    if (part.type === "image") {
      // content 是 data URL，后端要 mimeType + base64 裸串。
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.image ?? "");
      if (match) images.push({ mimeType: match[1]!, data: match[2]! });
    }
  }
  return { text: text.trim(), images };
}

/** content 的可变片段形式（ThreadMessageLike.content 是 string | readonly part[]，这里需要 push）。 */
type MessagePart = Exclude<ThreadMessageLike["content"], string>[number];

export function usePiRuntime(): ExternalStoreAdapter<UiMessage> {
  const snap = usePiSnapshot();
  const messages = useMemo(() => projectMessages(snap), [snap]);

  const convertMessage = useCallback(
    (message: UiMessage, idx: number): ThreadMessageLike => {
      const isStreamingTail = idx === messages.length - 1 && (snap.runActive || (snap.state?.isStreaming ?? false));
      // runtime 硬性禁止 user/system 带 status；发送后一轮开始时最后一条恰恰是刚发出去的用户消息。
      const isAssistantTail = isStreamingTail && message.role === "assistant";
      const parts: MessagePart[] = [];

      // 思维链：历史里取消息自带的 thinking，流式中取本地增量缓冲。
      const thinking = message.thinking ?? (isAssistantTail ? snap.streamThinking : "");
      if (thinking) parts.push({ type: "reasoning", text: thinking } as never);
      if (message.text) parts.push({ type: "text", text: message.text });

      // 工具调用：现在由消息自身携带（含配对结果），所以刷新/重连后官方 ToolGroup 仍渲染得出来。
      const calls = [...(message.calls ?? [])];
      // 本轮刚开始、带 toolCall 的那条 assistant 消息还没落定时，用事件帧兜一下。
      if (isAssistantTail && calls.length === 0) {
        for (const t of snap.tools) {
          calls.push({ id: t.toolCallId, name: t.toolName, result: t.output || undefined, isError: t.isError });
        }
      }
      if (calls.length > 0) parts.push(...toolParts(calls));

      // 没有任何可见内容的消息不再占一个空气泡；error 停止要有可读的失败提示，
      // 而不是“（本轮无文本输出）”这种把上游故障说成“模型没说话”的措辞。
      const empty =
        message.role === "assistant" && parts.length === 0
          ? message.stopReason === "error"
            ? "（本轮模型请求失败，未产出内容）"
            : message.stopReason === "aborted"
              ? "（本轮被中止）"
              : ""
          : "";
      return {
        // 始终用会话内位置 id，定稿后**不**换成 entryId。
        // 流式尾条没有 entryId，一旦定稿就换身份会让 runtime 把同一条消息当作两个分支
        // （BranchPicker 出现 2/2 且箭头全 disabled）。位置在单次快照内是稳定的。
        id: `${snap.state?.conversationId ?? "c"}:${idx}`,
        role: message.role,
        createdAt: message.timestamp ? new Date(message.timestamp) : new Date(),
        content: parts.length > 0 ? parts : empty,
        status: isAssistantTail ? { type: "running" } : undefined,
      };
    },
    [messages.length, snap.runActive, snap.state?.isStreaming, snap.state?.conversationId, snap.tools, snap.streamThinking],
  );

  return useMemo<ExternalStoreAdapter<UiMessage>>(
    () => ({
      messages,
      convertMessage,
      // 后端快照的 isStreaming 与 run_start/run_end 都参与，保持与内核一致。
      isRunning: snap.runActive || (snap.state?.isStreaming ?? false),
      isLoading: snap.status !== "ready",
      isDisabled: snap.status === "offline",

      onNew: async (message) => {
        const { text, images } = appendText(message);
        if (!text && images.length === 0) return;
        piClient.prompt(text, images.length > 0 ? images : undefined);
      },
      onCancel: async () => {
        piClient.abort();
      },

      adapters: {
        threadList: {
          threadId: snap.state?.conversationId,
          threads: threads(snap.conversations),
          onSwitchToNewThread: () => piClient.newConversation(),
          onSwitchToThread: (threadId) => {
            const target = snap.conversations.find((c) => c.id === threadId);
            // 磁盘上未加载的对话（dormant）必须走 open，switch 切不过去——协议注释明确。
            if (target?.dormant) piClient.openConversation(threadId);
            else piClient.switchConversation(threadId);
          },
          onRename: (threadId, newTitle) => piClient.renameConversation(threadId, newTitle),
          // 官方条目的 Delete 要的是“真没了”，所以走 delete 而不是 close
          // （close 后会话仍在索引里，会以磁盘态重新出现在列表上）。
          onDelete: (threadId) => piClient.deleteConversation(threadId),
          /**
           * 后端没有归档语义，而这个回调**必须提供**：官方 thread-list 的 Archive 菜单项会调
           * runtime.archive()，ExternalStore 适配层缺 onArchive 时直接 `throw new Error(
           * "External store adapter does not support archiving")`。映射到 close（从当前列表
           * 卸掉、仍可从磁盘重新打开）是可用语义里最接近的一个。
           */
          onArchive: (threadId) => piClient.closeConversation(threadId),
        },
      },
    }),
    [snap, messages, convertMessage],
  );
}

/**
 * conversations → threadList.threads
 * `active` 的那条即当前 thread；其余留在列表里可切换。
 */
function threads(conversations: UiConversation[]) {
  return conversations.map((c) => ({
    status: "regular" as const,
    id: c.id,
    title: c.title || "未命名对话",
    custom: { active: c.active, streaming: c.streaming, dormant: c.dormant, messageCount: c.messageCount },
  }));
}
