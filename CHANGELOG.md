# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
