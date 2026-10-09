import { Component, useEffect, type ReactNode } from "react";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";

import { ApprovalCard, ConnectionBadge, ControlBar, HitlDialog, NoticeBar, ThreadManager, ToolTrace } from "@/components/pi-panels";
// 官方 registry 组件（shadcn add @assistant-ui/thread）。我自己的那份留在
// @/components/thread.tsx 作为回退点，两者可单独换回来对比。
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { ThreadList } from "@/components/assistant-ui/elements/thread-list.aui";
import { TooltipProvider } from "@/components/ui/tooltip";
import { piClient } from "@/pi/client";
import { usePiRuntime, usePiSnapshot } from "@/pi/usePiRuntime";

export default function App() {
  useEffect(() => {
    // 单例客户端 + 单页应用：不做卸载时关闭。
    // StrictMode 的 mount→cleanup→remount 会先把尚在建连的 socket 掉线，
    // 每次加载都喷一条 "WebSocket is closed before the connection is established"。
    piClient.connect();
  }, []);

  return (
    <AssistantRuntimeProvider runtime={useExternalStoreRuntime(usePiRuntime())}>
      {/* Base UI 的 Tooltip 必须有 Provider 祖先，官方 thread 组件里用了 TooltipIconButton。 */}
      <TooltipProvider>
        <ErrorBoundary>
          <Shell />
          <HitlDialog />
        </ErrorBoundary>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

/**
 * 适配层出错时至少给出可读的错框，而不是整页白屏。
 * ExternalStore 的回调契约很严（例：只有 assistant 消息能带 status），踩到时能立刻看见。 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="m-6 rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        <div className="mb-2 font-medium">前端适配层抛错（后端不受影响）</div>
        <pre className="whitespace-pre-wrap font-mono text-xs">{this.state.error.message}</pre>
        <button className={btnBase} onClick={() => this.setState({ error: null })}>
          重试渲染
        </button>
      </div>
    );
  }
}

const btnBase =
  "mt-3 rounded-lg border border-border px-3 py-1 text-xs text-foreground hover:bg-muted";

function Shell() {
  // 计数读 conversations（由 `conversations` 帧与快照共同维护的列表），不读 state.conversations：
  // 后者只随快照刷新，删完会话后会比实际值旧一帧（两处计数不一致就是这么来的）。
  const { conversations } = usePiSnapshot();
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-2">
        <span className="text-sm font-semibold">Pi Starter</span>
        <ConnectionBadge />
        <span className="truncate text-xs text-muted-foreground">{conversations.length} 个对话</span>
      </header>
      <NoticeBar />
      <ControlBar />
      <div className="flex min-h-0 flex-1">
        {/* 官方 ThreadList（含 New / Search / Items），不再用自研列表——保证与官方样貌一致。 */}
        <aside className="flex w-64 shrink-0 flex-col border-e border-border bg-sidebar">
          {/* 官方 ThreadList（含 New / Search / Items）：可滚动区域 */}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <ThreadList />
          </div>
          {/* 批量管理固定在底部：列表长的时候不用先滚到最下方才能清理 */}
          <div className="border-t border-border p-2">
            <ThreadManager />
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Thread />
          </div>
          <div className="px-4 pb-3">
            <ToolTrace />
            <ApprovalCard />
          </div>
        </main>
      </div>
    </div>
  );
}
