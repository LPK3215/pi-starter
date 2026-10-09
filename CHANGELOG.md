# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **产品前端 `web/`（Vite + React + assistant-ui）**：补齐与后端同源对话 UI。形态是**仓库内独立 npm 项目**（自己的 `package.json` / `tsconfig` / `node_modules`），后端管道（`verify` / Docker / npm 发布）对它零感知；线协议不重建翻译表，`web/tsconfig.app.json` 直接把 `src/protocol.ts` 映射为 `@pi/protocol`，前后端共用同一份类型。
  - **选型**：assistant-ui 自定义后端的四条路里取 **`ExternalStoreRuntime`**——消息权威状态在后端快照里，前端只做翻译与回调转发。`LocalRuntime` 会自己管消息状态、与 snapshot/rollback/fork 语义打架；DataStream 与 AssistantTransport 都要求后端改吐它的线格式，违反“不改后端”。
  - **手写胶水只有两个文件**：`web/src/pi/client.ts`（WS 客户端：`hello`→`ready` 握手、`rev`/`baseRev` 修订链断链自愈、`message_delta` 与快照的归属关系、退避重连）与 `web/src/pi/usePiRuntime.ts`（快照→`ExternalStoreAdapter`，含 `adapters.threadList` 多对话）。控制面（模型/思考档/计划模式/上下文预算）与审批、HITL 反问按官方口径自绘，不走 runtime。
  - **接线**：`src/app.ts` 的 `staticDir` 默认值从已删除的示例页改为 `web/dist`（`express.static` 对不存在目录静默穿透，未构建前端不影响接口）；新增 `ui:dev` / `ui:build` 脚本；Dockerfile 加 `web-builder` 阶段（必须连 `src/protocol.ts` 一起拷，否则前端编译失败）。
  - **验证**：`app.test.ts` 新增 2 项静态挂载契约（显式目录回首页 / 目录不存在时 API 照常且 `GET /` 回 404）；`web/scripts/probe-ws.mjs` 走 Vite 代理跑真实一轮，打印帧序列/流式行数/逐条消息角色与长度/stats；浏览器端到端实测连接、发送、流式逐步增长、中止、Markdown 渲染、多对话切换均无 console error。
  - **实测修正（三轮验收）**：① user 消息不能带 `status`，runtime 硬性禁止，否则抛错并卸载整棵树（现已加 ErrorBoundary 兜住）；② “只调工具的那一轮”在后端快照里就是一条 `len=0` 的 assistant 消息（探针实证：`#0 user len=18 | #1 assistant len=0 | #2 assistant len=34`），所以上轮出现空白气泡——现给“（本轮无文本输出）”占位，这不是渲染缺陷而是协议真实形状；③ 工具属于**运行级**事件且多轮 ReAct 里恰在两轮之间执行，那一刻流式尾消息为空，因此改为独立的运行轨迹条；④ 切/建会话必须同时重置 `rev` **和** `state`，只重置 `rev` 会让新会话的 `snapshot_delta` 跳过链校验、把增量拼到旧会话的 messages 上（消息串会话）。
  - **踩到的坑（已写进 README）**：后端 `originAllowed` 要求 Origin 的 host 等于请求 Host，Vite 代理开 `changeOrigin` 会使浏览器握手被 403、而不带 `Origin` 的脚本客户端却正常——“脚本能连、浏览器不能连”的不对称现象即源于此。
  - **边界（诚实标注）**：审批与反问仍自绘卡片（后端不下发“哪条消息在等审批”的 tool-call 定位信息，官方 `toolApproval` / human tool 通道需要 tool part 归属）。~~工具轨迹快照不持久化~~ 已由后面的“快照携带思维链与工具调用”解决。未接 `onEdit`/`onReload`/`setMessages`（对应 UI 的编辑/重生成/分支自动关闭）：后端 `edit_message` 的语义是“回滚到该条 + 原文交回输入框、不自动再发一轮”，与 assistant-ui 期望的“编辑即新一轮”不等价，硬接会得到与后端会话树不一致的分支。样式层初始为手写的 Tailwind token，现已换用官方 registry 组件与 base-nova 主题（见下条）。

- **快照携带思维链与工具调用（`UiMessage` 扩字段）**：前端“看不到思考过程 / 工具过程、刷新后全没”的根因不在组件库（官方 Reasoning / ToolGroup 一直在），而在**后端没把这些数据交出来**：`projectMessage` 用 `extractText` 只取 `text` parts，把 SDK 已经给到会话里的 `thinking` 与 `toolCall` 全丢了，工具结果则躺在另一条 `toolResult` 消息里从未被归回。
  - **协议**：`UiMessage` 新增可选 `thinking` / `calls` / `stopReason`，并新增 `UiToolCall`（`id`/`name`/`args`/`result`/`isError`/`durationMs`）。全部是**可选字段**，旧客户端不读它们行为逐字不变，故 `PROTOCOL_VERSION` 仍为 1。
  - **投影**：`projectParts` 拆 `thinking`/`toolCall` parts；`currentMessages()` 先扫一遍 `session.messages` 把 `toolResult` 按 `toolCallId` 配成一张表，再归回发起调用的那条 assistant 消息（含 `isError` 与服务端实测的 `durationMs`）。
  - **一个必须注意的正确性点**：工具结果到达时，那条 assistant 消息**已经在上一份快照里发出去了**。若原地改缓存对象，对象引用不变，SnapshotEmitter 的“仅追加”快路径会认为历史未变，新结果永远发不到客户端。所以投影带了一个内容签名（文本/思维链/调用数/已配对数/停止原因/entryId），**签名一变就换新对象**，让增量判定自然失效。`adoptTree`（回退/编辑）与压缩两处缓存重置同步作废。
  - **流式思维链**：以前 `thinking_delta` 只转发不累加，快照的 `streamingMessage` 永远没有思维链；新增 `streamingThinking` 缓冲，与 `streamingText` 同生命周期（`agent_start`/`message_end`/`agent_end` 重置）。
  - **前端**：`convertMessage` 改为从消息自身读 `thinking`/`calls`（刷新后官方区块仍完整），并去掉“（本轮无文本输出）”占位：空内容消息直接不占气泡；`stopReason` 为 `error`/`aborted` 时给可读的失败/中止提示，不再把上游故障说成“模型没说话”；连续多条失败记录只留最新一条。
  - **本轮自己引入又修掉的截断 bug**：`projectMessages` 里流式文本错写成优先取 `state.streamingMessage?.text`（那是**快照生成那一刻**的旧值），把快照之后到达的 `message_delta` 全丢掉了——实测带工具轮的最终答复实时只显示“现在是”，F5 后才是全句。思维链那一行当时写对了（本地优先），文本行写反了。修为两者都以本地累加缓冲为准；不刷新的实时视图与刷新后的文本已逐字等值（codePoint 对比）。
  - **思考档控件**：`ControlBar` 的档位从只读文本改为可选下拉（协议早就有 `set_thinking`）。实测发现不支持 reasoning 的模型会被 SDK 直接回退（请求 `high` 后权威快照仍是 `off`），所以下拉**必须显示服务端回传值**并标注回退，否则用户只会觉得“下拉框坏了”。探针新增 `PI_SET_THINKING` 以验证这件事。
  - **验证**：`integration.test.ts` 新增一项，断言快照里工具轮消息带 `thinking`、`calls[0].args`、配对到的 `result` 与 `durationMs`，且 `toolResult` 不会作为独立消息出现；`npm run verify` 全绿。浏览器实测：思维链与 `1 tool call` 区块均渲染，**F5 刷新后仍完整**，“（本轮无文本输出）”不再出现，无空白气泡，控制台零 error/零 warning。

- **官方 registry 组件与 base-nova 主题接入**：把对话 UI 换为 assistant-ui 官方组件源码（落在本地后归我们自由改），`src/pi/` 适配层一行未动——这正是 ExternalStore 分离的回报。
  - **安装路径**：`npx shadcn@latest init -f -y -b base --no-monorepo --no-reinstall` + `add @assistant-ui/thread @assistant-ui/thread-list`。非交互 shell 里必须把两个回答型旗标都给全（`-f` 答“覆盖 components.json”、`--no-reinstall` 答“是否重装”），否则卡在隐藏提示上；新版 `-b` 是组件库（base/radix/aria）而不是 base color，`-d/--defaults` 会连带把 template 设成 next，不要用。
  - **踩到的 registry 坑（装完是 6 个 TS2307）**：CLI 把文件平铺到 `src/components/`，但组件内部引用同时混用两种基准——`.aui` 文件走 `@/components/assistant-ui/elements/...`，而 `file/image/markdown-text/tooltip-icon-button` 走 `@/components/...`、`image.tsx` 走 `../utils/href`。不能整体搬到一个目录，得按**每个文件自身的 import 行**逐个归位（registry JSON 只声明入口文件，依赖文件的真实路径以代码为准）。Base UI 的 Tooltip 必须有 Provider 祖先，接官方组件时必须在 App 包一层 `TooltipProvider`。
  - **主题去重**：`shadcn init` 是合并而非覆写 `index.css`（自定义的 `--color-ok/--color-warning` 仍然存活），但它自己的 `@theme inline` 在后——Tailwind v4 后声明者胜，所以项目原有的 `--color-background/card/border/...` 全被官方表覆盖。留下“看着在起作用其实不生效”的重复定义比删掉更危险，已只保留官方表没有的两个状态色与 `--font-mono`；Geist 无 CJK 字形，字体栈必须接回系统中文字体。
  - **第二轮验收又挖出两个自己的 bug**：① 消息 id 在流式/定稿之间换身份（流式用位置 id、定稿改用 `entryId`），runtime 把同一条消息当成两条，BranchPicker 出现 `2 / 2`、`3 / 3` 且左右箭头全 disabled 的幻影分支——改为全程用会话内位置 id；② 工具轨迹条写在自己那份 `thread.tsx` 里，接上官方组件后整个文件不再被挂载，轨迹条就静默消失了——上移到 App 层（`pi-panels`），两种 Thread 实现共用；同时删除“按消息归档工具”那套从未产出可见结果的逻辑，并取消 `run_end` 清空轨迹（瞬时工具几毫秒完事，一清就整个人看不见）。
  - **复验（浏览器 DOM 级）**：工具胶囊回复结束后常驻（`● current_time 1ms`，下一轮刷成新轮）、幻影分支 0 个、Tooltip 正常无 provider 报错、提示条实测 9009ms 自动收起、控制台零 error/零 warning。过程中有一轮被**上游模型超时**阻断（`run_end stopReason:"error"`，重试 3 次全败、4 个模型同现），用探针确认自行恢复后重跑，未将上游问题误归因于前端。
  - **逐字节对齐官方发布（新增两个脚本）**：`shadcn add` 会改写 import 路径并把文件平铺，拿 registry 内容作基准一比，实测 17 个文件里只有 6 个完全一致：5 个只差 import 写法，`href.ts` 缺头部注释，`thread-list.aui.tsx` 更是有 Base UI `render` vs 官方 `asChild` 的**组件风味差异**——“样式跟官方一样”不能靠眼看。因此新增：`scripts/sync-official-components.mjs`（按 registry 声明的 path + content 原样重写）与 `scripts/check-registry-sync.mjs`（比对，有修改/缺失则退出码 1），并登记为 `npm run sync:official` / `check:official`。同步后复跑：**一致 17 / 内容不同 0 / 本地缺失 0**（换行归一后比较；CLI 在 Windows 落盘 CRLF，不归一会 15 个全误报）。registry 的依赖有两种形态：绝对 URL（本 registry 的件）与裸名（shadcn 内置件，不属本 registry，只标注不比对）。
  - **会话列表换成官方 ThreadList**：实测 New / 切换 / 搜索过滤均正常，无消息串台。官方按 Today/Yesterday/Earlier 分组不生效——`lastMessageAt` 只在 remote/cloud 线程列表里被装配，`runtimes/external-store` 下 0 处引用，而官方 `useThreadListGroups` 自带“无日期则按 runtime 顺序平铺”的分支，所以平铺就是官方对外部状态主机的正确行为，不是我们的缺失。
  - **工具区块归属修正（官方 ToolGroup 以前从不渲染）**：后端把工具轮存成一条空文本 assistant 消息，而 `tool_status` 到达时该条往往已定稿，原来只挂“流式尾条”的规则使官方 ToolGroup/chain-of-thought 永远收不到 tool part。现按后端真实形状找宿主（优先最后一条空文本 assistant 消息，再退回流式尾条）；复验得到折叠条 `1 tool call` 展开后 `✓ Used tool: current_time`，且该条不再显示“（本轮无文本输出）”占位。另：瞬时工具无 `tool_delta` 输出时 `result` 不能留空，否则官方 ToolFallback 停在“Waiting on tool”并渲染空面板，现填入实际知道的事实（完成与耗时），不假装是工具输出。
  - **上游抖动的处理**：模型侧间歇返回空轮（费用 ¥0.0000、无 tool_status），同一句话重发即可恢复；验收先跑 `probe-ws.mjs` 确认后端能发出 `tool_status` 再去浏览器，避免把上游问题当成前端缺陷。
  - **未改的已知不足**：轮次以 error 结束时，UI 只有“（本轮无文本输出）”，看不出是模型请求失败。没有可用上游就无法验证修改，所以本轮不做无法验证的改动。

- **HITL 反问（`ask_user_question`，走官方 `ctx.ui`）**：补齐"智能体在回合中途向人类发问、阻塞等输入再继续"的能力。**不自己造等待/回收机制**——官方 SDK 原生提供 `ExtensionUIContext`（`ctx.ui.input/select/confirm/editor`，带 `timeout`/`AbortSignal`），但只给 TUI 与 RPC 子进程两种模式配了"谁来回答"；本项目跑进程内 + WS，属官方未附带实现的模式，故补一个 WS 版实现。
  - **桥**：`src/extension-ui-bridge.ts` 逐字复刻官方 `rpc-mode` 的 `createDialogPromise` 语义（`id`→resolver 挂起表、超时/断开/取消一律回官方默认值 undefined/false，**fail-safe 不挂死**，定时器刻意不 unref）；只搬运四类对话框 + notify，其余 TUI 专属方法按官方 RPC 模式降级为 no-op。
  - **协议**：`protocol.ts` 新增 `extension_ui_request`（服务端→客户端）/ `extension_ui_response`（客户端→服务端）两帧，线形逐字对齐官方 `RpcExtensionUIRequest/Response`；同步进内置命令完备性断言。
  - **工具**：`src/tools/ask-user-question.ts` 用 `defineTool` 调 `ctx.ui.*`，`ctx.hasUI` 为假时优雅降级（提示模型改用正常回复收尾），取消/超时返回"未作答"。登记进 `allTools`（三档白名单自动放行 + `human.input` 能力）；`session-hub.ts` 里早已存在的 `ask_user_question` 看门狗豁免占位，至此有了真身。
  - **接线**：`buildAgent({ extensionUi })` 在建会话后用 `extensionRunner.setUIContext(uiContext, "rpc")` 注入（**不用 `session.bindExtensions`——后者每次重放 `session_start` 并跑 `resources_discover`，会给审计/守卫/审批重复触发启动逻辑**）；`server.ts` 建桥 + 延迟广播（同 `approvalSink`）+ 停机 `dispose`；`ws.ts` 加 `notifyUiRequest` 广播 + `case "extension_ui_response"` 路由到 `uiBridge.resolve`。**审批链路一行未动**，二者共用同一等待范式但互不依赖。
  - **验证**：`extension-ui-bridge.test.ts` 10 项单测（应答/id 匹配/取消/超时/断开/回收/notify，改回缺陷即变红）；`smoke` 加 4 项真 WS 闭环（`ctx.ui.input`→广播 `extension_ui_request`→客户端应答→唤醒拿到输入 / 超时回默认 / 未知 id 回提示帧），17→21。`npm run verify` 全绿。
  - **边界**：UI 反问**未做快照持久化**（不像审批把待决卡片存进 `pendingApproval`）：断线重连期间的未答问题靠超时/断开兜底。前端侧已在 `web/` 接上（自绘反问弹窗收发 `extension_ui_request`/`extension_ui_response`，见本轮前端条目）。
- **官方 SDK 能力面补齐（第二轮对照，按 `官方SDK接口文档.md` 逐节实证核对）**：把官方提供、脚手架未接的能力全部补齐。字段名一律以 `dist/*.d.ts` 为准（文档正文的 Settings 字段名与真源有出入，已按真实定义实现）。
  - **SDK 设置透传（A）**：`buildAgent({ sdkSettings })` 把官方 `Settings` 的 `compaction{enabled,reserveTokens,keepRecentTokens}`/`retry{enabled,maxRetries,baseDelayMs}`/`images{autoResize,blockImages}`/`enabledModels` 交给官方 `SettingsManager`（`create`+`applyOverrides`）并注入 `createAgentSession` 与 resource loader，从而真正驱动自动压缩阈值/LLM 重试退避/图像降采屏蔽/模型白名单。**默认不配则不建 SettingsManager、行为逐字不变**。`config.ts` 新增 `resolveSdkSettings`/`resolveExtensionPaths`，由 `PI_COMPACTION_*`/`PI_RETRY_*`/`PI_IMAGES_*`/`PI_ENABLED_MODELS`/`PI_EXTENSION_PATHS` 驱动，server 与 CLI 同源接入。
  - **导入外部会话（B）**：`SessionHub.importConversation()` 用官方 `SessionManager.forkFrom` 把外部 `.jsonl` 完整复制进本脚手架会话目录（生成全新 id）并登记索引，随后走既有 `openConversation` 接回——即官方 CLI/RPC `importFromJsonl` 的底层原语。新增 `POST /sessions/import`。复制出的目标文件同样过 `assertSessionFileAllowed`（fail-closed，与恢复同一道闸）。
  - **官方扩展路径装载（C）**：`buildAgent({ extensionPaths })` → 官方 `additionalExtensionPaths`，与 `extraExtensions` 内联工厂并列的第二条官方路（`noExtensions` 只关 `~/.pi` 扫描，不影响显式路径）。
  - **官方扩展钩子接缝（D/E）**：`src/extensions/provider-hooks.example.ts` 演示 `before_provider_headers`（原地注入头）/ `before_provider_request`（返回替换 payload）；`src/extensions/input-resources.example.ts` 演示 `input`（transform/handled）/ `resources_discover`（运行期动态贡献 skill/prompt 路径）。均默认不接线、类型对齐官方事件、附行为测试。
  - **工具细粒度（F）**：`ask_user_question` 设官方 `executionMode: "sequential"`（HITL 阻塞等人类，不与并发工具抢答）；`renderCall/renderResult` 属 TUI 专属、无头后端不适用（官方 RPC 模式亦降级），故不接。
  - **验证**：`config.test.ts` +4（resolveSdkSettings/resolveExtensionPaths）、`extensions/hooks.example.test.ts` +4（钩子行为）、`sessions/resume.test.ts` +2（导入正/反路径）；`npm run verify` 全链绿（328 测试 / smoke 21/21 / build / 嵌入自检）。
- **官方能力面补齐（对照第三轮）**：
  - **Settings 透传扩面**：`buildAgent({ sdkSettings })` 在上一轮基础上再加 `httpIdleTimeoutMs`（**出站 provider HTTP 空闲超时**，与入站 `hardening.ts` 服务器超时不同）/`websocketConnectTimeoutMs`/`steeringMode`/`followUpMode`/`thinkingBudgets{minimal,low,medium,high}`/`branchSummary{reserveTokens,skipPrompt}`；env 驱动 `PI_HTTP_IDLE_TIMEOUT_MS`/`PI_WS_CONNECT_TIMEOUT_MS`/`PI_STEERING_MODE`/`PI_FOLLOW_UP_MODE`/`PI_THINKING_BUDGET_*`/`PI_BRANCH_SUMMARY_*`；枚举值非法即丢弃。`transport` 因类型不宜校验，暂不接（默认即可）。
  - **`tool_result` 结果脱敏接缝**：`src/extensions/tool-result-redaction.example.ts` 接官方五步管道第 5 步 `tool_result`，在工具结果**回传给模型前**按正则替掉密钥/路径回显（补 `http/errors.ts` 只护 HTTP 响应、管不到发给模型的 tool 结果这一面）。默认不接线、可限定工具白名单、附行为测试。
  - **事件翻译补全**：`auto_retry_end`（官方重试结算事件）之前被 `onEvent` 的 `default` 吐掉，现译成 notice（"重试成功（第 N 次恢复）" / "重试失败：..."）。
  - **文档修正**：`docs/官方SDK接口文档.md` §7 Settings 字段名按 `dist/*.d.ts` 校正（初版凭印象写的 `compaction.threshold`/`retry.maxAttempts`/`images.maxDimension` 等与真源不符，`disabledTools` 实为脚手架自设项），补全真实字段与覆盖状态。
  - **验证**：`config.test.ts` +2（新增字段/枚举校验）、`hooks.example.test.ts` +2（tool_result 脱敏）；已跑 `npm run verify:all`（含真进程 e2e：握手→跑完一轮→SIGKILL→重启恢复→脏索引过滤→工具调用配对恢复）全链绿——**332 测试 / 0 失败 / smoke 21/21 / build / 嵌入自检**。

### Documentation

- **可视化资产与 README 同步**：`generate_architecture.mjs` 补上官方 RPC 入口、检索层、新 env（`PI_SCOPED_MODELS`/`PI_KNOWLEDGE_RETRIEVAL`/`PI_EMBEDDINGS_*`）；新增 `scripts/visualization/generate_retrieval.mjs` → `docs/knowledge-retrieval.svg`（可插拔 RAG 检索管线，后端类名从源码动态读取）；中英 README 架构图注与知识库节同步引用新图，章节结构一一对齐。徽章均为 shields.io 动态端点（版本自动跟随）；SVG 资产英文单版。

## [0.2.0] - 2026-10-09

### Added

- **RAG 可插拔性再补齐（本地 embedding + 持久化向量库 + 官方隔离示例）**：
  - **进程内 embedding（不依赖 Ollama）**：`TransformersEmbeddings`（`PI_EMBEDDINGS_PROVIDER=transformers`）——首次用自动从 HF Hub 下载 ONNX 权重到 `PI_EMBEDDINGS_CACHE_DIR`、进程内跑，含下载/加载/使用/释放。用动态 import + 非字面量模块名，**未装 `@huggingface/transformers` 也不影响 typecheck/默认零依赖**；用到没装才报清晰提示。
  - **sqlite 持久化向量库**：`SqliteVectorStore`（`PI_KNOWLEDGE_VECTOR_STORE=sqlite` + `PI_KNOWLEDGE_VECTOR_DB_PATH`），零新依赖（node:sqlite）；`VectorRetriever` 改用内容寻址 chunk id + `store.has()` 跳过未变条目——**重启不重算 embedding**。
  - **官方隔离姿势示例**：`src/extensions/sandbox.example.ts` 演示用 `pi.registerTool` 覆盖内置 `bash` 把执行路由出宿主（默认不接线）；`guard` 仍为默认软闸门。文档引用官方 `containerization.md`（Docker/Gondolin/OpenShell）。
  - **依赖与一键验证**：`@huggingface/transformers` 列入 `optionalDependencies`（默认会装、装失败不致命，代码仍动态 import）；`TransformersEmbeddings` 支持 `PI_EMBEDDINGS_HF_ENDPOINT`（直连不通时切 hf-mirror 等镜像）；新增 `npm run rag:smoke`——本地进程内 embedding + 向量检索一键实机验证，环境不满足（网络/镜像/原生依赖）时明确 SKIP 并退码 0，不假绿。
- **可插拔知识检索（RAG 入口，按官方姿势）**：官方 SDK 不带 RAG，只规定“你自己 `pi.registerTool` 一个可搜索工具”。把检索后端抽成 `Retriever` 接口：默认 `KeywordRetriever`（进程内关键词、零依赖、行为不变）；`PI_KNOWLEDGE_RETRIEVAL=vector` 启用 `VectorRetriever`（文档切段→embedding→`VectorStore` cosine，按文档聚合）。`EmbeddingProvider` 接口 + `OpenAICompatEmbeddings`（含 Ollama /v1）/`OllamaEmbeddings` 两后端；`VectorStore` 接口默认 `InMemoryVectorStore`，外部 Qdrant/pgvector 实现同接口即可插入。`search_knowledge` 工具与 REST `GET /knowledge/search` 共用同一检索器（单一真源）；`BuiltAgent` 新增 `searchKnowledge()`/`knowledgeRetrieval`。默认关，不影响现有行为。
- **官方 SDK 能力面补齐（对照 API 清单的真差距 + 可选接入）**，全部走官方 API，默认行为不回退：
  - **模型轮换**：`scopedModels`（官方）由 `PI_SCOPED_MODELS` / `buildAgent({ scopedModels })` 配置，缺省用所有已配 Key 模型派生；`session.cycleModel`/`cycleThinkingLevel` 经 CLI `/cycle`、REST `POST /model/cycle`、WS `cycle_model` 暴露。
  - **provider 鉴权状态**：官方 `ModelRuntime.getProviders()` + `checkAuth()` → `BuiltAgent.providerStatus()`；新增 `GET /providers`，`/info` 也带 `providers`（只回 id/name/authorized/来源标签，不回原始 key）。
  - **EventBus**：官方 `createEventBus()` 接入 `DefaultResourceLoader`，`BuiltAgent.eventBus` 暴露给嵌入方。
  - **会话标签**：官方 `SessionManager.appendLabelChange`/`getLabel` 经 WS `set_label` 与快照 `labels` 暴露（UI 书签，与回退的 custom 标记语义不同）。
  - **代码型命令通道**：`src/extensions/example-command.ts` 演示官方 `pi.registerCommand` + `pi.sendUserMessage`（与 `.md` prompt template 并列的官方第二条路；默认不接线）。`sendUserMessage` 是扩展能力、`AgentSession` 不暴露，故不硬造内核命令。
  - **AGENTS.md opt-in**：`buildAgent({ includeAgentsFiles })` 为 true 时取消 `noContextFiles`，让 SDK 以 `<project_context>` 追加项目上下文。默认 false。
  - **自定义 provider 一等参数**：`buildAgent({ providers })` 内部转成 inline 扩展逐顶 `pi.registerProvider`。
  - **官方 RPC 模式**：`src/rpc.ts` + `npm run dev -- --mode rpc`，经 `createAgentSessionRuntime` + `runRpcMode` 把 pi-starter 作为 stdio JSONL agent 后端驱动；与 `buildAgent` 共享同一装配核心（抽出的 `resourceLoaderOptions`），RPC 与 REST/WS 不在隔离/人设/工具上分叉。RPC 为单会话入口，不携 MCP 桥 / HTTP 审批闸门。
  - `.env.example` 新增 `PI_SCOPED_MODELS`；`lib.ts` 导出 `startRpcMode`/`resolveScopedModels`/`parseScopedModelRefs` 等。
  - **更多低成本官方项一等化**：`buildAgent({ commands })` 直接走官方 `pi.registerCommand`（代码型斜杠命令，handler ctx 带 `sendUserMessage`/`waitForIdle`）；`buildAgent({ excludeTools })` 接官方 `excludeTools` 黑名单；`BuiltAgent.waitForIdle()`/`getThinkingLevel()` 对应 `session.agent.waitForIdle`/`session.thinkingLevel`；`cycleModel(direction)` 支持官方反向。
- **对齐官方 Pi SDK：手写实现切回官方机制**（优先用官方/核心实现）。
  - **技能目录去重**：`buildSystemPrompt` 在 `systemPromptOverride` 路径下、只要工具集含 `read`，就会自动追加 SDK 原生 `<available_skills>`（`formatSkillsForPrompt`）；而 `agent.ts` 又用自定义 `formatSkillCatalog` 往 `{{skills}}` 层塞了第二份——系统提示词里实际有两份技能清单。现在删掉自定义目录，只依赖 SDK 那一份。`{{skills}}` 从默认拼接顺序移除，但仍是**已知** token（渲染为空），旧模板写它不会报错也不会漏字面量。
  - **提示词模板清单走官方 `loader.getPrompts()`**：不再自行解析 frontmatter（`loadPromptTemplates` 不在包主入口导出），改用 `DefaultResourceLoader.getPrompts()` 从一个只加载模板的最小装载器拿回 `PromptTemplate[]`。`/skills` 与 `/prompt-templates` 的清单都源自装载器，与系统提示词/斜杠展开不可能漂移。
- **`navigateTree` 带摘要（回退走官方树导航）**：`rollback_conversation` 新增可选 `summarize` / `instructions`；`summarize` 为真且 SDK 提供 `navigateTree` 时走官方（对被丢掉的后半段生成分支摘要，`customInstructions` 说"该保留什么"），否则回落到原先 `branch()` + custom 标记。缺方法时不崩。
- **`prompt()` 预检可见**：REST `/chat` 与 WS `prompt` 传 `preflightResult`，被预检拒（false）时回明确 `conflict`，不再静默空流。
- **`queue_update` 即时快照**：队列变化时立刻 `getState()`，客户端不必等下一个增量就着到 steering/followUp 队列。
- **JSON 事件流通道**：`POST /chat?format=jsonl`（官方 `json.md` 事件词表）把原始 SDK 事件逐行 NDJSON 输出，首行 `{"type":"session",...}`。默认关，不动现有 SSE 契约；继 loopback + 加固。
- **自定义 provider 示例**：`src/extensions/custom-provider.example.ts` 演示官方 `pi.registerProvider`（api-key 型）；默认不接线，经 `buildAgent({ extraExtensions })` 传入。交互式 OAuth 属 TUI，无头后端明确**不适用**。
- **提示词模板接入官方 SDK 能力**：`src/prompt-templates/` 模块此前已仿技能层写好（`resolvePromptTemplatePaths` / `loadScaffoldPromptTemplates` + 内置示例 `review.md`），但从未被 `buildAgent` 引用，属于"官方提供、脚手架必要、半成品未接线"的缺口。现在按 skills/knowledge 的模式接入：`buildAgent({ extraPromptTemplatePaths, builtinPromptTemplates })` 把模板交给 SDK `DefaultResourceLoader.additionalPromptTemplatePaths`，`session.prompt("/name")` 自动展开（`$1` / `$@` / `${1:-x}` / 切片）；新增 `GET /prompt-templates` 与 `/prompt-templates/:name`，`/info` 与 WS `capabilities` 一并列出模板目录；`BuiltAgent` 新增 `promptTemplates` 字段；`lib.ts` 导出供嵌入方使用；`dist-assets.cjs` 把 `prompt-templates/*.md` 拷进 `dist/`。配套 4 项单测 + HTTP 路由断言，已并入 `npm test`。（清单最初是自行解析 frontmatter，随后一条 Added 条目把它改成了官方 `loader.getPrompts()`。）
- **会话编辑**：`rename_conversation` / `rollback_conversation` / `edit_message` / `fork_conversation`。调用 SDK 的会话树，不另写存储。回退和编辑会追加一条不进模型上下文的 `pi-starter.tree` 标记，重启后叶子不会回到被丢掉的后半段。编辑把原文经 `edit_ready` 交回，不自动再发一轮。分叉用一次性打开的 `SessionManager`，不改正在对话的那个会话的 id。没打开的对话可以改名，不能回退或编辑。客户端只传会话 id 和记录 id。
- **进程执行**（仅 `PI_BUILTIN_TOOLS=coding`）：`exec` / `exec_jobs` / `exec_stop`。前台等到退出或超时，后台立刻返回 id，可列出、读已捕获输出、停止。超时和中止杀掉进程树。工作目录先做字面路径检查，再 `realpath`，解析失败即拒绝。Windows 用 cmd.exe，其它平台用 `/bin/sh`，不依赖 Git Bash。不是交互式 PTY（没有 vim / top，没有终端尺寸）。`off` / `readonly` 不挂这些工具；审批里原先只匹配 `bash` 的内置高危规则同时匹配 `exec`；计划模式拒绝 `exec` / `exec_stop`，放行只读的 `exec_jobs`。
- **真端到端测试**（`npm run e2e`，已并入 CI）：起**真实 server 进程** → 跑一次真实对话 → `SIGKILL` → 重启 → 验证会话从磁盘恢复 → 恢复后还能继续对话；**恢复后带工具调用**（假 LLM 发 `ls` 工具调用 → 真执行 → 重启恢复 → 断言出站请求里每个 `tool_call` 都有对应 tool 结果、且无孤立结果——这正是真实 provider 会校验的配对，断了会报「消息格式非法」而极难反推）；索引指向已删文件时不出现幽灵条目、陈旧 id 明确报错。不需要真实 API Key：把 `PI_CODING_AGENT_DIR` 指向临时目录并写一份指向本地假 OpenAI 兼容端点的 `models.json`，启动期不联网探测。此前 `resume.test.ts` 只在同进程里重读一遍索引，**从未真重启过**——而落盘时机、会话目录推导、索引与 jsonl 的对应关系，同进程测试全都测不到。
- **上下文主动压缩**：WS `compact_context { instructions? }` + `POST /context/compact`（REST 侧汇总所有连接，串行执行并报出每个结果）。此前只有 SDK 自动触发时的被动 notice，客户端看得见压缩发生了却无法主动发起，而「该保留什么」只有用户知道。三条前置条件都给出**明确中文理由**而非静默无效：正在流式 / 上下文太小（低于 `MIN_COMPACTABLE_TOKENS`，压了也省不下什么）/ SDK 不支持。压缩后**作废投影与 token 缓存**——若SDK 原地改写消息对象，WeakMap 键不变会命中压缩前的值，快照会继续显示被压掉的旧内容。
- **后端体系加固（两轮）**：工具看门狗、慢客户端断连、类型化错误 `AppError`、速率限制、结构化脱敏日志、指标端点、审批规则引擎（六种匹配器 + 编辑接口）、未使用符号门禁、CI 六道关卡。
- **扩展点体系**：WS 自定义命令（`attachWebSocket(server, { commands })`，未注册命令明确报错、内置不可被覆盖）、HTTP `configure` 钩子与 `seal()`、`addDisposer()` 统一回收。业务逻辑不碰内核即可接入。
- **文件服务**：`/files/*` 全套（浏览 / 读 / 写 / 新建 / 重命名 / 复制 / 删除 / Range 原始内容 / base64 上传）。路径穿越与**符号链接逃逸均 fail-closed**。
- **持久化**：会话、设置、审批规则三处落盘（原子写 + 损坏回落）。规则**改动即写盘**——唯一写盘时机是「我们自己改动时」，因此停机不再写盘，运行期间用户手改规则文件不会被停机覆盖。会话重启后可恢复，只恢复本工作区、不做跨客户端过户。
- **通用能力补齐**：MCP 桥（stdio 子进程 + 配置热生效）、计划模式（会话级只规划不实施）、子代理（不占主对话 LRU 额度）、多把 API 密钥（原始值永不出服务端）、`turn_start` / `turn_end` 轮次信号。
- **测试基础设施**：集成测试层用遵守 SDK 契约的 session 替身驱动真实编排栈（不依赖网络与 API Key，CI 可跑）；`listenTestServer()` 接住端口错误并重试、强制断开 keep-alive 连接；`waitFor(条件)` 取代固定 sleep，消除全量并发下的偶发失败。
- **嵌入路径**：[`docs/嵌入指南.md`](docs/嵌入指南.md) —— 已有 Express 服务的两条路线、鉴权挂法、可重复执行的自检清单。
- **关闭内置示例内容**：`buildAgent({ builtinKnowledge: false, builtinSkills: false })`（底层为 `loadScaffoldKnowledge` / `resolveSkillPaths` 的 `includeBuiltin`）。此前 `extraKnowledgeDirs` / `extraSkillPaths` 只叠加、内置同名优先，业务方**没有任何办法**把 `about.md` 与 `summarize` 技能从系统提示词里去掉。
- **嵌入自检**：`npm run verify:embed`（已并入 `npm run verify`），打 `dist/` 跑 8 项断言，覆盖内置示例内容的开关、`createApp` 返回值形状、内核路由可用性，以及鉴权中间件三种挂载位置的实测对比。

### Fixed

- **优雅停机的兜底定时器位置是错的（会导致进程永久挂死）**：`shutdown()` 把 `gate.dispose()` / `ws.close()` / `hub.dispose()` / `dispose()` 全部排在 `setTimeout(bail)` **之前**。任何一步抛错，`shutdown()` 就 reject，而信号处理器是 `void shutdown()` —— 变成未捕获拒绝，兜底定时器压根没建、`server.close()` 永不调用，**进程挂死只能等 SIGKILL**。也就是说这个「硬退出兜底」恰好保护不了最可能发生的失败。拆解逻辑抽到 `src/graceful.ts`：兜底**先建**、每步单独 try/catch（一步失败不影响其余）、关闭与兜底**竞速**（原来直接 `await closeServer()`，socket 拒绝关闭时本函数永不 resolve——这条坑实际踩到过，测试挂死并堆出孤儿进程）。新增 6 项单测，且做反向验证。
- **停机时打印的是请求端口而非实际绑定端口**：`--port 0`（让 OS 分配，E2E 与容器调度常用）会记出 `ws://127.0.0.1:0/ws`——调用方无法得知真实端口。改为读 `server.address().port`。这也顺带消除了 E2E 的端口竞态：旧做法是「探一个空闲端口→关掉→传给子进程」，探测与真正 listen 之间有窗口，CI 并行时表现为偶发 `EADDRINUSE`（本轮实际撞到）。
- **`POST /chat` 流式失败泄漏内部细节且不记日志**：状态码已提交，`errorHandler` 再也看不到这个异常，于是 `err.message` 原样写进 SSE——数据库绝对路径、SQL、SDK 内部信息全都会到客户端。实测反向验证时确实返回了 `unable to open C:\Users\real\private\db.sqlite 密码 hunter2`。改为复用 `toAppError`：`internal` 只回通用文案 + `code`，面向调用方的码（如 `read_only_sql`）照常放行以便模型自我纠正；同时**补上服务端 error 级日志**，此前失败在服务端完全不可见。此前该路径零测试覆盖。
- **E2E 里「不是兜底强退」的断言是假阳性**：它在停机 handler 根本没运行时也通过（因为没有超时日志只是因为压根没停机）。现在加了前提，且 Windows 上因 Node 不投递可捕获的 SIGTERM 而**显式报告 SKIP 与原因**，不再冒充通过。
- **E2E 里「停机后端口已释放」是单次瞬时判定**（竞态）：进程刚退出时 listener 可能还没被 OS 收走，多次通过后偶发变红。改为轮询判定——真泄漏时 10s 后依然会红，不是在掩盖问题。
- **E2E 用正则从日志里抓 `"knowledge":["about"]` 判断示例内容是否加载**：耦合的是日志排版，格式一改断言就假红。改为调用 `/capabilities`（文档化契约，且数据源正是写进系统提示词的那份清单）。
- **三个依赖漏洞清零**（`npm audit` 从high 降为 0）：`brace-expansion` 5.0.7 → 5.0.12、`undici` 8.5.0 → 8.11.2、`proxy-addr` 2.0.7 → 2.0.8。前两者位于 `@earendil-works/pi-coding-agent` 的**嵌套依赖**里，顶层 override 不生效——必须删除 lockfile 让 npm 从零解析才会应用（`npm install` 与 `--package-lock-only` 都会因「lockfile 已满足」而跳过重算）。
- **`package.json` 自依赖**（`"pi-starter": "file:pi-starter-0.1.0.tgz"`）会让 CI 的 `npm ci` 直接失败（该 tarball尚未构建）。已移除。
- **符号链接逃逸测试在 Windows 上从未真正运行**：两个用例在 `symlinkSync` 抛 `EPERM`（未开开发者模式）时直接 `return`，看着通过、实际没跑——比显式 skip 更糟。改用 **junction**（NTFS reparse point，普通用户即可创建，且 `realpath` 同样穿过它），两个用例现在在 Windows 上真跑，并加了「这个链接确实指向根外」的前提断言。
- **设置校验报错缺字段名**：`PATCH /settings` 传错类型只得到 `Expected boolean, got string`，同时改多个字段时无从定位是哪个。`patch()` 与启动读盘的 `normalize()` 现在都统一补上 `字段名: 原因`。
- 文档给出的鉴权建议**无效且危险**：README（中英双版）写的是「在 `createApp()` 外面加中间件」，实测中间件排在内核路由之后，`/chat`、`/model`、`/skills` 全部绕过鉴权直接返回 200——等于把 Agent 端点无鉴权暴露。正确写法是把内核 app 作为子应用挂到父应用上（`server.use("/agent", auth, agentApp)`），已同步 README、`SECURITY.md`、`FAQ.md` 与嵌入指南。
- 安全边界描述与实现相反：README / `SECURITY.md` / `FAQ.md` 称 HTTP 服务「默认监听所有网卡」，实际 `RUNTIME_DEFAULTS.host` 是 `127.0.0.1`（回环），仅当 `PI_HOST` 设为非回环地址时才对外监听，且启动会告警。

- 业务方经 HTTP 注入的路由此前落在错误处理器之后，抛出的 `AppError` 不会被翻译——实测会把密码、绝对路径与源码行号原样返回客户端。
- 审批规则的 `match.value` 未校验：缺 `value` 的 `glob` 在**匹配时**崩溃，缺 `value` 的 `regex` 会静默匹配字面量 `"undefined"`。
- 文件服务的符号链接校验在 `realpath` 失败时**放行**（fail-open），现改为拒绝。
- 配置文件能解析但含未知字段或非法值时，`SettingsService` 构造抛错导致**服务起不来**；现剔除该字段并告警（API 路径仍严格拒绝未知字段）。
- 会话索引无容量上限且每次写入重新读回文件；现上限 500、按 `updatedAt` 淘汰最旧。
- 模型切换后 `/info` 与 `/health/ready` 报告**已不再使用的模型**（WS 切模型路径绕过所致）；现每请求读 live getter。
- 轮次结束不发权威信号：补 `run_end`（含 `stopReason` / `willRetry` / `aborted`）与 `tool_delta`。
- 子代理在排队或建会话期间收到的 abort 会被漏掉，导致用户已停手而子代理继续消耗 token。
- MCP 子进程启动失败时 Node 只发 `error` 不发 `exit`，造成未捕获异常与永久挂起。

### Open-source metadata

- **Open-source metadata** in `package.json`: `author`, `license: MIT`, `homepage`, `repository`, `bugs`, `keywords`, `main`, `types`, `files`; removed `private: true` so the package can be published or consumed as a library.
- **Bilingual README layout**: `README.md` is now the English main version; `README.zh-CN.md` is added as the Chinese companion. Both start with a language-switch line and share the same section structure.
- **Badges + repo URL** at the top of both READMEs (release, license, Node engine, CI status, issues, last commit, PRs welcome).
- **Architecture section** in both READMEs, referencing the two generated SVGs:
  - `docs/architecture.svg` — layered stack diagram (entry / assembly / business resources / HTTP+SSE / runtime+config).
  - `docs/sse-protocol.svg` — `POST /chat` sequence diagram with the live SSE event vocabulary and tool-result preview limit.
- **Diagram generators** under `scripts/visualization/`, Node built-ins only, all counts and names parsed from source:
  - `generate_architecture.mjs` reads `package.json`, `src/tools/*.ts`, `src/skills/*/SKILL.md`, `src/knowledge/*.md`, `src/extensions/index.ts`, `src/app.ts`, `src/sse.ts`, and every `src/**/*.test.ts`.
  - `generate_request_flow.mjs` parses `src/sse.ts` (event names, `TOOL_RESULT_PREVIEW_LIMIT`) and `src/app.ts` (SSE frames emitted outside the translator).
  - `README.md` documents the run command and single-source-of-truth rules.
- **Tech stack table** in both READMEs, sourced directly from `package.json`.
- **Standard OSS files**: `CONTRIBUTING.md`, `SECURITY.md`, `FAQ.md`, `AUTHORS`, `.gitattributes` (LF-normalised text, binary whitelist, `linguist-generated` for `package-lock.json` and `dist/**`), `.github/workflows/ci.yml` (matrix: ubuntu / windows / macos × Node 22.19 / 22.x / 24.x, runs typecheck + test + build, uploads `dist/` artifact).

### Changed

- **LICENSE** copyright holder updated to `LPK3215` (matches `git config user.name`).
- **README** project structure tree extended to show `docs/`, `scripts/visualization/`, and `.github/workflows/`.
- **.gitignore** supplemented with local env variants, SQLite artifacts, TypeScript / test caches, IDE folders, and OS junk files.

### Fixed

- Replaced broken internal reference to a private local tutorial path in the previous `README.md` with a link to the upstream [pi repository](https://github.com/earendil-works/pi).

## [0.1.0] - 2026-10-08

Initial public scaffold release.

### Added

- **Assembly layer** (`src/agent.ts`): combines model, layered prompts, tools, and extensions into a runnable agent session.
- **Config layer** (`src/config.ts`, `src/cli-args.ts`): CLI flag > `.env` > default resolution for provider, model, model catalog (`PI_MODELS`), API keys, built-in-tool tier (`PI_BUILTIN_TOOLS`), and database path.
- **Dual entry points**:
  - CLI (`src/index.ts`, `npm run dev`) with `/models` and `/model <id>` slash commands.
  - HTTP + SSE server (`src/server.ts` + `src/app.ts` + `src/sse.ts`, `npm run web`) exposing `/health`, `/skills`, `/skills/:name`, `/knowledge`, `/knowledge/search`, `/knowledge/:name`, `/db`, `/db/notes`, `/db/query`, `/model`, `/chat`.
- **Layered prompts**: `src/prompts/persona.md` and `src/prompts/rules.md` compose the system prompt.
- **Tool layer** with pluggable registration (`src/tools/index.ts`): built-in example `current_time`, plus `search_knowledge` / `read_knowledge` and `db_status` / `db_query`.
- **Skills** (`src/skills/`): `<name>/SKILL.md` loaded through the SDK's `DefaultResourceLoader.additionalSkillPaths`; the sample `summarize` skill ships with the repo.
- **Knowledge base** (`src/knowledge/`): scan-and-search Markdown store (SDK has no native knowledge base); `about.md` example included.
- **Database** (`src/db/`): Node 22 `node:sqlite` with an in-memory default, sample `notes` rows seeded at startup, `GET /db` liveness, and read-only `db_query`.
- **Extensions** (`src/extensions/`): `guard` (pre-execution interception of dangerous bash and paths escaping cwd, `read SKILL.md` excepted) and `audit` (per-tool timing logs).
- **One-command Pi setup** (`npm run setup`): merge-writes `~/.pi/agent/models.json` and `auth.json` (mode `0o600`) from `.env`; `--force` opts into overwriting existing keys.
- **Model catalog & runtime switching**: `PI_MODELS` supports multiple providers; switch models via `--model`, CLI `/model`, or `POST /model` without rebuilding the session.
- **Built-in-tool tiers**: `off` (default, custom tools + `read` for skills), `readonly` (adds `grep` / `find` / `ls`), `coding` (adds `bash` / `edit` / `write`). Local `~/.pi/agent/skills` and `~/.pi/agent/extensions` are not scanned by default.
- **Library export** (`src/lib.ts`): `import { buildAgent, createApp } from "pi-starter"` with `extraTools`, `extraExtensions`, `extraSkillPaths`, `extraKnowledgeDirs`, `database`, `databasePath`, `inMemory`, `staticDir` options.
- **Contract smoke tests** (`*.test.ts` under `src/`): run offline; do not call models or write to the real `~/.pi/agent/`.
- **Sample chat page** (`public/index.html`): local-only reference UI for trying the HTTP/SSE endpoints.
- **Build pipeline** (`npm run build`, `scripts/dist-assets.cjs`): compiles TypeScript to `dist/` and copies prompt / skill / knowledge assets alongside the emitted JS.

[Unreleased]: https://github.com/LPK3215/pi-starter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/LPK3215/pi-starter/releases/tag/v0.1.0
