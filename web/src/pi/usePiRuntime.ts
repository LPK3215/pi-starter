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

import { piClient, projectMessages, type PiSnapshot, type ToolView } from "./client";
import type { UiConversation, UiMessage } from "@pi/protocol";

/** 订阅后端快照（客户端与 React 之间的唯一桥）。 */
export function usePiSnapshot(): PiSnapshot {
  return useSyncExternalStore(piClient.subscribe, piClient.getSnapshot, piClient.getSnapshot);
}

/** tool_status/tool_delta 聚合出的轨迹 → assistant-ui 的 tool-call part。 */
function toolParts(tools: ToolView[]) {
  return tools.map((t) => ({
    type: "tool-call" as const,
    toolCallId: t.toolCallId,
    toolName: t.toolName,
    // 后端不下发入参（UiMessage 里没有），argsText 留空，避免编造。
    argsText: "",
    result: t.output || undefined,
    isError: t.isError,
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
      const parts: MessagePart[] = [];
      if (message.text) parts.push({ type: "text", text: message.text });
      // 工具有轨迹只可能挂在 assistant 消息上：runtime 硬性禁止 user/system 带 status，
      // 而发送后一轮开始时最后一条恰恰是刚发出去的用户消息（快照已含），这里不区分会直接抛错。
      const isAssistantTail = isStreamingTail && message.role === "assistant";
      // 工具只挂在**正在流式的那条** assistant 消息上（官方 ToolGroup / Reasoning 因此生效）。
      // 定稿后消息里不再有 tool part（后端不持久化工具历史），运行轨迹改由 App 层的
      // ToolTrace 常驻显示，不在这里伪造“知道哪条消息调了什么”的归属。
      const tools = isAssistantTail ? snap.tools : [];
      if (tools.length > 0) {
        parts.push(...toolParts(tools));
      }
      if (snap.streamThinking && isAssistantTail) {
        parts.unshift({ type: "reasoning", text: snap.streamThinking } as never);
      }
      // 只调工具不带文本的 assistant 消息在后端确实是空文本，不留空白气泡。
      const fallbackText = message.text || (message.role === "assistant" && parts.length === 0 ? "（本轮无文本输出）" : "");
      return {
        // 始终用会话内位置 id，定稿后**不**换成 entryId。
        // 因为流式尾条没有 entryId，- 一旦定稿就换身份，runtime 会把同一条消息当作两个分支
        // （BranchPicker 显示 2/2 但箭头全 disabled）。位置在单次快照内是稳定的。
        id: `${snap.state?.conversationId ?? "c"}:${idx}`,
        role: message.role,
        createdAt: message.timestamp ? new Date(message.timestamp) : new Date(),
        content: parts.length > 0 ? parts : fallbackText,
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
          onDelete: (threadId) => piClient.closeConversation(threadId),
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
