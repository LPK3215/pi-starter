# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
