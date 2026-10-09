import { Component, useEffect, type ReactNode } from "react";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";

import { ApprovalCard, ConnectionBadge, ControlBar, ConversationList, HitlDialog, NoticeBar } from "@/components/pi-panels";
import { Thread } from "@/components/thread";
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
      <ErrorBoundary>
        <Shell />
        <HitlDialog />
      </ErrorBoundary>
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
  const { state } = usePiSnapshot();
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-2">
        <span className="text-sm font-semibold">Pi Starter</span>
        <ConnectionBadge />
        {state && <span className="truncate text-xs text-muted-foreground">{state.conversations.length} 个对话</span>}
      </header>
      <NoticeBar />
      <ControlBar />
      <div className="flex min-h-0 flex-1">
        <ConversationList />
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Thread />
          </div>
          <div className="px-4 pb-3">
            <ApprovalCard />
          </div>
        </main>
      </div>
    </div>
  );
}
