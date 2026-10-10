# diagram-input.md — pi-starter 出图前蓝图（唯一输入源）

> 本文件由当前目录原始材料提炼而来，**只整理不画图**。它是后续所有出图（架构图 / 时序图 / 数据流图 / 生命周期图）的唯一输入源。术语一律逐字照抄原文（含大小写、下标、缩写、`()`）。
> 材料基线：`v0.4.2`（`ce8ccf1`，2026-10-11），Node `>=22.19`。

---

## 0. 探测结论（材料类型与干扰项）

- **绘图对象**：本仓库系统 `pi-starter`（基于 `@earendil-works/pi-coding-agent` SDK 的 Agent 脚手架），非论文、非口头描述。
- **主要材料**：项目代码（`src/` 结构）、`README.md` / `README.zh-CN.md`、`docs/能力与边界.md`（唯一仍维护的对照文档）、`docs/project_overview/index.html`、三份图生成器 `scripts/visualization/generate_{architecture,request_flow,retrieval}.mjs`（结构权威来源）。
- **判定的干扰项（不进蓝图）**：见「第 6 块 明确排除项」。

---

## 1. 组件清单（`模块ID｜名称｜一句话职责（类型）`）

- `E-CLI｜CLI 交互对话｜` 进程内交互式对话入口（后端·入口）
- `E-HTTP｜HTTP + SSE｜` REST 资源接口 + `POST /chat` SSE 流（后端·入口）
- `E-WS｜WebSocket｜` 快照驱动双向传输，一连接多对话（后端·入口）
- `E-LIB｜Library｜` 库导出 `buildAgent` / `createApp`，业务经参数注入（后端·入口）
- `E-RPC｜RPC stdio｜` 官方 `runRpcMode` 的 stdio JSONL，跨语言/子进程（后端·入口）
- `A-ASM｜buildAgent()｜` 单一装配核心：model + prompts + tools + skills + knowledge(+retrieval) + memory + database + extensions → `AgentSession`（后端·核心）
- `C-CONV｜Conversation｜` 唯一回合引擎：SDK 事件 → 快照投影、steer、follow-up、abort（后端·核心）
- `C-SDK｜createAgentSession（SDK）｜` 官方会话内核，`session.prompt(userMessage)`（外部·核心）
- `S-HUB｜SessionHub｜` 每客户端多对话编排，上限 + LRU、重启恢复（后端·会话栈）
- `S-CS｜ClientSession｜` 单条 WS 连接的对话集合与槽位准入（后端·会话栈）
- `S-SNAP｜SnapshotEmitter｜` 快照发射器：delta vs full、节流、`rev` 链（后端·会话栈）
- `W-WS｜transport/ws.ts｜` WS 传输：hello→ready、背压丢弃、Origin 校验（后端·传输）
- `W-PROT｜protocol.ts｜` WS/REST 消息类型单一真源，编译期完备性断言（后端·契约）
- `K-APP｜app.ts HTTP 路由｜` REST 路由处理器（`GET /health` / `/info` / `/skills` / `/knowledge` / `/db` / `POST /model` / `POST /chat`）（后端·契约）
- `K-SSE｜sse.ts translateEvent()｜` agent 事件 → SSE 协议帧 / 原始 NDJSON（`?format=jsonl`）（后端·契约）
- `R-TOOLS｜src/tools｜` 可插拔工具：`current_time` / `search_knowledge` / `read_knowledge` / `db_status` / `db_query` / `remember` / `recall` / `exec` / `exec_jobs` / `exec_stop` / `web_fetch` / `web_search` / `ask_user_question`（后端·资源）
- `R-REG｜ToolRegistry｜` 工具能力标签、运行中开关，注册进 `allTools`（后端·资源）
- `R-KB｜src/knowledge 检索｜` 可插拔 `Retriever`：`KeywordRetriever`（默认零依赖）/ `VectorRetriever`（opt-in）（后端·资源）
- `R-MEM｜src/memory｜` 跨会话事实 `remember` / `recall`，原子写、owner-only 文件位（存储·资源）
- `R-DB｜src/db｜` `node:sqlite`，默认 in-memory，只读 SQL（CTE 内写也拦）（存储·资源）
- `R-SKILL｜skills + prompt-templates + prompts｜` `SKILL.md`（SDK `additionalSkillPaths`）、`/name` 模板（`additionalPromptTemplatePaths`）、分层系统提示 `persona.md`+`rules.md`（后端·资源）
- `X-EXT｜extensions｜` `guard`（`tool_call` 拦截：危险 bash / 路径逃逸 / 敏感文件名单）、`audit`（`tool_result` 计时日志）（后端·护栏）
- `X-APPR｜approval gate｜` `rules → policy → gate` 六匹配器、`deny` 关不掉、超时按 deny + 工具看门狗（后端·护栏）
- `X-MODE｜plan-mode + subagents + MCP bridge｜` 会话级只规划硬闸门 / `delegate_task` 独立预算 / stdio MCP 接入热生效（后端·扩展）
- `F-WEB｜web/ 前端｜` Vite + React + assistant-ui，`ExternalStoreRuntime` over `/ws`，复用 `src/protocol.ts`（前端）
- `X-PROV｜ModelRuntime / providers｜` 官方模型运行时：`getAvailable()` / `setModel()` / `setRuntimeApiKey()` / `getProviders`/`checkAuth`、`scopedModels` 轮换 `cycleModel`（外部·运行时）
- `X-VS｜向量后端与外部服务｜` `EmbeddingProvider`（`OpenAICompatEmbeddings`/`OllamaEmbeddings`/`TransformersEmbeddings`）、`VectorStore`（`InMemoryVectorStore`/`SqliteVectorStore`）、搜索后端注入（外部·运行时）

> **主节点（≤12）映射**：出图主框取
> ① `E-* 入口传输`（5 传输合 1 组）② `A-ASM` ③ `C-CONV + C-SDK` ④ `S-* 会话栈`（HUB/CS/SNAP 合 1 组）⑤ `R-TOOLS + R-REG` ⑥ `R-KB` ⑦ `R-MEM + R-DB`（存储合 1 组）⑧ `R-SKILL` ⑨ `X-EXT + X-APPR + X-MODE`（护栏与模式合 1 组）⑩ `K-APP + K-SSE + W-*`（线协议合 1 组）⑪ `F-WEB` ⑫ `X-PROV + X-VS`（外部运行时合 1 组）。
> 合并内容详境见「第 6 块」。

---

## 2. 关系清单（`A → B：传递什么 / 触发什么（实线主路径 or 虚线反馈）`）

- `E-CLI/E-HTTP/E-WS/E-LIB/E-RPC → A-ASM`：调用 `buildAgent({...})` 装配（实线主路径）
- `A-ASM → C-SDK`：产出 `AgentSession`；`session.prompt(userMessage)` 驱动回合（实线主路径）
- `A-ASM → R-TOOLS / R-KB / R-MEM / R-DB / R-SKILL / X-EXT`：注入可组合资源（实线主路径）
- `C-SDK → X-EXT`：`event: tool_call` → `pi.on("tool_call", …)` → `{ block?, mutate? }`（实线主路径）
- `X-EXT(guard) → R-TOOLS`：`allowed → execute tool`（实线主路径）；命中危险/逃逸则 `block: true`（虚线反馈）
- `R-TOOLS → C-SDK`：`tool result`（虚线反馈，`text preview capped at 500 chars` = `TOOL_RESULT_PREVIEW_LIMIT`）
- `C-SDK → X-EXT(audit)`：`event: tool_result` → `pi.on("tool_result", …)` → rewrite?（实线主路径）
- `C-SDK → K-SSE`：`message_update / tool_execution_*` → `translateEvent(event)` → SSE 帧（实线主路径）
- `K-SSE → E-HTTP/E-WS(client)`：`data: {type,data}\n\n`，SSE 词表 `text` `thinking` `tool_start` `tool_end` `done` `error`（实线主路径）
- `E-WS ↔ S-CS ↔ S-HUB ↔ C-CONV ↔ S-SNAP ↔ W-WS`：快照 + `rev` 链、增量 delta、背压丢弃（实线主路径）
- `F-WEB → W-WS`：浏览器经 `/ws` 说同一 `protocol.ts` 类型（实线主路径）
- `A-ASM → X-PROV`：`session.setModel()` / `setRuntimeApiKey()` / `cycleModel()` 运行中切换（实线主路径）
- `R-KB → X-VS`：`VectorRetriever`（`PI_KNOWLEDGE_RETRIEVAL=vector`）compose `EmbeddingProvider` + `VectorStore`：chunk → embed → cosine → aggregate by doc（实线主路径）
- `X-MODE(MCP) → R-REG`：MCP 工具注册 `source: "dynamic"`，只对新建会话生效（虚线反馈）
- `X-APPR → X-EXT`：审批规则首个命中决定 allow/deny/ask（虚线反馈）
- `R-TOOLS(ask_user_question) → 人类`：官方 `ctx.ui` / `ExtensionUIContext`，经 WS `extension_ui_request`/`extension_ui_response` 反问阻塞等输入（虚线反馈）

---

## 3. 分层分组（供 boundaries 用）

- **入口层（Entry / Transports）**：`E-CLI`、`E-HTTP`、`E-WS`、`E-LIB`、`E-RPC`
- **装配核心层（Assembly）**：`A-ASM`
- **回合与会话内核层（Core）**：`C-CONV`、`C-SDK`；**会话栈子层**：`S-HUB`、`S-CS`、`S-SNAP`
- **业务资源层（Injectable Resources）**：`R-TOOLS`+`R-REG`、`R-KB`、`R-MEM`+`R-DB`、`R-SKILL`
- **护栏与模式层（Guardrail & Modes）**：`X-EXT`、`X-APPR`、`X-MODE`
- **线协议层（Wire contract）**：`K-APP`、`K-SSE`、`W-WS`、`W-PROT`
- **前端层（Frontend）**：`F-WEB`
- **外部运行时层（External runtime）**：`X-PROV`、`X-VS`

---

## 4. 主流程（`POST /chat` 回合生命周期，按步骤编号）

- ① Client → Express app：`POST /chat { message }`（`Content-Type: application/json`）
- ② Express app 自检：`busy? → 429`（忙闸）
- ③ **核心** Express app → Agent session：`session.prompt(userMessage)`
- ④ Agent session → Extensions：`event: tool_call`，`pi.on("tool_call", …) → { block?, mutate? }`
- ⑤ Extensions(guard) → Tool：`allowed → execute tool`
- ⑥ Tool → Agent session：`tool result`（`text preview capped at 500 chars`）（虚线反馈）
- ⑦ Agent session → Extensions(audit)：`event: tool_result`，`pi.on("tool_result", …) → rewrite?`
- ⑧ **核心** Agent session → SSE translator：`message_update / tool_execution_*`
- ⑨ **核心** SSE translator 自检：`translateEvent(event)`
- ⑩ SSE translator → Client：`SSE frames`（`data: {type,data}\n\n`）

> 标注：③（进入唯一回合引擎）与 ⑨（`translateEvent()` 把内部事件收敛成对外协议）是核心环节——所有入口最终都汇到这两步，且协议词表在此定型。

---

## 5. 关键术语（必须逐字出现在图上，含大小写/下标/缩写/括号）

- 装配与内核：`buildAgent`、`createApp`、`createAgentSession`、`AgentSession`、`session.prompt`、`translateEvent()`、`Conversation`、`SnapshotEmitter`、`SessionHub`、`ClientSession`、`rev`、`scopedModels`、`cycleModel`
- 入口/文件路径：`src/agent.ts`、`src/app.ts`、`src/sse.ts`、`src/protocol.ts`、`src/transport/ws.ts`、`POST /chat`、`?format=jsonl`、`GET /health`、`/health/ready`、`/info`、`/skills`、`/knowledge`、`/db`、`POST /model`
- SSE 事件词表：`text`、`thinking`、`tool_start`、`tool_end`、`done`、`error`
- 钩子与预览上限：`pi.on("tool_call", …)`、`pi.on("tool_result", …)`、`TOOL_RESULT_PREVIEW_LIMIT`、`500`
- 检索接口：`Retriever`、`search(query, limit)`、`KeywordRetriever`、`VectorRetriever`、`EmbeddingProvider`、`VectorStore`、`InMemoryVectorStore`、`SqliteVectorStore`、`OpenAICompatEmbeddings`、`OllamaEmbeddings`、`TransformersEmbeddings`、`PI_KNOWLEDGE_RETRIEVAL=vector`、`search_knowledge`、`read_knowledge`、`GET /knowledge/search`
- 护栏/模式/扩展：`guard`、`audit`、`block: true`、`deny`、`FileService`、`node:sqlite`、`MCP`、`delegate_task`、`plan-mode`、`ask_user_question`、`ctx.ui`、`ExtensionUIContext`、`extension_ui_request`、`extension_ui_response`、`remember`、`recall`、`web_fetch`、`web_search`
- 模型运行时：`ModelRuntime`、`getAvailable()`、`setModel()`、`setRuntimeApiKey()`、`getProviders`、`checkAuth`
- 前端：`web/`、`assistant-ui`、`ExternalStoreRuntime`、`/ws`

---

## 6. 明确排除项（不画什么及原因）

- **测试 / 覆盖率 / e2e / smoke 断言数**（`505 cases`、`23` smoke、`48` e2e、覆盖率阈值、`npm run verify` 门禁列表）：属质量保障，非系统结构，不入架构/数据流图。
- **日志与运维**（`log.ts`、`log-sink-file.ts`、`/metrics`、`/logs`、结构化日志脱敏）：可观测性侧支，默认不进主图；如需仅作为一条 `X-*` 注记。
- **配置与环境变量全集**（`.env` 键、`PI_*` 全集、`settings.ts`、`pipeline.config.json`、`.cnb.yml`、`ci.yml`、`Dockerfile`、`dist/`）：部署/配置面，非组件关系；仅保留图中已点名的 `PI_KNOWLEDGE_RETRIEVAL=vector` 等作为触发标签。
- **对照对象 pi-web-ui**（`docs/能力与边界.md` 第 2、4 节「对方有什么」整列、`agent-service.ts`/`goal-service.ts`/`plugins.ts` 规模对比）：不是本系统的组成部分，全部排除。
- **刻意不做项**（登录、多用户、真沙箱、交互式 PTY、插件市场、第二引擎、Electron、定时任务、OAuth、支付、goal-review 循环）：边界外，不画节点。
- **历史/参考稿**（`docs/项目分析报告.md` 归档 pre-0.3.0、`docs/前端调研.md`、`docs/assistant-ui.md`、`docs/engineering-review.md`、§7「已删除旧稿」）：过时结论来源，排除。
- **`*.example.ts` 扩展接缝**（`sandbox.example.ts`、`custom-provider.example.ts`、`provider-hooks.example.ts`、`input-resources.example.ts`、`tool-result-redaction.example.ts`、`hooks.example`、`example-command.ts`）：默认不接线，属可选接缝，不单列为主节点（归入 `X-EXT` 概念）。
- **主节点合并（为守 ≤12 而做的合并，可按需拆回）**：
  - 5 个入口（`E-CLI/E-HTTP/E-WS/E-LIB/E-RPC`）→ 入口层组节点；
  - `C-CONV` 与 `C-SDK` → 「回合引擎 / AgentSession」一组；
  - `S-HUB/S-CS/S-SNAP` → 会话栈一组；
  - `R-MEM` 与 `R-DB` → 「可持久化存储」一组；
  - `X-EXT/X-APPR/X-MODE` → 「护栏与运行模式」一组；
  - `K-APP/K-SSE/W-WS/W-PROT` → 「线协议层」一组；
  - `X-PROV/X-VS` → 「外部运行时/后端」一组。
- **`entry_appended`**：只刷新标题、不发协议帧，非并行前端信号，排除出事件词表。

---

## 待确认清单（材料不足以判断时，每条附默认处理）

1. **出图范围**：只画「分层架构」一张，还是「分层架构 + 第 4 块请求生命周期」两张？—— 默认：同一蓝图分别供架构图与生命周期/时序图各出一次。
2. **web/ 前端**：作为独立前端节点，还是只画后端把 `web/` 归入「外部客户端」？—— 默认：保留 `F-WEB` 为一个主节点。
3. **存储与外部后端的粒度**：`database` / 向量后端 / `MCP` 是否合并进组节点（当前为守 ≤12 已合并）。—— 默认：合并为组节点，子标签列出真实类名。
4. **护栏展开度**：`guard` / `approval gate` / `plan-mode` / `subagents` 是否拆成独立框（当前合并为 1 组）。—— 默认：合并为「护栏与模式」一组；若受众需强调审批，可单独提为一张子图。
5. **头部标注版本口径**：图上版本徽章取 `v0.4.2` / Node `>=22.19`。—— 默认：按材料基线 `v0.4.2` 标注；换图类型时数值仍从 `scripts/visualization/metrics.mjs` 取，不手抄。
