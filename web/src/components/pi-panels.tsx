/**
 * 自绘面板：审批闸门、HITL 反问、控制面。
 *
 * 为什么这三块不走 assistant-ui 的机制：
 * - 审批（approval_request / snapshot.pendingApproval）：官方的 toolApproval 通道要求
 *   tool-call part 自带 approval 元数据，而后端 UiMessage 里没有 tool part（工具轨迹只由
 *   tool_status/tool_delta 帧描述），所以按官方文档 §7 最后一行的口径——控制面自绘。
 * - HITL 反问（extension_ui_request）：它是官方 ExtensionUIContext 的 WS 桥，
 *   应答必须带原 request.id，与 assistant-ui 的 human tool 生命周期不同源。
 * - 模型 / 思考档 / 计划模式 / 上下文预算：assistant-ui 概念里没有，全部自绘。
 */

import { useEffect, useRef, useState } from "react";

import { piClient, toUiResponsePayload } from "@/pi/client";
import { usePiSnapshot } from "@/pi/usePiRuntime";
import { cn } from "@/lib/utils";
import { THINKING_LEVELS } from "@pi/protocol";

const btn =
  "rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-40";

export function ConnectionBadge() {
  const { status, serverVersion, protocolMismatch } = usePiSnapshot();
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span
        className={cn(
          "size-2 rounded-full",
          status === "ready" ? "bg-ok" : status === "connecting" ? "animate-pulse bg-warning" : "bg-destructive",
        )}
      />
      <span>
        {status === "ready" ? "已连接" : status === "connecting" ? "连接中" : "已断开（自动重连中）"}
      </span>
      {serverVersion && <span className="font-mono">v{serverVersion}</span>}
      {protocolMismatch && (
        <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-destructive">协议版本不一致，请刷新</span>
      )}
    </div>
  );
}

/** 审批卡片：allow / deny / modify × once / category / all。 */
export function ApprovalCard() {
  const { state } = usePiSnapshot();
  const approval = state?.pendingApproval;
  const [scope, setScope] = useState<"once" | "category" | "all">("once");

  // 每来一条新审批都把范围重置为"仅本次"。本组件常驻挂载（approval 为空时只是返回 null，
  // 实例不销毁），不重置的话上一次选的"本对话全部"会留到下一次——用户顺手点"允许"
  // 就会意外放行整段规则。hooks 必须在 `if (!approval)` 之前。
  const requestId = approval?.requestId;
  useEffect(() => {
    setScope("once");
  }, [requestId]);

  if (!approval) return null;

  return (
    <div className="mx-auto w-full max-w-3xl rounded-xl border border-warning/50 bg-warning/10 p-3 text-sm">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <span className="rounded bg-warning/25 px-1.5 py-0.5 font-mono text-xs">{approval.toolName}</span>
        <span className="text-xs text-muted-foreground">规则 {approval.ruleId}</span>
      </div>
      <p className="mb-1">{approval.reason}</p>
      {approval.preview && (
        <pre className="mb-2 max-h-24 overflow-auto rounded bg-card p-2 font-mono text-xs">{approval.preview}</pre>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          放行范围
          <select
            className="rounded border border-border bg-card px-1 py-0.5 text-xs"
            value={scope}
            onChange={(e) => setScope(e.target.value as typeof scope)}
          >
            <option value="once">仅本次</option>
            <option value="category">同档位</option>
            <option value="all">本对话全部</option>
          </select>
        </label>
        <button className={cn(btn, "border-ok/60")} onClick={() => piClient.approvalResponse(approval, "allow", scope)}>
          允许
        </button>
        <button className={btn} onClick={() => piClient.approvalResponse(approval, "deny", scope)}>
          拒绝
        </button>
        {/*
          * 这里原先有一个「改写后允许」按钮，它把 `approval.preview` 当作改写后的入参 JSON
          * 发给后端——但 preview 只是**字段摘录**（command / path / params），不是完整入参：
          * 解析成功时会用**错误且不完整**的参数放行工具，解析失败则静默退化成普通「允许」，
          * 按钮文案既没兑现、又制造了一次错误执行。已移除。
          *
          * 要真正支持改写，需要协议让 `UiApproval` 携带完整的工具入参（现在只带摘录），
          * 前端才能给出可编辑的完整 JSON。见 CHANGELOG「未做」。
          */}
      </div>
    </div>
  );
}

/**
 * HITL 反问：一次只弹最前面那条，应答后按 id 匹配回 extension_ui_response。
 * notify 是 fire-and-forget，不阻塞、直接显示为提示。
 */
export function HitlDialog() {
  const { uiRequests } = usePiSnapshot();
  const request = uiRequests.find((r) => r.method !== "notify");
  const notices = uiRequests.filter((r) => r.method === "notify");
  const [value, setValue] = useState("");
  /** 已应答过的 notify id：effect 在多渲染/StrictMode 双挂载下会重跑，重复应答会被服务端当成未知 id。 */
  const answered = useRef(new Set<string>());

  // notify 是 fire-and-forget：必须立刻回一个空应答，否则桥那边一直挂着。
  //
  // 这件事**只能在 effect 里做**：`respondUi` 会 send + `patch`，也就是在渲染期间改外部
  // store 并唤醒其它订阅者——React 明令禁止（"Cannot update a component while rendering
  // a different component"），而且可能形成重渲染环。
  useEffect(() => {
    const present = new Set(notices.map((n) => n.id));
    for (const id of answered.current) if (!present.has(id)) answered.current.delete(id);
    for (const n of notices) {
      if (answered.current.has(n.id)) continue;
      answered.current.add(n.id);
      piClient.respondUi(n, { id: n.id, value: "" });
    }
  }, [notices]);

  if (!request) return null;

  const answer = (v: string | boolean | null) => {
    piClient.respondUi(request, toUiResponsePayload(request, v));
    setValue("");
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-4 shadow-lg">
        <h3 className="mb-2 text-sm font-medium">{request.title}</h3>
        {request.method === "confirm" && <p className="mb-3 text-sm text-muted-foreground">{request.message}</p>}
        {request.method === "select" && (
          <div className="mb-3 flex flex-col gap-1.5">
            {request.options.map((opt) => (
              <button key={opt} className={cn(btn, "text-left")} onClick={() => answer(opt)}>
                {opt}
              </button>
            ))}
          </div>
        )}
        {(request.method === "input" || request.method === "editor") && (
          <textarea
            className="mb-3 min-h-20 w-full resize-y rounded-lg border border-border bg-transparent p-2 text-sm outline-none focus:border-accent"
            placeholder={request.method === "editor" ? request.prefill : request.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        )}
        <div className="flex justify-end gap-2">
          {request.method !== "select" && (
            <button
              className={cn(btn, "border-accent/60 text-accent-foreground")}
              disabled={request.method === "input" && !value.trim()}
              onClick={() => answer(request.method === "confirm" ? true : value)}
            >
              {request.method === "confirm" ? "确认" : "提交"}
            </button>
          )}
          <button className={btn} onClick={() => answer(null)}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/** 左侧对话列表：多对话编排（conversations + new/switch/open/rename/close）。 */
export function ConversationList() {
  const { conversations, state } = usePiSnapshot();
  const current = state?.conversationId;
  return (
    <aside className="flex w-56 shrink-0 flex-col gap-2 border-r border-border bg-background p-3">
      <button className={cn(btn, "w-full")} onClick={() => piClient.newConversation()}>
        + 新对话
      </button>
      <div className="flex-1 space-y-1 overflow-y-auto">
        {conversations.map((c) => (
          <button
            key={c.id}
            className={cn(
              "w-full truncate rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted",
              c.id === current && "bg-accent text-accent-foreground",
            )}
            title={c.id}
            onClick={() => (c.dormant ? piClient.openConversation(c.id) : piClient.switchConversation(c.id))}
          >
            {c.streaming && <span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-warning" />}
            {c.title || "未命名对话"}
            {c.dormant && <span className="ml-1 text-[10px] text-muted-foreground">（磁盘）</span>}
          </button>
        ))}
      </div>
    </aside>
  );
}

/**
 * 运行级工具轨迹条。
 *
 * 放在面板层而不是某个 Thread 组件内部：官方 registry 的 thread.aui 不含它，
 * 嵌在自己的 Thread 里就会在换 UI 时整体消失（上一轮实际发生了）。
 * 工具在后端是**运行级**事件（tool_status/tool_delta 不携带归属消息），多轮 ReAct
 * 里又恰好在两轮之间执行，那一刻流式尾消息为空，所以不能只挂到消息上。
 */
export function ToolTrace() {
  const { tools, runActive } = usePiSnapshot();
  if (tools.length === 0) return null;
  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap gap-1.5">
      {tools.map((t) => (
        <span
          key={t.toolCallId}
          title={t.output || undefined}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px]",
            t.isError
              ? "border-destructive/40 text-destructive"
              : t.phase === "start"
                ? "border-warning/50 text-warning"
                : "border-border text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              t.phase === "start" && runActive ? "animate-pulse bg-warning" : t.isError ? "bg-destructive" : "bg-ok",
            )}
          />
          {t.toolName}
          {typeof t.durationMs === "number" && <span className="opacity-70">{t.durationMs}ms</span>}
        </span>
      ))}
    </div>
  );
}

/**
 * 思考档选择器。
 *
 * 必须显示**服务端回传的档位**而不是本地点击值：不支持 reasoning 的模型会被 SDK 直接
 * 回退（实测请求 high 后快照仍是 off），不标注的话用户只会觉得“下拉框坏了”。
 */
function ThinkingPicker({ level }: { level: string }) {
  const [requested, setRequested] = useState<string | null>(null);
  const clamped = requested !== null && requested !== level;
  return (
    <label className="flex items-center gap-1.5">
      思考
      <select
        className="rounded-lg border border-border bg-transparent px-1.5 py-0.5"
        value={level}
        onChange={(e) => {
          setRequested(e.target.value);
          piClient.setThinking(e.target.value);
        }}
      >
        {[...new Set([level, ...THINKING_LEVELS])].map((lv) => (
          <option key={lv} value={lv}>
            {lv}
          </option>
        ))}
      </select>
      {clamped && (
        <span className="text-warning" title={`请求的 ${requested} 被服务端回退为 ${level}`}>
          该模型不支持 {requested}，已回退为 {level}
        </span>
      )}
    </label>
  );
}

/**
 * 会话批量管理。
 *
 * 为什么自己画而不是用官方 ThreadList 的菜单：官方条目只有逐条 Rename/Archive/Delete，
 * 清几十条测试会话要点几十次。删除本身走的是后端 `delete_conversation`（连磁盘文件），
 * 不是 `close_conversation`（只卸内存，下次又变回磁盘态条目）。
 *
 * 当前会话不可选：服务端本来就拒删最后一条，提前挡住比弹一个错误帧好。
 */
export function ThreadManager() {
  const { conversations, state } = usePiSnapshot();
  const current = state?.conversationId;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const deletable = conversations.filter((c) => c.id !== current);
  /**
   * 选中集合只保留"仍存在且不是当前会话"的 id。
   *
   * 两个理由：
   * - 删完服务端会重推列表，选中的 id 可能已经不存在；
   * - **复选框的 `disabled={isCurrent}` 拦不住"先勾选、再切到该会话"**——那样点「删除所选」
   *   会把正在用的会话连同磁盘文件一起删掉。所以要跟着 `current` 一起收敛。
   */
  useEffect(() => {
    const alive = new Set(conversations.map((c) => c.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => alive.has(id) && id !== current));
      return next.size === prev.size ? prev : next;
    });
  }, [conversations, current]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = () => {
    for (const id of selected) {
      // 双保险：确认框弹出的这段时间里用户仍可能切换会话，提交时再按当下值挡一次。
      if (id === current) continue;
      piClient.deleteConversation(id);
    }
    setSelected(new Set());
    setConfirming(false);
    setOpen(false);
  };

  if (!open) {
    return (
      <button className={cn(btn, "mt-2 w-full")} onClick={() => setOpen(true)}>
        批量管理（{conversations.length}）
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-xl border border-border p-2">
      <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
        <span>已选 {selected.size} 条</span>
        <div className="flex gap-1">
          <button className={btn} onClick={() => setSelected(new Set(deletable.map((c) => c.id)))}>
            全选可删
          </button>
          <button
            className={btn}
            onClick={() => setSelected(new Set(deletable.filter((c) => c.dormant).map((c) => c.id)))}
          >
            只选磁盘态
          </button>
        </div>
      </div>

      <div className="max-h-64 space-y-0.5 overflow-y-auto">
        {conversations.map((c) => {
          const isCurrent = c.id === current;
          return (
            <label
              key={c.id}
              className={cn(
                "flex items-start gap-2 rounded-lg px-1.5 py-1 text-xs",
                isCurrent ? "opacity-50" : "hover:bg-muted cursor-pointer",
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                disabled={isCurrent}
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{c.title || "未命名对话"}</span>
                <span className="block text-[10px] text-muted-foreground">
                  {c.messageCount} 条
                  {c.dormant ? " · 磁盘" : ""}
                  {isCurrent ? " · 当前会话不可删" : ""}
                  {c.streaming && !isCurrent ? " · 生成中" : ""}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {confirming ? (
        <div className="mt-2 rounded-lg border border-destructive/50 bg-destructive/10 p-2 text-xs">
          <p className="mb-2">
            确认删除 {selected.size} 条会话？会连同磁盘上的会话文件一起删除，<b>不可恢复</b>。
          </p>
          <div className="flex gap-2">
            <button className={cn(btn, "border-destructive/60 text-destructive")} onClick={submit}>
              确认删除
            </button>
            <button className={btn} onClick={() => setConfirming(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            className={cn(btn, "border-destructive/60 text-destructive")}
            disabled={selected.size === 0}
            onClick={() => setConfirming(true)}
          >
            删除所选
          </button>
          <button
            className={btn}
            onClick={() => {
              setSelected(new Set());
              setConfirming(false);
              setOpen(false);
            }}
          >
            收起
          </button>
        </div>
      )}
    </div>
  );
}

/** 顶栏控制面：模型 / 思考档 / 计划模式 / 上下文预算与用量。 */
export function ControlBar() {
  const { models, state } = usePiSnapshot();
  if (!state) return null;
  const ctx = state.stats.context;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-2 text-xs">
      <select
        className="rounded-lg border border-border bg-transparent px-2 py-1"
        value={`${state.model.provider}/${state.model.id}`}
        onChange={(e) => piClient.setModel(e.target.value)}
      >
        {models.models.map((m) => {
          const ref = `${m.provider}/${m.id}`;
          return (
            <option key={ref} value={ref}>
              {m.name || ref}
            </option>
          );
        })}
        {!models.models.some((m) => `${m.provider}/${m.id}` === `${state.model.provider}/${state.model.id}`) && (
          <option value={`${state.model.provider}/${state.model.id}`}>
            {state.model.name || `${state.model.provider}/${state.model.id}`}（当前）
          </option>
        )}
      </select>

      {/* 思考档以前只是只读文本，但协议有 set_thinking：选不了就等于思维过程不可控。 */}
      <ThinkingPicker level={state.thinkingLevel} />

      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={state.planMode}
          onChange={(e) => piClient.setPlanMode(e.target.checked)}
        />
        计划模式
      </label>

      <div className="ml-auto flex items-center gap-2">
        <span className="text-muted-foreground">
          上下文 {Math.round(ctx.usage * 100)}%（{ctx.tokens}
          {ctx.softCap > 0 ? `/${ctx.softCap}` : ""} tok）
        </span>
        <button className={btn} onClick={() => piClient.compactContext()}>
          压缩上下文
        </button>
        <span className="text-muted-foreground">费用 ¥{state.stats.cost.toFixed(4)}</span>
      </div>
    </div>
  );
}

/** 提示条：自动收起（后端的重连/限流提示是一次性告知，常驻会堆满顶栏）。 */
export function NoticeBar() {
  const { notices } = usePiSnapshot();
  const latest = notices.at(-1);
  const at = latest?.at;

  useEffect(() => {
    if (!at) return;
    const ttl = 9000 - (Date.now() - at);
    const t = setTimeout(() => piClient.clearNotices(), Math.max(1500, ttl));
    return () => clearTimeout(t);
  }, [at]);

  if (!latest) return null;
  return (
    <div
      className={cn(
        "border-b px-4 py-1.5 text-xs",
        latest.level === "error"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : latest.level === "warn"
            ? "border-warning/40 bg-warning/10 text-warning"
            : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {latest.text}
    </div>
  );
}
