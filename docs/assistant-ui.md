# assistant-ui 采集文档（接口 / 用法 / 对接映射）

> 用途：为 pi-starter 前端选型②（assistant-ui）**先把接口和用法完整拿下来**，暂不实现。
> 来源：官方文档站 assistant-ui.com（本次可访问，且提供 `llms.txt` 文档索引）+ 网络搜索交叉。star/下载量/版本为信源所示，落地前以官方为准。
> 仓库：https://github.com/assistant-ui/assistant-ui ｜ 文档：https://www.assistant-ui.com/docs ｜ AI 索引：https://www.assistant-ui.com/llms.txt
> license：MIT（可选付费 Assistant Cloud 做托管持久化，非必需）。作者 Y Combinator W25，>5 万月下载，LangChain/Stack AI/Browser Use 在用。

---

## 0. 它是什么（一句话）
一个 **headless 的 React AI 聊天组件库**：给你 Radix/shadcn 式的**可组合 primitives + 一套 runtime 抽象**，UI 零件和流式/滚动/工具渲染/审批都替你做好，**后端随便接**（官方原话"当作你自己后端/流协议之上的可视化层"）。同一套 primitives 还有 React Native / Vue / 终端(Ink) 版。

---

## 1. 三层结构（理解这个就懂怎么接）
1. **Primitives / Components**：`Thread` `Message` `Composer` `ActionBar` `BranchPicker` `ThreadList` `Attachment` `MarkdownText` `ToolFallback`…（Radix 式，无样式或带 shadcn 起点主题，每像素可控）。
2. **Runtime**：把组件连到后端的中间层。你选/写一个 runtime，喂它消息与回调。
3. **后端适配器（adapters）**：官方对各家后端的现成 runtime（AI SDK、LangGraph、AG-UI…）+ **自定义 runtime**（接你自己的协议）。

---

## 2. 安装 / 脚手架
```bash
npx assistant-ui@latest create      # 新建一个 Next.js 项目（开箱）
npx assistant-ui@latest init        # 加到现有项目
npm install @assistant-ui/react @assistant-ui/react-ai-sdk   # 手动
```
最小挂载：
```tsx
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { Thread } from "@/components/assistant-ui/thread";
export function Chat() {
  const runtime = useChatRuntime();
  return <AssistantRuntimeProvider runtime={runtime}><Thread /></AssistantRuntimeProvider>;
}
```

---

## 3. Runtime 全景（**接后端的关键**）
官方 runtime 列表：Vercel AI SDK / LangGraph / LangChain / Eve / Google ADK / **AG-UI** / **A2A** / OpenCode / **Your own server(自定义)**。对 pi-starter，重点看三条：

### 3.1 ExternalStoreRuntime（自定义后端主力，字段最全）
`useExternalStoreRuntime<T>(adapter)` —— "你持有状态，adapter 负责和你的格式互转；UI 功能按你提供了哪些回调自动开启"。
`ExternalStoreAdapter` 关键字段（**逐条来自官方文档**）：
- `messages`：消息数组；`convertMessage(msg)`：你的格式 → `ThreadMessageLike`。
- `onNew(message: AppendMessage)`：用户发新消息（→ 你发 `prompt`）。
- `isRunning`：是否正在生成（true 时显示乐观 assistant 气泡）。
- `setMessages`：更新消息（**提供则分支切换开启**）。
- `onEdit` / `onReload` / `onCancel`：编辑 / 重新生成 / 取消（分别开启对应功能）。
- `onAddToolResult`：追加工具结果。
- **`onResumeToolCall({ toolCallId, payload })`**：恢复被挂起的工具调用——**这就是 HITL（人在环）工具执行的接入点**。
- `onResume(config)`：中断后恢复整轮。
- `adapters`：能力适配器 `attachments` / `speech` / `dictation` / `feedback` / `threadList`。
- `messageRepository` / `state` / `onImport` / `onExportExternalState` / `onLoadExternalState`：分支历史与外部状态导入导出。

`ThreadMessageLike`：`role` / `content`(string 或 parts[]) / `id` / `createdAt` / `status`(in_progress|complete|cancelled) / `attachments` / `metadata.steps`(工具调用步骤)。

### 3.2 多线程：ExternalStoreThreadListAdapter（对上 pi-starter 的多对话）
`threadId` / `threads[{threadId,title}]` / `archivedThreads` / `onSwitchToNewThread` / `onSwitchToThread` / `onRename` / `onArchive` / `onUnarchive` / `onDelete`。
→ 与 pi-starter 的 `new_conversation` / `open_conversation` / `switch_conversation` / `rename_conversation` / `close_conversation` / `conversations` 帧**一一对得上**。

### 3.3 其它 runtime 选项
- **LocalRuntime + ChatModelAdapter**：`{ run({messages, abortSignal}) { async generator 流式 yield } }`——最轻的"我自己实现一个模型调用"缝。
- **Data Stream（`@assistant-ui/react-data-stream` / `useDataStreamRuntime`）**：走 Vercel Data Stream 协议（`DataStreamDecoder` + `AssistantMessageAccumulator`）。
- **AG-UI（`@assistant-ui/react-ag-ui`）**：吃 AG-UI 事件流（RUN_STARTED/TEXT_MESSAGE_*/TOOL_CALL_*/STATE_DELTA/HITL interrupt）。**建议适配层按这套词表写**，将来可迁移。
- **AI SDK（`useChatRuntime` + `AssistantChatTransport`）**：默认连 `/api/chat`，可改 api/transport。

---

## 4. 工具 / Generative UI / HITL（**最贴 pi-starter 的部分**）
推荐用 **`Tools({ toolkit })` + `defineToolkit`**（集中注册、防重复、跨 runtime 通用；`makeAssistantTool` 为旧法）。每个工具条目：`type` / `description` / `parameters`(Zod) / `execute` / `render`。

三类工具：
| 类型 | 执行处 | 用途 |
|---|---|---|
| **frontend** | 浏览器 | agent 调它、前端弹交互（表单/确认），`addResult` 提交 |
| **backend** | 服务器 | 只写 `render`（UI-only），执行/结果在后端（如 MCP/你的工具） |
| **human tool** | 靠人 | `execute` 里 `const resp = await human(payload)` 暂停 → 用户 `resume(value)` 恢复 |

**HITL 两种官方机制**（都命中 pi-starter）：
1. **`human()` / `resume()` / `addResult()`**：工具执行中途暂停等用户输入/确认 → 对应你的 **`extension_ui_request`（ask_user_question 反问）**。
2. **服务端审批门 `toolApproval` + `respondToApproval({ approved, reason })`**（AI SDK v7 gated tools）：`approval.approved` 三态 `undefined`(问用户)/`true`(放行)/`false`(拒绝，可带 reason)，`isAutomatic` 表示策略自动放行 → 对应你的 **`approval_request`（allow/deny/modify + 档位）**。

**Generative UI**：把 tool 调用/JSON 渲染成任意 React 组件（图表/卡片/表格）——"以后要可视化"这条 ②本身就支持，不必换框架。
**ToolFallback**：没给自定义 UI 时的默认工具渲染。

---

## 5. 其它能力（按需）
- **附件**：`adapters.attachments`（`SimpleImageAttachmentAdapter`/`SimpleTextAttachmentAdapter`/`CompositeAttachmentAdapter`）→ 对上 pi-starter 的 prompt images。
- **语音**：`speech`/`dictation`（Web Speech / ElevenLabs 适配）。
- **反馈**：`feedback`（消息点赞/踩）。
- **分支/编辑/重生成**：由 `setMessages`/`onEdit`/`onReload` 自动开启 → 对上你的 `edit_message`/`rollback_conversation`/`fork_conversation`。
- **主题**：shadcn/ui + Tailwind，CLI 生成起点主题，可完全改皮。

---

## 6. 包清单
`@assistant-ui/react`（核心）· `react-ai-sdk` · `react-langgraph` · `react-langchain` · **`react-ag-ui`** · `react-a2a` · `react-google-adk` · `react-opencode` · **`react-data-stream`** · `react-native` · `react-ink`(终端) · `@assistant-ui/vite`。

---

## 7. 与 pi-starter 后端的对接映射（把接口"对上"）
| pi-starter `/ws` 帧 | assistant-ui 落点 |
|---|---|
| `snapshot.messages` | `ExternalStoreAdapter.messages` + `convertMessage` |
| `prompt`（发一条） | `onNew(message)` |
| text/thinking 增量（`snapshot_delta`/`tool_delta`） | 流式更新 `messages`（或走 AG-UI 事件） |
| `run_start` / `run_end` | `isRunning` 置 true/false |
| `tool_status` / `tool_delta` | backend tool 的 `render({status,result})` |
| **`approval_request`** | **`toolApproval` + `respondToApproval`** |
| **`extension_ui_request`**（ask_user_question） | **human tool `human()` / `resume()`** |
| `conversations` / `new/open/switch/rename/close` | `ExternalStoreThreadListAdapter` |
| `prompt(replaceEntryId)`（原子"替换并重发"）/ `rollback` / `fork` | `onEdit` / `onReload` / `setMessages`(分支) |
| prompt images | `adapters.attachments` |
| `models` / `capabilities` / `settings_state` | 控制面：assistant-ui 不管，你自绘面板（React 组件） |

**落地形态（一句话）**：写一个 **`useExternalStoreRuntime` adapter**（或 AG-UI runtime），内部维护一条到 pi-starter `/ws` 的连接，把上表右侧回调/状态接起来；控制面（模型/能力/设置）自己画几个 React 面板。**不改后端。**

---

## 8. 待核实（实现阶段确认）
- `Tools({ toolkit })` / `defineToolkit` 的确切签名与 `respondToApproval` 在不同 runtime（尤其自定义 runtime）下的支持度（文档提到"审批门需要实现它的 runtime：AI SDK v7 会 emit；LocalRuntime 可用 `unstable_humanToolNames`+`addResult`"）。
- 自定义 runtime 走 WS（非 SSE/Data Stream）时的最佳接法（`useExternalStoreRuntime` 手动喂 vs 包一个 AG-UI/自定义 transport）。
- 版本锁：assistant-ui 迭代快，落地时钉具体版本 + 读 `/llms.txt` 对应 `.md` 页。
