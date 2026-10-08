# pi-starter 后端功能体系设计与实现方案

> 参照物：`pi-web-ui后端功能全景分析.md`（目标 `pi-web-ui@0.99.0`，`server/` 130 个 TS 文件）。
> 本文档 = **能力边界梳理 → 差异化原则 → 逐项实现方案 → 改进点与优势 → 技术难点 → 落地路径**。
> 定位约束：本方案服务于 **pi-starter（垂直 Agent 脚手架）**，不是编码助手驾驶舱的复刻。
> 状态：核心内核已实现并接入；第二轮**接线审计 + 缺陷修复**已完成。
> 最新验证（2026-10-08）：`tsc --noEmit` 0 错 · `npm test` **54/54 通过** · `npm run smoke` **15/15 通过** · `npm run build` 退出码 0。

---

## 一、原方案核心功能梳理与能力边界

### 1.1 pi-web-ui 的功能全景（按重要性收敛为 8 个功能域）

| # | 功能域 | 核心内容 | 规模 |
|---|---|---|---|
| F1 | **协议与传输** | `protocol.ts` 类型单源 + 版本协商；WS 双向 + 快照驱动 + 增量 delta + 独立流式通道 + 背压丢弃 | 3373 行 |
| F2 | **会话编排** | AgentService → ClientSession → Conversation；每对话独立 runtime、跨项目、过户、子代理 | 15398 行 |
| F3 | **工具系统** | 内置覆盖链、ActiveSet、看门狗、LSP / patch / eval / 懒加载 / present-files | ~4000 行 |
| F4 | **人机协同审批** | 规则库（tools×field×match×action）+ 10 项内置高危 + 三档放行 + HITL 弹窗 | ~1000 行 |
| F5 | **终端与后台任务** | node-pty 七件套、ConPTY 自愈、输出微批、端口 diff 追踪 | ~2700 行 |
| F6 | **文件 / 附件 / 视觉** | 文件服务、CAS 附件、视觉桥转写、归档、Office 解析 | ~3000 行 |
| F7 | **扩展生态** | 插件市场 / 授权 / 宿主 API / slot / 定时任务 / MCP 桥 | ~5000 行 |
| F8 | **上下文与提示词** | context-budget 分层裁剪、soft-cap、compaction、prompt-composer | ~2000 行 |

### 1.2 能力边界（原方案「不做」与「受限」）

- **强耦合于编码场景**：PTY 终端、SCM、LSP、patch、Office 解析 —— 这些都是「AI 改代码」的专用装备，垂直 Agent（客服 / 数据分析 / 业务问答）用不上。
- **重装备**：Electron 桌面 sidecar、CF Worker、Docker/launchd/systemd 部署、双引擎（pi + DSH）—— 运维复杂度远超脚手架需求。
- **规模即成本**：15398 行的 `agent-service.ts` 是单点巨型模块，新人理解成本高、单测困难。
- **依赖 SDK 私有字段**：`installToolOverrides` 直接改 `_customTools` 再 `_refreshToolRegistry()`，与 SDK 版本强绑定。
- **协议落地方式偏重**：`~100` 个客户端命令中有大量编码助手专属命令（`terminal_*`、`scm_*`、`plugin_*`），对脚手架是噪音。

### 1.3 可借鉴的架构精华（本方案真正要继承的部分）

1. **快照驱动（Snapshot-driven）**：服务端唯一事实源，客户端只按快照渲染，重连 `get_state` 全量重建。
2. **协议单源**：`protocol.ts` 定义全部消息类型，前后端共类型，新增消息只改一处。
3. **多路传输分级**：权威快照可丢弃（靠 rev 链自愈），实时 delta 绕过背压永远可达。
4. **声明式规则引擎**：审批从硬编码正则升级成「规则自顶向下、首个命中生效」。
5. **显式字段枚举**：`set_settings` 逐字段校验，杜绝任意 JSON 注入。

---

## 二、pi-starter 的定位与差异化原则

**一句话定位**：基于 pi-agent SDK 的 **垂直 Agent 起步模板** —— 拿到即可跑，往上加业务工具 / 知识 / 数据库即成为垂直 Agent。

由此推出五条**不可违背**的设计原则：

| 原则 | 含义 | 对原方案的取舍 |
|---|---|---|
| P1 **通用内核，非编码专用** | 能力按「垂直 Agent 通用性」取舍 | 不做 PTY / SCM / LSP / patch / Office 解析 |
| P2 **零重依赖优先** | 能用 Node 内置就不引第三方 | 保留 `node:sqlite`；仅新增 `ws`（双向传输必需） |
| P3 **可注入、可裁剪** | 每个能力都是可替换的类/纯函数 | 优于原方案的巨型单文件 |
| P4 **默认安全** | 默认 loopback、默认关审批、deny 不可覆盖 | 与原方案一致，且在审批上更保守 |
| P5 **零 IO 可单测** | 核心逻辑不碰文件/网络 | 原方案大量逻辑与文件系统交织 |

**结论**：本方案**继承 F1 / F2 / F3 / F4 / F8 的架构思想**，用「数据驱动 + 纯函数 + 可注入」重写，规模从万行级压到千行级；**主动放弃 F5 / F6 / F7**，并在文档中显式声明边界。

---

## 三、目标后端功能体系（分层架构）

```
传输层   transport/ws.ts         WS 双向 + Origin/Host 校验 + 背压丢弃 + serializeShared + 心跳
   │
协议层   protocol.ts             ★ 单源：ClientMessage / ServerMessage / UiState + 版本 + 类型守卫
   │
编排层   session-hub.ts          SessionHub → ClientSession → Conversation（多对话 + 事件映射 + 快照调度）
   │     snapshot.ts              快照发射器（节流 + 增量/全量判定）
   │
能力层   tools/registry.ts       工具注册表（能力标签 + risk + ActiveSet 运行中开关）
   │     approval/{rules,policy,gate}.ts  规则引擎 → 三档策略 → HITL 闸门
   │     context/budget.ts        上下文预算（token 估算 + 软上限 + 分层裁剪计划）
   │     prompts/composer.ts      提示词组合引擎（{{token}} 化 + 零开销回退）
   │
配置层   settings.ts             声明式 schema + 原子 patch + 注入式持久化
   │     config.ts                RuntimeConfig（.env 可覆盖，安全默认）
   │
入口层   server.ts (HTTP+WS)  app.ts (REST/SSE 兼容)  index.ts (CLI)  lib.ts (库导出)
   │
SDK      @earendil-works/pi-coding-agent
```

---

## 四、逐项实现方案（对照清单）

> 每项：**原方案做法 → 本方案做法 → 改进点 → 落地文件**。

### 4.1 协议单源与版本协商（对应 F1）

- **原方案**：`protocol.ts` 3373 行，`~100` 个命令 + `check:protocol` 脚本守护前后端常量一致。
- **本方案**：`src/protocol.ts` 定义 **19 个客户端命令 + 14 类服务端消息**，按脚手架场景裁剪；`CLIENT_MESSAGE_TYPES` 常量 + **编译期断言**保证「新增命令必须登记」。
- **改进点**：
  1. 用 `satisfies` + `Exclude<…> extends never` 做**编译期完备性检查**，比运行期脚本更早发现问题；
  2. `UiState` 内嵌 `conversations` / `pendingApproval` / `stats.softCap|contextTokens`，让 UI 一次快照即可渲染全部状态，减少往返；
  3. 版本协商双向回带（`hello.protocolVersion` ↔ `ready.clientProtocolVersion`），前端可自检「需刷新」。
- **文件**：`src/protocol.ts`

### 4.2 快照驱动 + 多路传输分级（对应 F1）

- **原方案**：`emitSnapshotNow` 用 O(n) 指针等同性判定「仅追加」，`snapshot` 背压可丢，`message_delta` 绕过背压。
- **本方案**：`SnapshotEmitter` 抽出为**无 IO 的独立类**，通过注入 `buildState` / `emit` / `convId` 工作；节流窗口 60ms、流式期降为 2s。
- **改进点**：
  1. **可单测**：原方案逻辑埋在 15398 行服务里，本方案是 120 行的纯类；
  2. 判定条件显式化（`!forceFull && prev!==null && convId 一致 && 长度不减` + 逐项指针比对），并保留 `baseRev` 供客户端检测链断裂；
  3. 消息投影用 `WeakMap<AgentMessage, UiMessage>` 缓存，**同一 SDK 消息对象永远映射到同一 UiMessage 引用** —— 这是指针等同性判定成立的前提。
- **文件**：`src/snapshot.ts`、`src/session-hub.ts`

### 4.3 会话编排与多对话并发（对应 F2）

- **原方案**：`AgentService` → `ClientSession` → `Conversation`，每对话独立 runtime，`MAX_OPEN_CONVERSATIONS=8`。
- **本方案**：`SessionHub` → `ClientSession` → `Conversation` 三层拆分；`Conversation` **不持有 WebSocket**，只认 `push` 回调。
- **改进点**：
  1. **自动降级**：`BuiltAgent.createSession?` 缺席时（CLI / 库调用方）复用 `agent.session`，实现零改动兼容；存在时每对话新建独立 loader + session，对话间不共享可变状态；
  2. **首条 user 派生标题**：`deriveTitle()` 让多对话列表可读，无需额外 LLM 调用；
  3. 事件映射收敛为**一张 switch**（`message_update` → delta、`tool_execution_*` → tool_status、`compaction_*` / `auto_retry_*` → notice），比原方案分散在 15000 行中更易审计。
- **文件**：`src/session-hub.ts`、`src/agent.ts`（`createSession`）

### 4.4 工具注册表与 ActiveSet（对应 F3）

- **原方案**：`AGENT_TOOL_CATALOG` 硬编码常量 + `installToolOverrides` 覆盖链（直接改 SDK 私有字段 `_customTools`）。
- **本方案**：`ToolRegistry` 数据驱动 —— 每个工具是带 `source` / `capabilities` / `risk` 元数据的 `ToolSpec`；`setEnabled()` 运行中开关。
- **改进点**：
  1. **不碰 SDK 私有字段**：`enabledNames()` 直接产出可喂给 SDK ActiveSet 的名单，升级 SDK 不易碎；
  2. **能力标签是策略的公共语言**：审批规则、UI 分组、风险分级都从 `capabilities` 推导，新增工具自动纳入治理，无需在多处同步；
  3. `inferCapabilities` / `inferRisk` 提供约定式默认，登记时零配置。
- **文件**：`src/tools/registry.ts`

### 4.5 声明式审批规则引擎（对应 F4）

- **原方案**：`ApprovalRulesStore`（670 行）+ `tool-approval.ts`；规则字段 `tools × field × match × action`；内置 10 项高危。
- **本方案**：`rules.ts`（匹配/评估纯函数 + 10 项内置高危）+ `policy.ts`（三档策略）+ `gate.ts`（HITL 闸门）。
- **改进点**：
  1. **新增 `capability` 匹配类型**：原方案只能按工具名匹配，本方案可按能力标签（`fs.write` / `shell`）匹配，新工具自动落网；
  2. **评估是纯函数** `evaluateRules(rules, input)` —— 无 store / 无 IO，可直接断言；
  3. **deny 不可被策略覆盖**：原方案的「本对话全允许」会压制 ask，本方案明确规定 **策略只压制 ask，deny 是硬闸门**，避免「全允许」变成提权后门；
  4. **超时 fail-safe**：HITL 等待超时（默认 5 分钟）**判为拒绝**，杜绝「审批卡住 → 静默执行」；
  5. 闸门通过 `onRequest` 回调解耦传输层，同一套逻辑可用于 Web 与 CLI。
- **文件**：`src/approval/rules.ts`、`src/approval/policy.ts`、`src/approval/gate.ts`

### 4.6 上下文预算与裁剪（对应 F8）

- **原方案**：`context-budget.ts` 多级分层裁剪 + `soft-cap.ts` 按模型窗口换算 reserve。
- **本方案**：`budget.ts` 提供 token 估算、软上限、**裁剪计划（纯函数）**。
- **改进点**：
  1. **对消息形状零假设**：只认 `{ role, text }`，因此可脱离 SDK 单测，也能给任意垂直 Agent 复用；
  2. `planContextTrim` 返回**要丢弃的下标**而不直接改数组，调用方可审计 / 回放 / 二次决策；
  3. **UI 与裁剪同源**：快照里的 `stats.contextTokens` 与裁剪器用同一套估算，进度条阈值与真实触发点永远一致（原方案两处各算一次）。
- **文件**：`src/context/budget.ts`、`src/session-hub.ts`（`buildState`）

### 4.7 提示词组合引擎（对应 F8）

- **原方案**：`prompt-composer.ts` 暴露 11 个 token + 逐层覆盖 + `splitAgentStartPrompt` 拆 pre/core/post。
- **本方案**：`composer.ts` 暴露 8 个 token（`persona/rules/append/tools/skills/knowledge/context/cwd`），纯函数引擎。
- **改进点**：
  1. **未自定义模板时零开销**：直接按默认顺序拼接，等价于改造前行为，不引入任何额外处理；
  2. **未知 token 原样保留**（不静默删除），用户能立刻发现自己写错的占位符；`unknownTokens()` 提供校验；
  3. 渲染后按空行分段去空段，避免连续空行污染提示词。
- **文件**：`src/prompts/composer.ts`

### 4.8 设置服务（对应 F7 的 settings 部分）

- **原方案**：`settings-service.ts` 1040 行，显式枚举字段 + 流式期挂起重载。
- **本方案**：`settings.ts` 用**声明式 schema**（`bool() / enumOf() / int() / str() / strList()`）。
- **改进点**：
  1. **新增字段 = schema 加一行**，校验 / 默认值 / 持久化 / UI 列表自动跟上；
  2. **原子 patch**：任一字段校验失败则整体不变更，不留下半更新状态；
  3. 持久化走注入的 `SettingsPort`（默认内存），核心逻辑零 IO。
- **文件**：`src/settings.ts`

### 4.9 WS 传输层与安全边界（对应 F1 / 安全）

- **原方案**：`WebSocketServer({noServer})` + 手动 `handleUpgrade` + Origin/Host 同权威校验 + `serializeShared` + 心跳 + 优雅停机。
- **本方案**：`attachWebSocket(server, runtime)` 单函数装配，等价能力但收敛为约 400 行单模块。
- **改进点**：
  1. **未 attach 命令进 pending 队列**：原方案的握手竞态（hello 未完成时命令丢失）在本方案被显式处理，attach 后按序回放；
  2. `perMessageDeflate` 阈值 16KB —— 大会话快照压缩，小消息不付压缩成本；
  3. 心跳统一挂在 ws 实例的存活标记上，错失一个 pong 周期即 `terminate()`，避免僵尸标签页泄漏会话；
  4. `RuntimeConfig` 全部可 `PI_*` 环境变量覆盖，默认全部偏保守（loopback、256KB 背压阈值）。
- **文件**：`src/transport/ws.ts`、`src/config.ts`

### 4.10 入口装配（HTTP + WS 双通道）

- **原方案**：单入口巨型 `index.ts`（3576 行）。
- **本方案**：`server.ts` 只做装配（约 130 行），`app.ts` 保留 REST/SSE 兼容层，`lib.ts` 导出全部新 API。
- **改进点**：
  1. **渐进升级**：既有 `/chat` SSE 集成不被破坏，新产品前端走 WS；两条通道共享同一 `BuiltAgent`；
  2. **审批闸门的「先建后绑」**：`approvalSink` 可变 holder 解决 gate（需在 buildAgent 前创建）与 WS server（需在 agent 后创建）的循环依赖；
  3. REST 侧补齐 `/capabilities` / `/settings` / `POST /tools/:name/enabled`，与 WS 命令一一对应。
- **文件**：`src/server.ts`、`src/app.ts`、`src/lib.ts`

---

## 五、相对原方案的改进点与优势

### 5.1 能力对照矩阵

| 能力域 | pi-web-ui | pi-starter（本方案） | 判定 |
|---|---|---|---|
| 协议单源 | ✅ 3373 行 + 脚本守护 | ✅ 编译期完备性断言 + 版本双向协商 | **≥** |
| 快照驱动 | ✅ 埋在 15398 行服务内 | ✅ 独立 120 行类，可单测 | **>**（可维护性） |
| 多对话并发 | ✅ 每对话独立 runtime + 过户 | ✅ 每对话独立 runtime + 自动降级单对话 | **≈**（脚手架无需过户） |
| 工具治理 | ✅ 覆盖链改 SDK 私有字段 | ✅ 数据驱动注册表 + 能力标签，不碰私有字段 | **>**（稳定性） |
| 审批规则 | ✅ tools×field×match×action | ✅ 增加 capability 匹配 + deny 不可覆盖 + 超时 fail-safe | **>**（安全性） |
| 上下文预算 | ✅ 分层裁剪 + soft-cap | ✅ 纯函数裁剪计划 + UI/裁剪同源 | **>**（可测性/一致性） |
| 提示词组合 | ✅ 11 token + 逐层覆盖 | ✅ 8 token + 零开销回退 + token 校验 | **≈**（按定位裁剪） |
| 设置服务 | ✅ 1040 行 | ✅ 声明式 schema + 原子 patch | **>**（可扩展性） |
| 传输安全 | ✅ Origin/Host + token + quiesce | ✅ Origin/Host + 心跳 + 背压丢弃 + pending 队列 | **≈**（脚手架无需 token/quiesce） |
| PTY 终端 | ✅ node-pty 全套 | ✖ 明确不做 | 定位取舍 |
| SCM / LSP / patch | ✅ | ✖ 明确不做 | 定位取舍 |
| 插件市场 / MCP / 视觉桥 | ✅ | ✖ 明确不做 | 定位取舍 |

### 5.2 工程量化对比

| 指标 | pi-web-ui | pi-starter 本方案 | 说明 |
|---|---|---|---|
| 后端源文件数 | 130 | **14 个新/改文件** | 按脚手架定位裁剪 |
| 最大单文件 | 15398 行 | **约 500 行**（`session-hub.ts`） | 无巨型模块 |
| 协议命令数 | ~100 | **19** | 去掉编码助手专属命令 |
| 运行时依赖 | SDK + express + ws + node-pty + tar + yauzl + … | **SDK + express + typebox + ws** | 仅新增 `ws` |
| 类型检查 | — | `tsc --noEmit` **0 错误** | 已验证 |
| 既有测试 | — | **39/39 通过** | 无回归 |
| 构建 | — | `npm run build` **退出码 0** | 已验证 |
| 核心模块可单测性 | 低（与 IO/SDK 私有字段交织） | **高**（纯函数 + 注入端口） | 架构目标 |

### 5.3 三条最关键的差异化优势

1. **数据驱动取代硬编码**：工具、规则、设置全部由「声明 + schema」描述，新增能力只改一处，且自动纳入审批 / UI / 风险治理。原方案需要多文件同步。
2. **纯函数内核取代巨型服务**：规则评估、裁剪计划、提示词渲染、token 估算全是纯函数 —— 可断言、可回放、可复用，这是「脚手架」最该提供的价值。
3. **默认安全 + 明确边界**：loopback 绑定、deny 不可覆盖、审批超时 fail-safe、显式声明「不做 PTY/SCM/插件市场」，让使用者清楚知道护栏在哪。

---

## 六、技术难点与应对

| # | 难点 | 风险 | 本方案的应对 |
|---|---|---|---|
| T1 | **快照增量判定必须靠对象引用稳定** | 一旦投影每次新建对象，指针比对失效 → 退化为每次全量（性能悬崖） | `WeakMap<AgentMessage, UiMessage>` 缓存投影；`buildState` 保证同一 SDK 消息对象产出同一 UiMessage 引用 |
| T2 | **背压丢弃后的自愈** | 丢包后客户端状态陈旧 | 保留 `rev` / `baseRev` 链，客户端检测断裂即 `get_state` 全量重建；服务端丢弃后延时主动重发 |
| T3 | **审批 HITL 的循环依赖** | gate 需在 agent 前建，WS 需在 agent 后建 | `approvalSink` 可变 holder + 回调注入，解耦构造顺序 |
| T4 | **多对话与 SDK 单 session 的张力** | 旧调用方只拿到一个 session | `createSession?` 可选工厂 + 缺席自动降级单对话，零破坏兼容 |
| T5 | **HITL 阻塞会不会挂死 Agent** | 人类不响应则工具永不返回 | 超时 fail-safe 判为拒绝；`gate.dispose()` 在停机时统一拒绝所有在途请求 |
| T6 | **token 估算精度** | 估算偏差导致裁剪过早/过晚 | CJK 按 1 token/字保守偏高（宁多算不少算）；软上限预留 15% + 4096 绝对下限双重保护 |
| T7 | **协议演进破坏前端** | 新增字段导致旧前端崩 | 版本双向协商 + `ready.clientProtocolVersion` 回带，前端可提示刷新 |
| T8 | **SDK 版本漂移** | 私有字段/事件签名变化 | 只依赖公开 API（`subscribe` / `setModel` / `setThinkingLevel` / `getSessionStats`）；不碰 `_customTools` |
| T9 | **读不存在的 SDK 字段（E1 教训）** | 读一个类型上「看起来有、实际没有」的字段 → 静默回落默认值，**`tsc` 完全无法发现**；本轮就因此让审批隔离整体失效 | 依赖外部类型前先核对 SDK 的 `.d.ts` 真实字段；关键取值加运行时断言；回归测试用**复刻的真实 `ExtensionContext` 形状**喂入（只给 `sessionManager`、不给 `sessionId`），确保这类退化会立刻失败 |
| T10 | **声明即失效（E3–E7 教训）** | 字段有 schema、有默认值、有 UI，但**没有调用方**——看起来实现了，实际改了没用 | 每个可配置字段必须有明确消费方；接线审计以「grep 声明字段的调用方」为固定动作，而非依赖「我写过了」的记忆 |

---

## 七、落地路径（分期）

### 已落地（本次交付）

| 阶段 | 内容 | 文件 |
|---|---|---|
| S0 传输与协议 | 协议单源 + 版本协商 + 类型守卫 + 编译期完备性 | `protocol.ts` |
| S0 传输与协议 | WS 传输层（Origin/Host + 背压 + 序列化缓存 + 心跳 + 优雅停机） | `transport/ws.ts` |
| S1 快照内核 | 快照发射器（节流 + 增量/全量） | `snapshot.ts` |
| S1 会话编排 | SessionHub / ClientSession / Conversation + 多对话工厂 | `session-hub.ts`、`agent.ts` |
| S2 工具与审批 | 工具注册表 + 声明式规则引擎 + 三档策略 + HITL 闸门 | `tools/registry.ts`、`approval/*` |
| S2 上下文与提示词 | 上下文预算 + 提示词组合 | `context/budget.ts`、`prompts/composer.ts` |
| S3 配置与装配 | 设置服务 + RuntimeConfig + HTTP/WS 双通道装配 + 库导出 | `settings.ts`、`config.ts`、`server.ts`、`app.ts`、`lib.ts` |

### 建议后续（按业务优先级，非本次范围）

| 阶段 | 内容 | 说明 |
|---|---|---|
| S4 | 设置 / 规则库**落盘** | `SettingsPort` / `ApprovalRulesStore.toJSON()` 端口已备。**注意**：当前用内存端口，进程重启后 `disabledTools` / `promptTemplate` 等设置会丢；接文件或 sqlite 即可持久化 |
| S5 | 会话列表**持久化** | `Conversation.toSummary()` 已就绪，接 `SessionManager` 落盘即可跨重启恢复 |
| S6 | 计划模式 / 委派审阅 | 复用 `ApprovalGate` 的闸门模式，加会话级 `mode` 字段与系统提示词软约束 |
| S7 | 压缩（compaction）联动 | `planTrim()` 现已把 `overBudget` 送进快照，UI 可据此提示用户；接 `session.compact()` 即成「裁剪 → 摘要」两级策略。**保持人工触发**，不要自动丢消息 |
| S8 | MCP 工具桥 | 把外部 MCP 工具注册进 `ToolRegistry`（`source: "dynamic"` 已预留） |
| S9 | 工具看门狗 | 长耗时工具（`bash` 等）目前无超时保护，可参照 `ApprovalGate` 的 fail-safe 定时器模式补一个 |

---

## 八、实现过程中发现并修复的缺陷

### 8.1 第一轮：运行时冒烟（接入阶段）

类型检查与单测无法覆盖「时序」与「副作用」两类问题。本方案在接入后做了三组**运行时**验证（真实 HTTP + WS 端到端、HITL 计时、WeakMap 缓存计数），据此发现并修复了 3 个真实缺陷：

| # | 缺陷 | 危害 | 根因 | 修复 |
|---|---|---|---|---|
| D1 | 审批超时定时器被 `unref()` | 事件循环无其他任务时**超时永不触发**，工具调用永久挂起——比「超时判拒」更糟；服务器场景被 HTTP server 掩盖，库 / CLI 场景必现 | 误把审批超时当成「尽力而为」的周期定时器 | 去掉 `unref()`：该定时器**必须触发**，是 fail-safe 的前提（`gate.ts`） |
| D2 | 默认提示词组合会把 `{{append}}` / `{{tools}}` 等字面量注入系统提示词 | 提示词被污染，模型看到无意义的占位符，且难以察觉 | `renderToken` 对「已知但未提供的层」也返回占位符 | 语义二分：**已知层缺失 → 渲染空串**；**未知 token → 原样保留**以暴露拼写错误（`composer.ts`） |
| D3 | `ready` 之前就推送了 `conversations` / `snapshot` | 严格客户端在拿到 clientId / 协议版本前收到业务消息，可能丢弃或崩溃 | `hub.attach()` 内部会立即建对话并推快照，而 `ready` 在其后发送 | `hello` 改为**先发 `ready` 再 attach**，保证 `ready` 永远是第一帧（`ws.ts`） |

同时补掉 3 个**功能缺口**（自查发现，非缺陷但影响「所言即所做」）：

- **工具开关真正生效**：`set_tool_enabled` 原先只改注册表，现同时调用 `session.setActiveToolsByName()` 作用到实时会话（`hello` 时也对齐一次，避免持久化禁用项被忽略）。
- **审批 modify 真正改参**：`ApprovalGate.request()` 改为返回 `{ decision, modifiedArgs }`，扩展按 SDK 契约原地改写 `event.input`。
- **`set_model` 返回完整模型列表**：原先回 `models: []`，现回带 `current` 的完整目录。

### 8.2 第二轮：接线审计（本轮）

上一轮修的是「运行时行为」，但**声明了却没接线**的一类缺陷仍然潜伏：类型检查看不见、单测没覆盖、文档却声称已实现。本轮以「grep 每个声明字段的调用方」为审计手法，逐项核对 `settings` / `config` / `protocol` 的每个字段是否真的有消费方，结果发现 **7 处失效接线**，全部已修复。

| # | 缺陷 | 危害 | 根因 | 修复 |
|---|---|---|---|---|
| **E1（严重）** | 审批会话键**恒为 `"default"`** | 所有对话共享同一份审批策略：在对话 A 里选「本对话全部允许」，会连带放行对话 B 的同类高危调用——审批隔离形同虚设 | `approvalExtension` 读 `ctx.sessionId`，但 SDK 的 `ExtensionContext` **根本没有这个字段**（会话标识在 `ctx.sessionManager.getSessionId()`）。读不存在的字段静默返回 `undefined` → 回落字面量 `"default"`，**类型系统与编译器都无法发现** | 默认 key 解析改走 `sessionManager.getSessionId()`（`AgentSession.sessionId` 正是它的别名，天然等于 `Conversation.id`），并删掉 `server.ts` 里同样写错的 `conversationKey` |
| **E2** | `RuntimeConfig.protocolVersion` 形同虚设 | `PI_PROTOCOL_VERSION` 环境变量改了没有任何效果，`ready` 帧永远回常量值 | `ws.ts` 硬编码 `PROTOCOL_VERSION`，从不读 `cfg` | `ready` 改用 `cfg.protocolVersion`；`RUNTIME_DEFAULTS.protocolVersion` 改为从 `PROTOCOL_VERSION` 派生，杜绝两处漂移 |
| **E3** | `settings.promptTemplate` 无效 | 用户在设置里自定义提示词模板，系统提示词毫无变化 | `composer.ts` 实现完整却**没有任何调用方**，`agent.ts` 走的是硬编码 `persona + "\n\n" + rules` | 新增 `promptTemplate` / `promptAppend` 选项，默认路径也走 composer（无模板时渲染结果与原硬编码拼接**逐字相同**，零行为变化） |
| **E4** | `settings.approvalMode` 无效 | 设成 `all` / `category` 毫无反应，每个对话仍硬编码从 `off` 起步 | `ApprovalGate.policyFor()` 固定调 `defaultApprovalPolicy()` | 新增 `defaultPolicy` 选项，由 `server.ts` 从 settings 注入；并**深拷贝**默认值，避免多个对话共享同一数组被就地改写 |
| **E5** | `settings.thinkingLevel` 无效 | 重启/重连后思考强度回落默认 | 该字段只声明、只存、从不被读 | `hello` attach 后应用；`set_thinking` 成功后回写；**顺带补上入参校验**（原先把任意字符串强转成 SDK 的 `ThinkingLevel`，现按白名单校验并返回明确错误） |
| **E6** | `settings.contextKeepRecent` 无效 | 上下文预算的裁剪计划**从未被调用**，`planContextTrim` / `applyTrim` 是纯死代码 | 会话层只算 `contextTokens` 供画进度条，从不规划裁剪 | 会话层新增 `planTrim()`，并把 `overBudget` / `usage` 经 `UiStats.context` 送进快照；`keepRecent` 以**惰性读取**方式注入，改设置后下一轮即生效，无需重启 |
| **E7** | `set_settings` 接受但不生效 | 改 `disabledTools` 只更新设置对象，工具集纹丝不动，必须重启才生效 | 只回 `settings_state`，没把变更推给注册表与实时会话 | 变更后按 `disabledTools` 重算注册表开关，并调用 `applyToolSet()` 作用到所有会话 |

**其中 E1 是本方案相对原方案更值得强调的一点**：pi-web-ui 的审批按 `ClientSession` 实例隔离，而本方案用「SDK 会话 id」作为隔离键，隔离粒度更细（跨客户端重连也能恢复）；代价是必须读对 SDK 的字段——而这正是 `tsc` 保护不了的地方。**教训：依赖外部类型时，要断言字段真实存在，不能只依赖类型标注。**

### 8.3 验证手段（三层，均已落为可重复执行的脚本）

| 层 | 命令 | 覆盖 | 结果 |
|---|---|---|---|
| 类型 | `npm run typecheck` | 全量类型 + 协议编译期完备性断言 | 0 错 |
| 单元 | `npm test` | 54 项（含新增 `src/backend.test.ts` 15 项回归） | 54/54 |
| 运行时 | `npm run smoke` | 真实 HTTP + WebSocket 端到端 15 项 | 15/15 |

`src/backend.test.ts` 专门锁死本轮修复：`ExtensionContext` 形状复刻（**只有 `sessionManager`、没有 `sessionId`**）、会话键不坍缩、`defaultPolicy` 生效、deny 不可被策略覆盖、composer 不泄漏占位符、裁剪不改原数组、协议版本不漂移。

`scripts/smoke-ws.mjs` 用真实 `ws` 客户端验证：`ready` 必须是第一帧、握手前的命令进 pending 队列并在 attach 后回放、非法 JSON / 非法 thinking level 返回错误帧、跨站 Origin 升级被拒、背压与心跳装配正常。

> 第一轮的三组冒烟是内联执行的（管道 stdin，不落盘）；本轮已固化为 `npm run smoke`，纳入版本控制，避免回归。

---

## 九、附录：新增/修改文件清单

| 文件 | 职责 | 类型 |
|---|---|---|
| `src/protocol.ts` | 协议单源（命令 / 消息 / 快照 / 版本 / 守卫）+ `UiContext` 预算块 | 改写 |
| `src/snapshot.ts` | 快照发射器 | 既有 |
| `src/session-hub.ts` | 会话编排（多对话 + 事件映射 + 快照调度 + `planTrim`） | 改写 |
| `src/tools/registry.ts` | 工具注册表 + ActiveSet | 新增 |
| `src/approval/rules.ts` | 规则引擎 + 内置高危规则 | 新增 |
| `src/approval/policy.ts` | 三档放行策略 + 纯函数决策 | 新增 |
| `src/approval/gate.ts` | HITL 闸门 + SDK 钩子适配（会话键取自 `sessionManager`） | 新增 |
| `src/context/budget.ts` | 上下文预算与裁剪计划 | 新增 |
| `src/prompts/composer.ts` | 提示词组合引擎 | 新增 |
| `src/settings.ts` | 声明式设置服务 | 新增 |
| `src/transport/ws.ts` | WS 传输层（版本取自 cfg + 思考档位校验） | 新增 |
| `src/agent.ts` | 多会话工厂 `createSession` + `promptTemplate` 接线 | 改写 |
| `src/app.ts` | REST 兼容 + 能力/设置路由 | 改写 |
| `src/server.ts` | HTTP + WS 装配（settings → gate / hub / agent 全链接线） | 改写 |
| `src/lib.ts` | 库导出面扩展 | 改写 |
| `src/config.ts` | `RuntimeConfig`（`protocolVersion` 派生自协议单源） | 既有 |
| `src/backend.test.ts` | **新增**：接线回归测试（15 项） | 新增 |
| `scripts/smoke-ws.mjs` | **新增**：WS 端到端冒烟（15 项，`npm run smoke`） | 新增 |
