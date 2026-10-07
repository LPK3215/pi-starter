# pi-web-ui 后端功能全景分析

> 用途：作为把 `pi-starter` 脚手架提升到同等成熟度的**参照基准**。
> 范围：**只覆盖后端**（`server/` 目录 + `plugins/` 服务端部分 + `bin/` CLI），前端（`web/`）不纳入。
> 依据：逐文件精读 `server/protocol.ts`、`server/index.ts`、`server/agent-service.ts` 的事件/分发核心，结合 `docs/architecture-*.md`、`docs/directory-reference.md`。
> 分析日期：2026-10-08。目标版本 `pi-web-ui@0.99.0`。
> 同源确认：目标与 `pi-starter` **同基于 `@earendil-works/pi-coding-agent` SDK**（目标 `>=0.85.1` optional/peer 依赖），可直接对比。

---

## 0. 规模与定位对比（先给结论）

| 维度 | pi-starter（当前脚手架） | pi-web-ui（目标） |
|---|---|---|
| 定位 | 垂直 Agent **起步模板**，CLI + 最小 HTTP SSE | 生产级 **AI 编码 Agent 浏览器驾驶舱**（chat/code/files/terminal/git） |
| 后端文件数 | ~15 个源文件 | `server/` **130 个 TS 文件** |
| 最大单文件 | app.ts 280 行 | `agent-service.ts` **15398 行** |
| 入口 | express + SSE | express + **WebSocket 双向** + HTTP 路由 + CLI + Electron 桌面 + CF worker |
| 会话模型 | 单进程 1 session，并发 429 | **每客户端 N 个并发对话**（每对话独立 runtime），跨项目、过户、子代理 |
| 传输协议 | SSE 单向事件流 | **快照驱动 + 增量 delta + 独立流式通道**，协议单源可版本协商 |
| 内置能力 | 自定义工具 + read；sqlite/知识库/技能 | 工具覆盖/审批/终端/后台任务/插件/MCP/视觉桥/计划模式/目标审查/子代理/上下文预算/SCM/多模型多密钥 OAuth… |
| 安全 | guard 正则闸门 | loopback 绑定 + Origin/Host 同源校验 + token 鉴权 + quiesce 准入 + 控制 socket + DOM/能力授权 |

结论：目标不是「脚手架加几个工具」的量级，而是一整套**长生命周期、多并发、可运维**的 Agent 服务运行时。下面按「事件中枢 → 子系统」拆解其全部后端能力，并给出核心代码。

---

## 1. 后端总体架构

### 1.1 分层

```
进程/传输层  bin/pi-web-ui.mjs(CLI)  desktop/(Electron sidecar)  index.ts(express+ws+心跳+优雅停机)
   │
协议层      protocol.ts(★唯一事实源: ClientMessage/ServerMessage/UiState)  protocol-version.ts
   │
会话编排层  agent-service.ts(★15398行: AgentService → ClientSession → Conversation → AgentSessionRuntime)
   │        goal-service.ts / subagents.ts / dsh/*(第二引擎)
   │
能力服务层  工具: tool-manager / tool-approval / approval-rules / read-tool / edit-soft / patch / lsp /
   │        eval / present-files / skill / claim / compact-context / load-tools / delegate / tool-overrides
   │        资源: files-service / attachments / attachment-store / vision-bridge / uploads / file-archives
   │        运维: bg-servers / terminals(PTY) / scm / update-check / managed / launch-origin / control-socket
   │        扩展: plugins / plugin-* (installer/grants/permissions/facilities/project/schedule/llm/tool-guard)
   │        上下文: context-budget / soft-cap / compaction-markers / dangling-tools / serialize
   │        提示词: prompt-composer / tool-prompts / slash-commands / i18n
   │        模型: model-admin / model-enrich / provider-oauth-flow
   │        设置: settings-service / client-state / preset-share / themes / tabs
SDK 层      @earendil-works/pi-coding-agent: createAgentSession / ModelRuntime / DefaultResourceLoader /
            SessionManager / AgentSession(subscribe/prompt/abort/setModel/reload)
配置        ~/.pi/agent/{models.json,auth.json}(与 pi-starter setup 同源) + <dataDir>/{client-state,approval-rules,provider-keys,...}.json
```

### 1.2 三大核心设计决策（对比 pi-starter 最关键的差异）

1. **快照驱动（Snapshot-driven）**：服务端是唯一事实源。每次 SDK 事件后**节流 60ms** 推一份 `UiState` 快照，客户端只按快照渲染；重连只需 `get_state` 重发全量。`pi-starter` 是「事件流直推」（SSE 逐条 delta），无状态快照概念。
2. **协议单源（Single source of truth）**：`server/protocol.ts` 定义全部 client↔server 消息类型；前端 `types.ts` 只做 `export type * from "../../server/protocol"` 再导出。新增消息只改一处 + 在 `index.ts` dispatch 与前端 onmessage 各加分支，`npm run check:protocol` 守护。`pi-starter` 的 SSE 协议是散在 `sse.ts` 的翻译表，无强类型单源。
3. **多路传输分级**：把「流畅性」与「权威性」拆到不同通道——
   - `snapshot` / `snapshot_delta`：权威状态，背压下**可丢弃**（丢了靠 rev 链断裂自愈重同步）。
   - `message_delta` / `tool_delta`：实时增量，**绕过背压永远可达**（大会话不再因背压停更）。

---

## 2. 核心事件流（★ 最重要的部分，含核心代码）

后端的「事件」有三类，构成一个闭环：
**A. 客户端→服务端命令**（`dispatch` switch）；**B. SDK→服务端会话事件**（`onEvent` switch）；**C. 服务端→客户端推送**（快照 + delta + 各类应答）。

### 2.1 入口与连接（`server/index.ts`）

- express 静态托管 + `/ws` 端点。WS 用 `WebSocketServer({ noServer: true })` + 手动 `handleUpgrade`，升级前做 **Origin/Host 同权威校验**（`originAllowed`）。
- 每连接装配：`send`（带背压丢弃 + 快照重试定时器）、`dispatch`（命令分发）、`pluginMgr.addSender`（插件广播）、心跳、`noteSocketOpen/Close`（控制 socket 统计）。
- 消息经 WeakMap 按对象身份缓存 `stringify`（`serializeShared`），**N 个标签页共享一次序列化**。

`send` 的背压丢弃 + 强制全量重发（节选，`index.ts` ~2100–2134）：

```ts
// 丢弃的是快照：内存有界，客户端靠 rev 链断裂自愈（get_state 重同步）。
if (!snapshotRetryTimer) {
  snapshotRetryTimer = setTimeout(() => {
    snapshotRetryTimer = null;
    service.get(clientId ?? "")?.flushSnapshot(wasFull); // 丢的是全量则强制全量重发
  }, SNAPSHOT_RETRY_MS);
}
return;
// ...
const wire = serializeShared(msg);
if (msg.type === "snapshot") lastSnapshotBytes = wire.length * 2;
ws.send(wire);
```

### 2.2 A 类：客户端命令分发 `dispatch`（`index.ts:2161`）

`dispatch(msg: ClientMessage)` 前置：未 attach 完成的命令进 `pending` 队列；`managed`/`tabs` 能力门禁先拒绝；随后一个巨型 `switch (msg.type)` 路由到 `ClientSession`（`cs`）方法。完整命令分类（从源码 switch 穷举）：

| 类别 | 命令（type） |
|---|---|
| 会话生命周期 | `new_chat` `switch_session` `switch_conversation` `take_over_conversation` `dismiss_conversation` `dismiss_finished_subagents` `persist_conversation` `pin_conversation` `pin_session` `rename_conversation` `rename_session` `fork_session` `rollback_session` `edit_message` |
| 对话运行 | `prompt` `abort` `abort_bash` `retry_last` `queue_remove` `draft_update` |
| 状态/目录 | `hello` `set_locale` `get_state` `get_commands` `get_tool_info` `get_tool_prompt` `get_compacted_messages` `get_settings` `set_settings` |
| 会话/项目列表 | `list_sessions` `list_projects` `remove_project` `delete_session` `search_sessions` `search_files` |
| 文件系统 | `list_files` `read_file` `write_file` `upload_file` `file_create` `file_rename` `file_delete` `file_copy` `file_reveal` `file_open_default` `complete_path` `make_dir` |
| SCM | `scm_status` `scm_history` `scm_filediff` `scm_commit` `scm_commitmsg` |
| 模型/思考 | `list_models` `set_model` `set_default_model` `clear_default_model` `set_thinking` |
| 模型管理 | `list_models_config` `reload_models_config` `save_model_config` `delete_model_config` `list_providers` `fetch_models` `test_model_connection` `refresh_provider_models` `refresh_builtin_models` `append_builtin_model` `clone_provider` `enrich_models` `abort_enrich_models` |
| 密钥/OAuth | `set_provider_api_key` `clear_provider_api_key` `list_provider_keys` `add_provider_key` `activate_provider_key` `remove_provider_key` `provider_oauth_start/reply/cancel/logout` `list_provider_oauth_flows` |
| 终端 | `terminal_create/input/resize/kill` `rename_terminal` `run_command` `list_commands` `save_commands` |
| 工作区 | `set_cwd` `set_workspace_roots` |
| 后台任务 | `kill_background_server` `kill_background_servers` `list_bg_servers` `set_bg_keep` `clean_bg_leftovers` |
| 目标/审查 | `set_goal` `clear_goal` `start_goal_wizard` `set_goal_prefs` |
| 插件 | `plugin_message` `plugin_settings` `plugins_reload` `plugin_catalog_add/remove` `plugin_job` `plugin_job_cancel` `plugin_api_catalog` `plugin_install_inspect` `plugin_path_response` `plugin_permission_response` `plugin_dom_consent(_response)` `plugin_path_revoke` `plugin_permission_revoke` |
| 扩展/运维 | `extensions_reload` `install_pi_agent` `check_update` `check_updates_all` `check_plugin_updates` `restart_service` `dialog_response` |

分发核心（节选，`index.ts:2161`）：

```ts
const dispatch = (msg: ClientMessage): void => {
  if (!clientId) { pending.push(msg); return; }            // 未 attach → 排队
  const cs = service.get(clientId);
  if (!cs || !attachDone) { pending.push(msg); return; }   // 会话未就绪 → 排队
  const refusal = managedRefusal(msg.type, MANAGED) ?? tabsRefusal(msg.type, TABS);
  if (refusal) { send({ type: "notice", level: "error", text: refusal }); return; }
  switch (msg.type) {
    case "prompt":      { /* 无 text 且无附件直接回错；否则 cs.prompt(...) */ break; }
    case "abort":       void cs.abort(); break;
    case "abort_bash":  void cs.abortBash(); break;        // 只杀 bash，对话继续
    case "set_model":   void cs.setModel(msg.modelId); break;
    case "get_state":   cs.flushSnapshot(true); break;     // 恒全量：重连/缺口的权威重建
    // ... 见上表，~100 个 case
  }
};
```

### 2.3 B 类：SDK 会话事件 → 服务端消息 `onEvent`（★ 核心事件代码，`agent-service.ts:6076`）

这是**最核心的事件处理**。每个 `Conversation` 绑定订阅：

```ts
conv.unsubscribe = conv.session.subscribe((event) => this.onEvent(conv, event));
```

`onEvent` 把 SDK 的 `AgentSessionEvent` 翻译成服务端消息 + 快照调度：

```ts
private onEvent(conv: Conversation, event: AgentSessionEvent): void {
  conv.lastSdkEventAt = Date.now();           // 任何事件证明运行存活 → 喂 stall 看门狗
  conv.stallNoticed = false;
  this.reapplySoftCapIfModelChanged(conv);    // 模型变了重算软上限 reserve
  switch (event.type) {
    case "bash_execution_update":   // 终端直接执行路径 → tool_delta（绕过快照通道）
      this.emit({ type: "tool_delta", conversationId: conv.id, seq: ++conv.deltaSeq,
                  toolCallId: event.id, toolName: "bash", delta: event.delta }); break;

    case "tool_execution_start": {  // 工具真正开始
      this.autoActivateToolIfLoadable(conv.session, conv, event.toolName); // JIT 懒激活
      conv.toolStartTimes.set(event.toolCallId, Date.now());               // 记真实执行耗时
      if (event.toolName === "bash") this.bg.snapshotBefore();             // 后台端口快照
      if (event.toolName === "update_plan") conv.toolPendingArgs.set(event.toolCallId, event.args);
      if (event.toolName !== ASK_USER_QUESTION_TOOL_NAME)                  // 问人类答题豁免看门狗
        this.armToolWatchdog(conv, event.toolCallId, event.toolName, event.args);
      this.onToolEvent?.({ phase: "start", ... });                         // 插件扩展点
      this.emitRun(conv, { type: "tool_start", toolCallId, toolName, argsText }); // 轨迹
      break; }

    case "tool_execution_end": {   // 工具结束 → 立即推 tool_status（先于快照落盘）
      const startedAt = conv.toolStartTimes.get(event.toolCallId); conv.toolStartTimes.delete(event.toolCallId);
      this.clearToolWatchdog(conv, event.toolCallId);
      if (event.toolName === "bash") void this.bg.trackAfterBash();        // diff 端口→后台任务
      const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
      this.onToolEvent?.({ phase: "end", ...durationMs, isError });
      this.emitRun(conv, { type: "tool_end", resultText, durationMs, isError });
      // bash 的 exitCode 不在 details → 从错误文本正则 /exited with code (\d+)/ 提取
      this.emit({ type: "tool_status", toolCallId, toolName, isError, exitCode, durationMs });
      break; }

    case "tool_execution_update":  // 工具流式部分输出 → tool_delta
      this.emit({ type: "tool_delta", ..., delta: extractPartialText(event.partialResult) }); break;

    case "message_update": {       // ★ 逐 token 流式增量，故意走快照通道之外
      if (conv.id !== this.conv.id) break;   // 只活动对话推流
      this.lastDeltaAt = Date.now();
      this.emit({ type: "message_delta", conversationId: conv.id, seq: ++conv.deltaSeq,
        messageId: `stream-${m?.timestamp ?? 0}`,                        // 与 serializeStreamingMessage 稳定 id 对齐
        usage: this.sessionStats().tokens, assistantMessageEvent: { type, contentIndex, delta } }); break; }

    case "compaction_start": conv.compactionState = { reason, startedAt }; this.markCompactionPending(conv); break; // 常驻进度条
    case "compaction_end":   this.clearCompactionPending(...); this.emit({ type: "notice", ... }); break;            // tokens before→after
    case "auto_retry_start": conv.retryState = { attempt, maxAttempts, delayMs, errorMessage }; break;               // SDK 退避重试
    case "auto_retry_end":   conv.retryState = null; break;

    case "agent_end": {            // 一轮结束（核心汇聚点）
      if (event.willRetry) conv.retryState = { attempt: 0, ... };        // 立占位防「红色一闪」
      else conv.retryState = null;
      this.emitRun(conv, { type: "run_end", stopReason });
      this.scheduleSessionsRefresh(); this.refreshConversationTitle(conv);
      const aborted = event.messages.some((m) => m.role === "assistant" && m.stopReason === "aborted");
      if (aborted) { this.notifyTurnEnd(conv); this.goalSvc.onAgentEnd(conv, true); this.emitConversations(); break; }
      if (conv.isSubagent) { /* 子代理失败通知主对话 */ }
      this.notifyTurnEnd(conv); this.goalSvc.onAgentEnd(conv, false);     // 目标审查循环钩子
      if (this.settingsSvc.hasPendingReload()) void this.applySettingsReload(); // 流式期挂起的设置重载
      // 触碰 sidecar 落盘、AI 主动压缩异步执行、广播运行态
      if (!event.willRetry) this.emitConversations();
      break; }

    case "agent_start": this.emitRun(conv, { type: "run_start", task }); this.emitConversations(); break;
    case "agent_settled": conv.lastTurnBaseTokens = this.currentBaseTokens(conv); /* 执行挂起压缩 */ break;
    case "message_end":  { /* 定稿轨迹 + 内联标记 [[...]] 即时解析(markerSvc) + 结束重试态 */ break; }
    case "turn_start": case "turn_end": this.emitRun(conv, { type }); break;
    case "entry_appended": this.scheduleSessionsRefresh(); this.refreshConversationTitle(conv); break;
  }
  // ★ 快照检查点策略（只服务活动对话）：
  if (conv.id !== this.conv.id) return;
  if (event.type === "agent_end" || event.type === "tool_execution_end" || event.type === "compaction_end"
      || event.type === "auto_retry_start" || event.type === "auto_retry_end") {
    this.flushSnapshot();               // 边界立即全量校准
  } else {
    this.scheduleSnapshot();            // 其余走节流定时器（流式期降为 2s 兜底）
  }
}
```

关键常量（`agent-service.ts` 顶部）：

```ts
const SNAPSHOT_INTERVAL_MS = 60;            // 全量/增量快照节流窗口
const STREAMING_SNAPSHOT_INTERVAL_MS = 2000; // 有 message_delta 活跃时快照降为 2s 检查点
```

### 2.4 快照生成核心：`emitSnapshotNow`（增量 vs 全量判定，`agent-service.ts:6889`）

```ts
private emitSnapshotNow(forceFull = false): void {
  if (this.disposed) return;
  if (this.convs.size === 0) { void this.newChat().then(() => this.flushSnapshot(true)); return; } // 自愈
  const cur = this.currentMessages();
  const prev = this.emittedMessages;
  // 持久消息内容不可变 + 对象引用稳定 → O(n) 指针等同性遍历检测「仅追加」
  let incremental = !forceFull && prev !== null && this.emittedConvId === this.activeId && prev.length <= cur.length;
  if (incremental && prev) for (let i = 0; i < prev.length; i++) if (prev[i] !== cur[i]) { incremental = false; break; }
  const rev = ++this.snapRev;
  if (incremental && prev) {
    this.emit({ type: "snapshot_delta", conversationId: this.activeId, rev, baseRev: this.emittedRev,
                appended: cur.slice(prev.length), state: this.buildLightState(rev, false) });
  } else {
    this.emit({ type: "snapshot", state: { ...this.buildLightState(rev, true), messages: cur } }); // 全量带草稿
  }
}
// flushSnapshot(forceFull): get_state/重连恒走 forceFull（权威全量重建）
```

**设计精髓**：把 10MB 全量字符串化成本，压到常见「只有 stats/version 变」检查点的几百字节。中途变更/截断/切会话/fork/压缩 → 回落全量。

### 2.5 C 类：服务端→客户端消息（`ServerMessage`，`protocol.ts:2673`）

核心下行类型：
`ready`（身份/能力/引擎/协议版本/buildId/managed/tabs/service） · `snapshot` · `snapshot_delta` · `conversations`（跨项目运行列表 + `elsewhere` 他处运行） · `message_delta` · `tool_delta` · `tool_status` · `notice` · `subagent_handoff` · `page_request` · 及各类应答：`file_content` `file_listing` `bg_servers` `provider_keys` `provider_oauth_flows` `scm_data` `tool_info` `tool_prompt` `sessions` `projects` `commands` `models` `settings_state` `slash_commands` `question_pending` `widgets`/`statuses`/`dialog`（扩展 UI 桥）`plugin_*`。

`ready` + `snapshot` + `snapshot_delta` 定义节选（`protocol.ts:2682`）：

```ts
| { type: "ready"; clientId: string; serverVersion: string; engine?: string;
    protocolVersion?: number; appVersion?: string; buildId?: string;
    managed?: boolean; tabs?: string[]; service?: UiServiceInfo }
| { type: "snapshot"; state: UiState }
| { type: "snapshot_delta"; conversationId: string; rev: number; baseRev: number;
    appended: UiMessage[]; state: Omit<UiState, "messages" | "rev"> & { rev: number } }
| { type: "tool_delta"; conversationId: string; seq: number; toolCallId: string; toolName: string; delta: string }
```

`UiState`（快照结构，服务端唯一事实源，`protocol.ts:107`）字段极多，节选要点：
`clientId / cwd / sessionId / sessionFile / workspaceRoots / homeDir / conversationId / isEphemeral / rev(单调) / messages[] / streamingMessage / isStreaming / model / thinkingLevel / availableThinkingLevels / queue{steering,followUp} / retry / compaction / pendingQuestion / actionSuggestions / pendingApproval / subagentHandoffs / plan / planMode / delegateMode / delegateConvId / draft / tools[] / version / piConfigured / piAgentInstalled / stats{tokens, cost, contextUsage.softCap}`。

---

## 3. 后端功能清单（逐子系统：做什么 + 核心文件 + 核心机制/代码）

> 每节给出：功能 → 核心实现文件 → 关键机制/事件 → 可选核心代码。文件均在 `server/`。

### 3.1 会话编排与多对话并发（★ 骨架）
- **做什么**：每浏览器连接一个 `ClientSession`，内含 `convs: Map<convId, Conversation>`，**每个对话一个独立 `AgentSessionRuntime`**（`new_chat` 新建 runtime + 新 session 文件，旧对话后台继续跑不中断）；`switch_conversation` 只换 `activeId`；对话按项目（`conv.cwd`）归属；跨客户端「过户」把对话本体事务性搬移。
- **核心文件**：`agent-service.ts`（AgentService/ClientSession/Conversation）、`client-state.ts`（持久化）、`serialize.ts`（SDK 消息→UiMessage）。
- **关键机制**：
  - 运行对话生命周期三字段 `listed/promptedSinceActive/lastActiveAt`；`shownInRunningList()` 展示口径；`MAX_OPEN_CONVERSATIONS=8` 按项目计（子代理不占位）。
  - 所有对话共享**一个 ModelRuntime**（顶栏换模型对全部对话生效），但消息序列化缓存（msgIds/uiMessageCache/签名）**按对话隔离**。
  - 过户事务性：`detachTakeoverConversations`→`insertTakeoverConvs`，接入失败整包搬回源（`returnTakeoverPayload`），杜绝「幽灵会话」。
  - 项目切换记住 `{模型,key}` + 全局默认模型回落链：项目记忆 > 全局默认 > SDK 默认。
- **对比**：`pi-starter` 单 session、并发 429，无多对话/过户/项目维度。

### 3.2 模型与服务商管理（多模型/多密钥/OAuth）
- **做什么**：运行中切换模型/思考强度；内置服务商可持**多把 API key**（按名字寻址，原始 key 值/掩码永不出服务端）；内置服务商 OAuth 授权登录；自定义 provider 拉取/测连/补参。
- **核心文件**：`model-admin.ts`(1937 行)、`model-enrich.ts`、`provider-oauth-flow.ts`、`resolve-global-sdk.ts`/`sdk-origin.ts`（SDK 遮蔽解析）。
- **关键机制/事件**：
  - provider-keys.json `<agentDir>/provider-keys.json` = `{provider:{activeKeyName,keys:[{name,apiKey}]}}`；命令 `add/activate/remove_provider_key`，回 `provider_keys`；`applyActiveKey` 与 auth.json + 运行时 override 同步。
  - OAuth：`ProviderOAuthFlowManager` 驱动 SDK `ModelRuntime.login`，`flowId+promptId` 关联回复，令牌不进 wire；`question/verify/device_code` 事件桥给浏览器。
  - `setModel` 即刻 `rememberProjectModel`（SDK 只有存在 assistant 消息后才落 `model_change`，否则新对话选完切走会丢）。
- **对比**：`pi-starter` 只有 `PI_MODELS` 目录 + `switchModel`，无多密钥/OAuth/项目记忆。

### 3.3 工具系统（覆盖内置 + 大量自定义工具，★ 能力最密集）
- **做什么**：在 SDK 内置 `bash/read/write/edit` 之上做**按名覆盖**（且与第三方扩展同名工具共存），并注入一大批领域工具。
- **核心文件**：`tool-overrides.ts`（覆盖注入）、`read-tool.ts`（目录列举覆盖 read）、`edit-soft-tool.ts`（宽松匹配 edit_soft）、`patch-tool.ts`+`hashline-engine.ts`（哈希锚补丁）、`lsp-tool.ts`(1678)、`eval-tool.ts`（沙箱求值）、`present-files-tool.ts`、`skill-tool.ts`、`claim-files-tool.ts`+`claim-store.ts`、`compact-context-tool.ts`、`load-tools-tool.ts`（延迟加载）、`delegate-task.ts`、`conversation-read-tool.ts`、`schedule-agent-tool.ts`、`tool-manager.ts`(738，统一开关 AGENT_TOOL_CATALOG)、`tool-prompts.ts`（bash 文案单源）、`tool-prompt-overrides.ts`、`tool-info.ts`。
- **关键机制**：
  - **覆盖链**：SDK 合并 `[...扩展工具,...customTools]` 后写赢；`installToolOverrides(session, specs)` 在会话建好后注入，基底优先取扩展实现，前置写回 `_customTools` 再 `_refreshToolRegistry()`；四条不变量（扩展 schema 不被替换/前置顺序/幂等/形状不符降级）。
  - `extractTargetPath()` 认 `path`/`file_path`/`file` 三种写法，叠扩展实现后取空会**静默放行**（安全）。
  - 工具统一开走 ActiveSet：`setActiveToolsByName`（live 生效，无需 reload）；`disabledAgentTools` 持久化。
  - bash 覆盖双实现动态分流（`makeAdaptiveBashTool`）：`terminalBash` 关=可杀原生 bash，开=写进可见终端拿真实退出码（见 3.6）。
  - **看门狗**：每个 `tool_execution_start` arm 一个 timer（设置 `toolWatchdogTimeoutMs` > `PI_WEB_TOOL_TIMEOUT_MS` > 默认 20min），超时 `session.abort()`；`ask_user_question` 豁免。
- **对比**：`pi-starter` 仅 `current_time` + 知识/DB 工具 + guard 拦 bash，无覆盖/补丁/LSP/懒加载/看门狗。

### 3.4 人机协同审批（规则引擎 + 三档放行策略）
- **做什么**：高危工具执行前弹窗审批（批准/拒绝/修改并放行），可配规则库自动判定，三档快速免问。
- **核心文件**：`approval-rules.ts`(670，`ApprovalRulesStore`)、`tool-approval.ts`（HITL + `approvalSuppressionReason` 纯函数）。
- **关键机制**：
  - 规则库 `<dataDir>/approval-rules.json`，自顶向下首个命中；字段 `tools`(单/多/`*`) × `field`(command/path/params) × `match`(regex/glob/contains/prefix/outside_workspace) × `action`(ask/deny/allow)。
  - 内置 10 项高危检测（rm -rf / win del / 磁盘 / 破坏性 git / chmod / 系统重定向 / .env/SSH/shell / 越界写入）转为 `builtin:true` 默认规则。
  - 三档：① 全局关（`toolApprovalEnabled`）② 本对话全允许（scope=all）③ 本对话同档位（scope=category，档位 id 稳定如 `bash.rm-rf`/`plugin:<id>`）；策略挂 `Conversation.approvalPolicy` 仅内存。
- **对比**：`pi-starter` 的 guard 只有硬编码正则拦截，无规则库/审批弹窗/档位/持久化。

### 3.5 计划模式 / 审查者委派 / 目标审查循环
- **计划模式**（`plan-mode.ts`,428）：会话级只规划不实施。硬闸门 `withPlanModeGate`（三处挂载：customTools 整列 / write·edit 覆盖 / 终端 checkSafety）按工具名拦截；`planModeDenial()` 纯函数分写类/只读白名单/旁路三类；软约束 `PLAN_MODE_SYSTEM_PROMPT`（禁代码倾倒 + 小需求短计划）；状态随转录落盘（customType `plan/mode`）。
- **审查者委派**（`delegate-mode.ts`）：开关 + 全自动路由 + 纯委派闸门 `withDelegationGate`，用户请求转给常驻落盘执行对话，主对话只审阅。
- **目标/审查循环**（`goal-service.ts`,2538 + `goal-review-gate.ts`/`goal-evidence.ts`）：设目标→AI 执行→审查模型验收→多轮修订；`GoalService.onAgentEnd(conv, aborted)` 是 `agent_end` 事件的钩子。

### 3.6 终端（PTY，node-pty，★ 独立子系统）
- **做什么**：每对话一个 `TerminalManager`，agent 可调 `terminal_create/list/close/input/key/read/wait` 七件套（命名多终端、增量 cursor、组合键）；用户终端与 AI bash 终端分池。
- **核心文件**：`terminals.ts`(2330)、`patch-node-pty.ts`、`ensure-bash.ts`（Windows busybox 兜底）、`process-utils.ts`。
- **关键机制**：
  - 按键编码纯函数 `encodeTerminalKey`（Ctrl+ArrowUp=`ESC[1;5A`，绝不回退 Ctrl+首字母）。
  - **输出微批**：`queueOut`/`flushPending`（`OUTPUT_FLUSH_MS=16ms`）把 chunk 风暴降 10~50 倍，带 `conversationId` 走 `terminal_output`；socket 断开不杀 PTY。
  - **Windows ConPTY 自愈**：进程已退出只 `pty.kill()`（绝不误杀 PID 复用）；仍运行先写 `\x03exit\r` 触发 MSYS2 清理钩子再强杀；解决 MSYS2 全局控制台上限 128 泄漏死锁。
  - **活力检测**：`noteAgentActivity`/`armIdleWatch`，工具终端连续 15s 无输出且对话流式中→注入 steer 唤醒 AI。
  - 终端接管 bash：单行哨兵 `{cmd}; __pi_rc=$?; printf '[pi-exit:%s]'` 拿真实退出码；尾部限输出管道自动拆解（`| tail/less/more/cat`）。

### 3.7 后台任务跟踪
- **做什么**：检测 AI 用 bash 启动的监听端口进程，列进「后台任务」面板单独/批量停止。
- **核心文件**：`bg-servers.ts`(400)。
- **关键机制**：bash 前后各拍监听快照（Windows netstat / POSIX lsof）diff 出新增 LISTENING；`filterAgentSpawned` 沿父链回溯剔除桌面软件自启（黑名单 + process.pid/本次 pid 命中判定）；30s 刷新存活 + 闲置超阈值自动清理（📌钉住豁免）；命令 `bg_servers`/`kill_background_server(s)`/`list_bg_servers`/`set_bg_keep`/`clean_bg_leftovers`。

### 3.8 文件服务 / 预览 / 附件 / 视觉桥 / 上传下载 / 归档
- **核心文件**：`files-service.ts`(1535)、`attachments.ts`(826)、`attachment-store.ts`(CAS/SHA-256)、`vision-bridge.ts`、`uploads.ts`、`file-archives.ts`、`file-transfer-routes.ts`、`office-parse.ts`(docx/xlsx 提取)、`text-sniff.ts`(previewKind/looksLikeText/decodeText GBK 回退/hexDump)。
- **关键机制**：
  - 附件一律**只给路径**不注入内容（reference/lines/quote/page/imageData/fileData），模型用 read 按需读；作为独立 custom message `deliverAs:"nextTurn"` 发送。
  - 预览只读前 512KB，内容嗅探决定文本/二进制；媒体走 HTTP `/api/file`（Range）；HTML 走 `/api/preview/` 目录映射 + 沙箱 CSP。
  - **视觉桥**：主模型不支持识图时，`findVisionModels` 扫已配 auth 的 provider 找视觉模型，`transcribeImages` 用 `runtime.completeSimple` 转写图片为文字证据（缓存 + 可配模型/提示词）。
  - 归档用 Node 库（tar/yauzl）不调 shell，越界路径/符号链接/设备文件拒绝，20000 项/1GiB 上限。

### 3.9 SCM（只读 git + AI 提交信息）
- **核心文件**：`scm.ts`(execFile git，不经 shell)、`scm-commitmsg.ts`。
- **关键机制**：`scm_status/history/filediff/commit` → 一条 `scm_data`（echo reqId+kind，每请求必有唯一响应）；`.git` 目录 fs.watch 去抖 600ms 推 `scm_changed` 静默刷新；非仓库 `ok:true+notRepo:true`；写操作仍走可见终端 tab。AI 生成提交信息走 `scm_commitmsg`（有 pi ModelRuntime）。

### 3.10 插件系统（★ 第二大巨型子系统）
- **做什么**：可扩展的前后端插件体系——市场目录/后台安装/能力授权/宿主 API/slot 扩展点/插件直调模型/插件定时任务/插件项目脚手架。
- **核心文件**：`plugins.ts`(4712)、`plugin-catalog.ts`/`plugin-catalog-sync.ts`、`plugin-installer.ts`（后台作业 + 看门狗）、`plugin-grants.ts`(目录授权)、`plugin-permissions.ts`(net/llm 能力授权)、`plugin-facilities.ts`(私有 KV+加密 secrets)、`plugin-project.ts`(clone/写文件/git init)、`plugin-schedule.ts`(cron)、`plugin-llm.ts`(孤立会话)、`plugin-tool-guard.ts`(pre/post 拦截)、`plugin-dom.ts`(完全 DOM 授权)、`plugin-manifest-validate.ts`/`icon-svg.ts`/`plugin-updater.ts`/`plugin-install-spec.ts`；`plugin-sdk/`(对外 SDK)；官方插件在 `plugins/`（webmail/db-client/desktop-use/vscode-editor/mermaid/run-trace/page-picker…）。
- **关键机制**：
  - 后台安装作业 `plugin_job`：先经用户确认门（防第三方页面直发），CLI 子进程跑，输出按行回传，单作业锁 + 看门狗。
  - 授权是提权方向走**两步握手**（`plugin_dom_consent` 广播在途请求 + 绑定来源 clientId 应答才落盘），降权 revoke 单步直达。
  - 能力授权「先答复者胜」并广播 `plugin_permission_resolved` 让其它端收起。
- **CF worker**：`cf-worker-feature-board/`（Cloudflare Worker + SQLite D1 的插件功能板）。

### 3.11 MCP 工具桥
- **核心文件**：`mcp-bridge.ts`(635)、`mcp-hot-reload.ts`（mcp.json 改完即生效不重启）。
- **机制**：把外部 stdio MCP 服务器的工具接入 pi 会话。

### 3.12 上下文工程（预算/软上限/压缩/悬空修复）
- **核心文件**：`context-budget.ts`(多级分层裁剪)、`soft-cap.ts`(压缩软上限)、`compaction-markers.ts`、`compacted-history.ts`、`dangling-tools.ts`(悬空 toolCall 修复)。
- **机制**：LLM 全文摘要之前的梯度裁剪；`reapplySoftCapIfModelChanged` 在 onEvent 热路径按模型窗口换算 reserve；压缩进度常驻进度条（快照 `compaction` 字段）+ 重启中断标记落盘可重试；`compact_context` 工具让 AI 主动精简。

### 3.13 系统提示词组合模板
- **核心文件**：`prompt-composer.ts`（纯函数引擎）。
- **机制**：把 SDK 组装的各来源暴露为 `{{soul}}/{{tools}}/{{guidelines}}/{{pi_docs}}/{{append}}/{{persona}}/{{terminal}}/{{markers}}/{{context}}/{{skills}}/{{cwd}}` token，用户自由组合 + 每层单独覆盖；`before_agent_start` 内联隐藏扩展逐 run 渲染，`splitAgentStartPrompt` 拆 pre/core/post 保住其它扩展的首尾增补。默认（未自定义）零开销等同 SDK 默认拼装。
- **对比**：`pi-starter` 是 persona.md + rules.md 两段静态拼接。

### 3.14 安全边界（生产级）
- **核心文件**：`control-socket.ts`、`launch-origin.ts`、`auth-cookie.ts`、`http-proxy.ts`、`host-guard.ts`、`managed.ts`、`tabs.ts`；`index.ts` 的 `originAllowed`/`quiesce`。
- **机制**：默认只绑 `127.0.0.1`；WS Origin/Host 同权威校验（hostname+有效端口）；`AgentService.quiesce/unquiesce` 准入控制（排空拒绝新工作，新客户端 4403 关 WS）；控制 socket（unix socket / Windows 命名管道 `\\.\pipe\pi-web-ui-<port>`，CLI `server status|quiesce|unquiesce`）；`PI_WEB_TOKEN` 鉴权 + token 反射防护（`/api/health` 不反射真 cookie）；provider headers 不下发浏览器。

### 3.15 设置 / 预设分享 / 主题 / 多语言 / tabs
- **核心文件**：`settings-service.ts`(1040)、`client-state.ts`(1454)、`preset-share.ts`(1437，导入导出/社区目录/SSRF 收口)、`preset-fields.ts`(字段清单前后端共用)、`themes.ts`、`tabs.ts`、`i18n.ts`/`locales.ts`（服务端语言协商 + 可下载语言包）。
- **机制**：`set_settings` 显式枚举字段校验；设置改动流式期挂起、`agent_end` 安全重载；主题列表/文件路由（id `ID_RE` 防穿越）注册于 SPA catch-all 前。

### 3.16 斜杠命令 / 定时任务 / 标记子系统
- **核心文件**：`slash-commands.ts`(NATIVE_COMMANDS 内置拦截 + 目录推送)、`scheduler-tasks.ts`(620，cron/间隔触发 + 无头执行)、`markers/`（`marker-service.ts` + `builtins/{action,notify,rename,todo}`）。
- **机制**：AI 正文内联 `[[...]]` 标记（`message_end`/`agent_end` 即时解析）驱动 todo/action 建议等；标记产生 `actionSuggestions` 进快照。

### 3.17 DSH 第二引擎（DeepSeek Harness）
- **核心文件**：`dsh/`（`dsh-agent-service.ts` 4941 + dsh-client/serialize/sessions/usage + runtime launcher/goal-rpc/cordis.yml）；依赖 `@deepseek-ai/dsh-sdk-*`。
- **机制**：`ready.engine`=`pi`|`dsh` 双引擎并存；DSH 走 JSON-RPC runtime，前端按 engine gating（无审批模型/无插件市场/无 mid-run steering/无 edit_soft/read 目录覆盖）。

### 3.18 运维：更新 / 托管 / 桌面 / 部署
- **核心文件**：`update-check.ts`(本体/pi core/扩展全源检查)、`managed.ts`(`PI_WEB_MANAGED=1` 隐藏自更新)、`launch-origin.ts`；`bin/pi-web-ui.mjs`(CLI server install/uninstall/start/stop/restart/status)；`desktop/`(Electron sidecar 随机空闲口起 server)；`Dockerfile`/`docker-compose.yml`/`deploy/`(launchd/systemd/Windows 任务)；`extensions/webui.ts`(`pi` 的 `/webui` 命令启动本机服务)。

### 3.19 WS 传输细节
- `permessage-deflate`（阈值 16KB，大会话多 MB snapshot 降数倍，小消息不压）；`serializeShared` WeakMap 按对象身份缓存 stringify（多标签页共享一次序列化）；心跳 + 优雅停机（SIGINT/SIGTERM）；协议版本协商（`hello.protocolVersion`↔`ready.protocolVersion`，`check:protocol` 守护 server/web 两份常量一致）。

---

## 4. 事件目录速查（三端）

- **SDK AgentSessionEvent（B 类输入）**：`agent_start` `agent_end`(willRetry) `agent_settled` `turn_start` `turn_end` `message_update`(→message_delta) `message_end` `entry_appended` `tool_execution_start` `tool_execution_end`(→tool_status) `tool_execution_update`(→tool_delta) `bash_execution_update`(→tool_delta) `queue_update` `compaction_start` `compaction_end` `auto_retry_start` `auto_retry_end`。扩展事件（pi-starter 用的 `pi.on`）：`tool_call`(拦截/改参) `tool_result` `context` `input` `before_agent_start`(改系统提示词) `agent_settled`。
- **客户端命令（A 类）**：见 §2.2 表（~100 个）。
- **服务端推送（C 类）**：见 §2.5（ready/snapshot/snapshot_delta/message_delta/tool_delta/tool_status/conversations/notice/subagent_handoff/page_request/question_pending/file_content/scm_data/tool_info/models/settings_state/…/plugin_*）。

---

## 5. 与 pi-starter 的能力差距矩阵（把脚手架提升到这个高度的路线图）

> 图例：✅ 目标有且成熟 / ◑ 目标有部分 / ✖ pi-starter 缺。列出「要补什么」= 升级项。

| 能力域 | pi-starter | pi-web-ui | 升级要补 |
|---|---|---|---|
| 传输 | SSE 单向逐条 | WS 双向 + 快照驱动 + 增量 delta + 独立流式通道 | 快照 `UiState` 单源 + rev/seq 链 + 背压丢弃 + delta 通道 |
| 协议 | sse.ts 翻译表 | protocol.ts 类型单源 + 版本协商 + check 守护 | 定义 ClientMessage/ServerMessage 判别联合，前后端共类型 |
| 会话 | 单 session/并发 429 | 多对话并发/过户/子代理/项目归属 | 会话编排层（AgentService→ClientSession→Conversation） |
| 模型 | PI_MODELS 切换 | 多密钥/OAuth/项目记忆/思考强度 | provider 管理子系统 |
| 工具 | 少量自定义 + guard | 覆盖内置 + patch/LSP/eval/懒加载/看门狗 | 工具注册表 + ActiveSet + 覆盖链 + 看门狗 |
| 审批 | 硬编码正则 | 规则引擎 + 三档策略 + HITL 弹窗 | 规则库 + 评估引擎 + 策略状态 |
| 模式 | 无 | 计划模式/委派审阅/目标审查循环 | 会话级闸门 + 转录落盘 + 系统提示词软约束 |
| 终端 | 无(靠 bash) | node-pty 全套 + ConPTY 自愈 + 接管 bash | PTY 管理 + 微批 + 按键编码 |
| 后台任务 | 无 | 端口 diff + 父链过滤 + 自动清理 | BgServerTracker |
| 文件/附件/视觉 | 无 | 文件服务 + CAS + 视觉桥 + 归档 | 附件只给路径 + 预览协议 + 视觉转写 |
| SCM | 无 | git 只读 + watcher + AI 提交信息 | scm 服务 |
| 插件/MCP | extensions 静态登记 | 插件市场/授权/宿主 API/slot + MCP 桥 | 可扩展运行时（工程量最大） |
| 上下文工程 | 无 | 预算/软上限/压缩/悬空修复 | context-budget + compaction |
| 提示词 | persona+rules 静态 | compose 模板逐层覆盖 + 链式保全 | prompt-composer 纯函数引擎 |
| 安全 | 本地正则闸门 | loopback/Origin 校验/quiesce/控制 socket/token | 传输与准入安全层 |
| 运维 | dev/web/build CLI | 更新检查/托管/桌面/多部署 | 进程与发布运维 |

**优先级建议（落地顺序）**：
1. 先把「传输 + 协议单源 + 快照模型」立起来（§1.2/§2）——这是其余一切的骨架。
2. 再补「多对话并发会话编排」（§3.1）与「工具注册表 + 看门狗 + 审批规则引擎」（§3.3/§3.4）。
3. 然后按业务优先级增量补：上下文工程(§3.12)、提示词组合(§3.13)、模式(§3.5)、终端/后台任务(§3.6/§3.7)、文件/附件/视觉(§3.8)、SCM(§3.9)。
4. 插件系统(§3.10)与 DSH 双引擎(§3.17)是大工程，按需最后做。

---

## 6. 附录：目标项目 server/ 文件规模 Top（体量参考）

`agent-service.ts` 15398 · `plugins.ts` 4712 · `dsh/dsh-agent-service.ts` 4941 · `goal-service.ts` 2538 · `terminals.ts` 2330 · `model-admin.ts` 1937 · `lsp-tool.ts` 1678 · `index.ts` 3576 · `protocol.ts` 3373 · `files-service.ts` 1535 · `conversation-read-tool.ts` 1046 · `client-state.ts` 1454 · `preset-share.ts` 1437 · `settings-service.ts` 1040 · `subagents.ts` 926 · `hashline-engine.ts` 990。
