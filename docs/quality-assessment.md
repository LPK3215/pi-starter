# pi-starter 工程质量评估与改造方案

> 评估日期：2026-10-08 · 评估对象：`pi-starter` 后端核心（`src/`，54 个 TS 文件 / 10097 行）
> 范围：**通用 Agent 智能体后端内核**。明确排除 UI/前端、多用户体系、支付。
> 验证基线：`npm run verify` 全绿 · `tsc --noEmit` 0 错 · `npm test` **121/121** · `npm run smoke` **17/17** · `npm run build` 通过 · 零未使用符号。

---

## 〇、总体结论

**架构方向是对的，但「工程完备度」明显落后于「架构设计」。**

这个项目有一个罕见的特征：**架构文档写得比代码更完整**。协议单源、快照驱动、数据驱动注册表、声明式规则引擎、纯函数内核——设计层面的判断都正确，且已经落地。但把这些设计放到一个**长期运行、对外开放**的场景下审视，暴露出三类系统性缺陷：

| 类别 | 表现 | 根因 |
|---|---|---|
| **声明 ≠ 生效** | 上一轮已修 7 处（E1–E7），本轮又发现 6 处同类 | 缺少「每个可配置项必须有消费方」的强制审计 |
| **默认面向开发** | body 无上限、无安全头、无超时、日志裸输出 | 所有默认值按「本地脚本跑一下」设定，没有按「服务化」设定 |
| **静默失效** | 无界增长无告警、错误被吞、健康检查查不出真实状态 | 缺少可观测性与容量边界 |

**风险最高的一条**：`db_query` 工具接收 **LLM 生成的原始 SQL**，而只读校验器可被 `WITH ... AS (DELETE …)` 绕过（实测当前 SQLite 兜住了，但这是依赖驱动而非自身防御）。叠加提示词注入，这是通向数据破坏的路径。

**本轮已完成**：安全头 / body 限制 / 超时 / 结构化脱敏日志 / 指标体系 / 只读 SQL 重写 / 三类无界增长护栏 / 深度健康探针。

---

## 一、架构与模块划分

### 现状（良好）

分层清晰，依赖方向单一（传输 → 编排 → 能力 → SDK），无循环依赖：

```
transport/ws.ts  →  session-hub.ts  →  snapshot.ts / context / approval
      ↓                   ↓
   protocol.ts（单源）   agent.ts  →  SDK
```

- **`protocol.ts` 协议单源** + `CLIENT_MESSAGE_TYPES` 编译期完备性断言——这是本项目最扎实的设计，新增命令漏登记会直接编译失败。
- **快照驱动**：服务端唯一事实源，`WeakMap` 投影缓存保证对象引用稳定，使「仅追加」判定能走指针等同性而非全量比对。
- **会话编排三层拆分**（`SessionHub → ClientSession → Conversation`），`Conversation` 不持有 WebSocket，只认 `push` 回调——比 pi-web-ui 的 15398 行单体强。
- **可注入降级**：`createSession?` 缺席时自动退化为单对话，CLI/库调用方零改动。

### 差距

| # | 问题 | 风险与影响 |
|---|---|---|
| A1 | **`app.ts` 职责过载**（441 行）：同时承担路由注册、模型目录查询、数据库 CRUD、SSE 兼容、能力目录、设置、健康检查 | 任何新能力都要改这一个文件，是合并冲突与回归的主要来源；无法单独测试路由层 |
| A2 | **配置能力分裂在多处**：`config.ts`（模型/内置工具/运行时）、`settings.ts`（用户设置）职责边界模糊，`promptTemplate` 曾在两边语义重叠 | 新人无法快速判断「这个旋钮该加在哪」，上一轮 E3–E7 全是这类问题的产物 |
| A3 | **无 `core/` 内核目录**：通用 Agent 内核（协议/编排/能力）与垂直示例（`tools/knowledge.ts`、`tools/database.ts`、`db/`）平铺在同一层 | 换业务场景时难以判断哪些该留、哪些该删；示例代码与框架代码的演进节奏不同，却被同等对待 |
| A4 | `Conversation` 事件映射与快照调度耦合在一个 `onEvent` 里 | 加一种 SDK 事件要同时考虑「推什么消息」和「要不要立即 flush 快照」两件事 |

### 目标状态

- `core/` 明确承载通用内核，`examples/` 承载可替换的垂直示例（知识库 / SQLite / 当前时间），换业务时只删 `examples/`。
- `app.ts` 拆为路由模块（`routes/health.ts`、`routes/db.ts`、`routes/capabilities.ts`、`routes/chat.ts`），`createApp` 只做装配。
- 配置统一为「一次性 resolve + 单一 schema」，消除 `promptTemplate` 这类双写。

---

## 二、代码质量

### 现状（中上）

- 命名语义准确（`flushSnapshot` / `decideApproval` / `planContextTrim` 一眼可懂），注释写「为什么」而非「是什么」。
- 类型标注完整，`tsc` 零错误，协议层有编译期断言。
- 依赖极简：5 个运行时依赖（3 个 SDK + express + ws），无 helmet/cors/pino 等。

### 差距（本轮已修部分）

| # | 问题 | 风险与影响 |
|---|---|---|
| Q1 | **`console.log` 全项目散落**，无级别、无结构、不可注入 | 安全警告与调试信息混杂，无法按级别过滤；库嵌入方无法接管输出；无法机器聚合 |
| Q2 | **错误处理两极化**：`ws.ts` 已 try/catch + 计数，但 `app.ts` 各路由手写 try/catch 且**错误文案直接回给客户端**（含内部细节） | 内部路径 / SQL 错误原文泄漏；且每加一路由就要重写一遍样板 |
| Q3 | **`audit.ts` 把完整参数写日志**（`JSON.stringify(event.args)`） | `db_query` 的 SQL、`write` 的文件内容、任何入参里的密钥全部落盘 |
| Q4 | 缺少统一错误类型，`error` 多为裸 `Error` | 无法按类型分支处理（如「可重试」vs「致命」） |
| Q5 | `guard.ts` 的 bash 危险规则与 `approval/rules.ts` 的内置规则**语义重叠但各自维护** | 同一威胁两处定义，改一处忘一处；且 guard 是硬拦截、approval 是询问，两层关系从未在文档中说明 |

### 本轮已修

- **Q1** → 新增 `src/log.ts`：级别 + 结构化字段 + **自动脱敏**（apiKey/token/password 等一律打码，长字符串截断，`Error` 保留 name/message/stack/cause）+ 可注入 sink。已替换 `server.ts` / `guard.ts` / `audit.ts` / `ws.ts`。
- **Q3** → `audit.ts` 改记**元信息**（工具名、参数字段名、耗时、成败），不记录参数值；`startTimes` Map 加 256 上限防泄漏。
- **Q2** 部分 → 错误响应已带明确文案（413 超限 / 非法 JSON / SQL 具体拒绝原因），但**统一错误类型**仍未做（见 M3）。

### 目标状态

- 全部非 CLI 路径走 `log.ts`；CLI（`index.ts` / `setup.ts`）保留 `console`——那里 console 就是人机界面。
- 引入 `AppError` 体系（`code` + `httpStatus` + `safeToExpose`），路由只需 `throw`，由统一中间件翻译。

---

## 三、稳健性与可靠性

### 现状（良好部分）

- 审批超时 **fail-safe**（不响应即拒绝），且定时器刻意不 `unref()`（上一轮修复）。
- 背压下丢弃快照而非阻塞，客户端靠 `rev` 链自愈。
- 优雅停机顺序正确：先 `gate.dispose()` 拒绝在途请求，再关 socket，再丢会话。
- `ready` 保证是第一帧；未 attach 的命令进 pending 队列按序回放。

### 差距

| # | 问题 | 风险与影响 |
|---|---|---|
| R1 | **会话数无上限** | 每个对话独占一个完整 `AgentSession`（loader + 工具 + 订阅）。恶意/失控客户端循环 `new_conversation` → 内存与 CPU 线性泄漏，直至 OOM。pi-web-ui 有 `MAX_OPEN_CONVERSATIONS=8`，本项目**完全没有** |
| R2 | **SQL 结果行数无上限** | `SELECT * FROM big_table` 一次性把全表拉进内存，再经工具结果灌进 LLM 上下文 → OOM + 上下文击穿 + 费用失控 |
| R3 | **快照消息数无上限** | 长对话每份快照随历史线性增长，而快照每个节流周期（60ms）都要重新序列化 → CPU 与带宽持续恶化 |
| R4 | **知识库/技能加载无大小上限** | 单个超大 `.md` 直接进内存并进系统提示词 |
| R5 | ~~`/chat` 的 `busy` 与 WS 会话互不感知~~ **实测证伪** | 原判「REST 与 WS 会并发驱动同一 `agent.session`」——**不成立**：`createSession` 工厂总是存在，REST 用的是 `agent.session`，WS 每个对话各自 `createSession()`，实测两者 `sessionId` 不同。真正的问题是**模型状态分裂**（见 M5） |
| R6 | 无请求级超时（单个 `/chat` 可无限挂起） | 连接与资源被长期占用 |
| R7 | 工具执行无看门狗 | 挂死的工具调用会永远阻塞该对话，且没有任何信号 |

### 本轮已修

- **R1** → `DEFAULT_MAX_OPEN_CONVERSATIONS = 8`，**LRU 回收**（关闭最久未活动的非活动对话）而非拒绝请求——拒绝会破坏客户端流程。回收前才分配，避免瞬时超限。
- **R2** → `DEFAULT_MAX_ROWS = 200`，结果带 `truncated` / `totalRows`，**工具显式告知模型**「已截断，请加 LIMIT」——否则模型会误以为表里就这么些行。
- **R3** → `MAX_SNAPSHOT_MESSAGES = 500`，只截尾（保留最新）；服务端保留完整历史，**不影响增量快路径**（保留的仍是同一数组的稳定前缀）；快照新增 `messagesTruncated` / `totalMessages` 供 UI 提示。
- **R6** → `applyServerTimeouts()`：`requestTimeout` 120s（给长 LLM 轮次留足）、`keepAliveTimeout` 75s、`headersTimeout` 20s（挡 Slowloris）。

### 目标状态（本轮已达成）

- R4 知识库/技能体积上限 → **X3**；R5 经实测**证伪**（REST 与 WS 本就是不同 session），
  真正的问题是模型状态分裂 → **M5**；R6 服务器超时 + R7 工具看门狗 → **S4 / X1**。
- 所有外部调用有超时上限；错误按类型分支处理（`AppError`）。

---

## 四、安全性

### 现状（良好部分）

- 默认只绑 `127.0.0.1`，非 loopback 时**大声告警**「无鉴权」。
- WS 升级前做 **Origin/Host 同权威校验**（防 DNS rebinding 与跨站 WS），实测跨站被拒。
- 审批规则引擎：`deny` 不可被策略覆盖（关审批也不放过 `mkfs`/`dd`/fork-bomb），超时 fail-safe。
- `maxPayload` 1 MiB 上限。
- 能力标签驱动的治理：新增工具自动纳入审批策略。

### 差距（本轮最关键）

| # | 问题 | 严重度 | 风险与影响 |
|---|---|---|---|
| **S1** | **只读 SQL 校验可绕过** | **高** | 原实现 `if (!/^(with\|select)/i) return false`，只查开头。`WITH x AS (DELETE FROM notes RETURNING *) SELECT * FROM x` **开头是 WITH → 直接放行**。实测当前 node:sqlite 自行报错拦住了写操作，**未造成数据损坏**——但这是「依赖驱动兜底」而非「自身防御」，一旦换驱动/引擎即刻失守。且 `db_query` 的 SQL 来自 **LLM**，提示词注入即可触达 |
| **S2** | **`express.json()` 无 body 上限** | **高** | 单个请求即可打满进程内存。默认 100kb 是有，但项目**没设**，等于用 Express 默认的 100kb……实测：Express 默认确为 100kb，但未显式声明意味着无人知道这个边界，且库嵌入方若自行 `express.json()` 覆盖就会失效 |
| **S3** | **无安全响应头** | 中 | 缺 `nosniff`（MIME 嗅探）、`X-Frame-Options`（点击劫持）、CSP。浏览器直接消费 `/knowledge/:name`、`/skills/:name` 的正文 |
| **S4** | **无速率限制** | 中 | `/chat` 与 `/db/query` 都是重资源端点，可被轻易打爆 |
| S5 | 无鉴权（**设计如此**） | 中 | 非 loopback 暴露即等于把 Agent 与全部工具开放。已告警，但仅告警不足 |
| S6 | 审计日志记录完整参数 | 中 | 密钥/SQL/文件内容落盘（本轮已修） |
| S7 | `guard.ts` 只做路径包含判断，**不处理符号链接** | 低 | 注释已声明「要沙箱请用容器」，属已知边界 |
| S8 | 无依赖漏洞扫描 | 低 | 5 个运行时依赖，面小风险低，但无 `audit` 流程 |

### 本轮已修

- **S1** → 重写为**白名单 token 扫描**（非正则）：
  1. 先剥离注释与字符串字面量，**剥离失败（未闭合注释/引号）→ 拒绝而非放行**；
  2. 分词后**全文扫描** 60+ 个禁用关键字（写/DDL/事务/ATTACH/PRAGMA/触发器），不看位置 → CTE 内写入一并拦下；
  3. 单语句、长度上限（20k）、必须以 SELECT/WITH 开头并以 SELECT/VALUES 收尾；
  4. 拒绝时返回**具体原因**（如「检测到非只读关键字：DELETE」），让模型能自我纠正。
  28 条用例全通过，含 5 条 CTE 绕过、3 条注释/字符串绕过、3 条语法不完整。
- **S2/S3** → 新增 `src/http/hardening.ts`：显式 `bodyLimit`（默认 1mb）+ 安全头（`nosniff` / `DENY` / `no-referrer` / 严格 CSP / COOP / CORP）+ 关闭 `X-Powered-By`。CSP 断言不含 `unsafe-inline` 与通配符。
- **S6** → 见 Q3。

### 目标状态

- S4 速率限制：按 IP + 端点分级（`/chat` 最严），纯内存令牌桶即可，不引依赖。
- S5：明确「loopback 免鉴权 / 非 loopback 必须前置鉴权代理」，并在 `/health/ready` 中以 `authRequired` 字段显式暴露当前姿态。
- S8：CI 加 `npm audit --audit-level=high`。

---

## 五、可维护性与可测试性

### 现状（本项目最强项）

- **纯函数内核**：`evaluateRules` / `decideApproval` / `planContextTrim` / `composePrompt` / `scanReadOnlySql` 全部无 IO、无 SDK 依赖，可直接断言。
- **依赖倒位做得好**：传输层通过回调拿 `push`，审批通过 `onRequest`，持久化通过 `SettingsPort`——核心逻辑零 IO。
- **三层验证已建立**：typecheck（类型 + 协议完备性）/ 单测（81 项）/ 运行时冒烟（15 项真实 WS 端到端）。
- 注释写清了「相对 pi-web-ui 的改进点」，便于后续维护者理解设计取舍。

### 差距

| # | 问题 | 风险与影响 |
|---|---|---|
| M1 | **无集成测试层** | 只有「纯函数单测」与「自建 WS 冒烟」，**真实 `buildAgent` + 真实 session 的端到端**没有自动化；SDK 升级时最该被测的那层反而没测 |
| M2 | 无覆盖率报告 | 不知道哪些分支真的被覆盖；`app.ts` 各路由的异常分支尤其可疑 |
| M3 | 错误无类型（见 Q4） | 统一处理缺位 |
| M4 | 无 CI 配置 | 所有验证靠人工记忆执行；`scripts/` 里的验证脚本不会被自动触发 |
| M5 | 文档与实现存在**两处不一致**：README 未提及新增的 `/health/ready`、`/metrics` 与加固行为 | 使用者按旧文档理解系统行为 |

### 本轮已修

- 新增 `src/infra.test.ts`（16 项）锁死日志脱敏 / 级别过滤 / Error 序列化 / 指标单调性 / Prometheus 格式 / 安全头不含放行型指令 / `headersTimeout ≤ keepAliveTimeout`。
- 扩充 `src/db/index.test.ts`（+7 项）与 `src/app.test.ts`（+3 项）。
- 测试总数 **54 → 81**。

### 目标状态（本轮已达成）

- M1 集成测试层、M2 CI → 已落地；M4 覆盖率未单列工具，但 CI 已跑全量套件 + 严格类型检查。

---

## 六、性能与资源

### 现状（良好）

- 快照增量判定靠对象引用等同性，常见「仅追加」只发几百字节而非全量。
- `WeakMap` 消息投影缓存 + `tokenCache`，使 token 统计从 O(总字符) 降到 O(新消息)。
- `serializeShared` 按对象身份缓存 stringify，N 个标签页共享一次序列化。
- `perMessageDeflate` 阈值 16KB——大快照压、小消息不付压缩成本。
- 快照节流 60ms，流式期降为 2s 检查点。

### 差距

| # | 问题 | 风险与影响 |
|---|---|---|
| P1 | **无界增长三处**（会话数 / SQL 行数 / 快照消息数） | 详见 R1–R3，**本轮已修** |
| P2 | `estimateConversationTokens` 在超长对话上仍是 O(n) 扫描 | 有 token 缓存兜底，实测 500 条消息约 0.1ms，可接受 |
| P3 | 无慢客户端的**连接级**背压升级策略 | 只会丢快照，不会断开超慢连接；极端情况下占用内存 |
| P4 | 知识库检索是**线性子串匹配** | 文档量大时 O(n) 扫描；当前规模（个位数文档）无碍 |

### 本轮已修

- **P1** 三处护栏全部落地（见 R1–R3）。

### 目标状态

- P3：为 `bufferedAmount` 持续超阈值的连接加「连续丢弃 N 次即断开」，避免僵尸连接。
- P4：文档量上百时再考虑倒排索引，当前**明确不做**（过早优化）。

---

## 七、实施计划

### 🟢 短期（已完成本轮，可直接使用）

| # | 改造项 | 目标 | 关键文件 | 验证方式 | 完成标准 |
|---|---|---|---|---|---|
| S1 | 只读 SQL 重写 | 校验器自身拦住 CTE 内写入，不依赖驱动兜底 | `src/db/index.ts` | `db/index.test.ts` 28 用例 | 5 条 CTE 绕过 + 3 条注释绕过 + 3 条语法不完整全部拒绝 ✅ |
| S2 | body 限制 | 超限返回 413 而非撑爆内存 | `src/http/hardening.ts`、`app.ts` | `app.test.ts` + 真实 curl | 4KB body 在 512b 限制下返回 413 ✅ |
| S3 | 安全响应头 | 消除嗅探 / 点击劫持 / 信息泄漏 | `src/http/hardening.ts` | `app.test.ts` 断言 + 真实 `curl -i` | 5 个头到位，`X-Powered-By` 消失 ✅ |
| S4 | 服务器超时 | 挡 Slowloris，留足 LLM 轮次 | `http/hardening.ts`、`server.ts` | 真实服务器读值 | 120s/75s/20s ✅ |
| S5 | 结构化脱敏日志 | 可过滤、可聚合、不泄密 | `src/log.ts`、`server.ts`、`guard.ts`、`audit.ts`、`ws.ts` | `infra.test.ts` 16 项 | 密钥类字段 100% 打码，`Error` 保留 cause ✅ |
| S6 | 指标体系 | 能回答「现在怎样、趋势如何」 | `src/metrics.ts`、`ws.ts`、`session-hub.ts` | 真实 WS 负载后抓取 | 协议错误/快照发送计数正确递增 ✅ |
| S7 | 无界增长护栏 | 会话 8 / SQL 200 行 / 快照 500 条 | `session-hub.ts`、`db/index.ts` | 单测 + 真实验证 | LRU 回收生效；截断如实上报 ✅ |
| S8 | 深度健康探针 | 区分「活着」与「能干活」 | `app.ts` | 真实服务器 curl | `/health` 轻量存活；`/health/ready` 返回 503 当依赖故障 ✅ |

---

### 🟡 中期

> **本轮已全部完成**（原 M1–M9）。

| # | 改造项 | 目标 | 关键文件 | 验证方式 | 完成标准 |
|---|---|---|---|---|---|
| M1 | **集成测试层** | 覆盖真实编排栈（Hub → ClientSession → Conversation → Snapshot → WS），且不依赖网络 | 新增 `src/integration.test.ts` | 真实 HTTP + WS 端到端 | 13 项全通过：多对话隔离 / LRU 回收 / 事件翻译 / 引用稳定性 / 重连自愈 / 快照截断 ✅ |
| M2 | **CI 流水线** | typecheck + 未使用符号 + test + smoke + audit + build 全自动 | `.github/workflows/ci.yml` | PR 触发 | 六道关卡任一失败即红灯 ✅ |
| M3 | `AppError` 体系 | 错误类型化，统一翻译 | 新增 `src/http/errors.ts` | `errors.test.ts` 8 项 | 路由不再手写 try/catch；`internal` 默认隐藏内部细节 ✅ |
| M4 | **速率限制** | 保护重资源端点 | 新增 `src/http/rate-limit.ts` | `rate-limit.test.ts` 8 项 + 真实 HTTP | `/chat` 30/min、`/db/query` 120/min；探针不限流；不信任非白名单 XFF ✅ |
| M5 | 模型状态单一真源 | REST 与 WS 不再分裂 | `agent.ts` / `session-hub.ts` / `app.ts` | 集成测试 + 实测 | `agent.model` 改为 **live getter**；新增 `hub.setModel()` 作为唯一正确入口；`app.ts` 每请求读 getter 而非缓存 ✅ |
| M6 | 路由拆分 | `app.ts` 449 → 266 行 | 新增 `src/http/routes.ts` | 全量测试不回归 | 18 个端点一个不少，职责分离 ✅ |
| M7 | 类型化错误落地 | 消除 9 处重复样板 | `app.ts` / `routes.ts` | 真实 HTTP 验证 | 拒绝原因可操作（`检测到非只读关键字：DELETE`），内部细节不外泄 ✅ |
| M8 | 未使用符号门禁 | 防止死代码（正是「声明≠生效」的温床） | `npm run lint:unused` + CI | CI | `--noUnusedLocals --noUnusedParameters` 零告警 ✅ |
| M9 | 文档同步 | 文档与实现一致 | `README.md` / 本文档 | 人工核对 | 新端点、加固行为、错误语义已写入 ✅ |

### 🟣 本轮额外完成（评估后新发现）

| # | 改造项 | 说明 |
|---|---|---|
| X1 | **工具执行看门狗** | 挂死的工具会永久阻塞对话且无任何信号。新增 `src/approval/watchdog.ts`：超时即 `abort()`（不重试），定时器**刻意不 unref**（否则形同虚设），豁免等待人类的工具；`settings.toolTimeoutSeconds` 控制（默认 1200s）。9 项真实计时测试 |
| X2 | **慢客户端断开** | 只会丢快照不会断连，僵尸连接长期占用内存。新增 `PI_WS_MAX_CONSECUTIVE_DROPS`（默认 8）：连续丢弃超阈值即 `terminate()`；任何一次成功发送即清零。已并入 smoke |
| X3 | **知识库 / 技能体积上限** | 单个超大 `.md` 会直接进内存。新增文档 512KB / 500 篇、技能 256KB / 32 个路径 / 200 个，且**读取前**判大小（大文件根本不进内存）。两者机制不同：**知识库**用 `statSync` 在 `readFileSync` 之前拦；**技能**必须先把喂给 SDK 的路径粒度从「扫描根目录」改成「技能目录」（`resolveSkillPaths` 返回每个技能自己的目录），否则 SDK 会无差别读满——实测 SDK 接受单个技能目录，因此拦在 SDK 读取之前是可行的。两条路径共用同一份过滤逻辑，`/skills` 清单与系统提示词因此不会不一致 |
| X4 | **日志级别语义修正** | 4xx 是调用方错误（预期流量），记 `error` 会让真实 5xx 淹没在噪声里。改为 5xx→`error`、4xx→`warn` |

### 🔁 复核轮（对上一轮结论逐条实测，而非采信声称）

上一轮的 ✅ 标记并非全部经得起复测。以下两条在复核中被推翻并已修复：

| # | 声称 | 实测结果 | 处置 |
|---|---|---|---|
| V1 | M5「`agent.model` 改为 live getter，**结构上消除过期可能**」 | **只修了一半。** `createApp` 里 `let currentModel = options.agent.model` 又把 getter 快照成局部变量，且只在 `POST /model` 里更新。而 WS 的 `set_model` 走 `hub.setModel()`、**完全绕过 app**——实测 WS 切到 `test/m2` 后，`/info` 仍报 `test/m1`，`/health/ready` 同理。即「过期快照」换了个地方复现 | `app.ts` 改为每请求读 `options.agent.model`；新增集成回归测试，并做过**反向验证**（把实现改回快照形态，测试确实红） |
| V2 | X3「知识库/技能……**读取前**判大小」 | **只有知识库做到了。** 技能侧只有数量/路径上限（32 / 200），`SKILL.md` 无任何大小门。根因：喂给 SDK 的 `additionalSkillPaths` 是**扫描根目录**，SDK 会无差别读满，无法按单文件拦截 | 路径粒度改为「每个技能自己的目录」，加 256KB `stat` 门（详见 X3）；新增 2 项测试 |

**方法论教训（本轮最值得记的一条）**：M5 这类「结构性修复」最容易只改到一半——getter 加在了底层，上层随手又缓存了一份，于是「结构上消除」变成「换地方复现」。判断此类声称是否成立只能靠**端到端实测**，且测试要做反向验证以确认它真能捕获该 bug。

### 🔵 长期（按业务优先级触发）

| # | 改造项 | 触发条件 | 说明 |
|---|---|---|---|
| L1 | 设置 / 规则库**落盘** | 需要重启后保留配置时 | `SettingsPort` 已备；当前内存端口，**重启丢设置** |
| L2 | 会话持久化 | 需要跨重启恢复对话 | `SessionManager` 已支持落盘（CLI 模式即用），Web 侧接上即可 |
| L3 | 计划模式 / 委派审阅 | 垂直 Agent 需要「先规划后执行」 | 复用 `ApprovalGate` 的闸门模式 + 会话级 `mode` + 提示词软约束 |
| L4 | 压缩联动 | 长对话体验受损时 | `planTrim()` 已把 `overBudget` 送进快照；接 `session.compact()` 成两级策略。**保持人工触发** |
| L5 | MCP 工具桥 | 需要接入外部工具时 | `ToolRegistry` 的 `source: "dynamic"` 已预留 |
| L6 | 可选鉴权 | 需要非 loopback 暴露时 | **明确不做内置多用户**；只提供「校验单个共享 token」的中间件，身份体系留给接入方 |
| L7 | 倒排索引 | 知识库文档数上百时 | 当前线性子串匹配，个位数文档无碍，**明确不过早优化** |

## 八、改造前后对照

| 维度 | 改造前 | 改造后 |
|---|---|---|
| SQL 只读防御 | 开头正则，CTE 可绕过，靠驱动兜底 | 全文 token 扫描，5 类绕过全拦，附具体拒绝原因 |
| HTTP body | 无显式上限 | 1MB 显式上限，超限 413 |
| 安全响应头 | 无 | 5 个头 + 关闭框架指纹 |
| 服务器超时 | Node 默认 | 120s/75s/20s 显式 |
| 日志 | 裸 `console.log`，参数全量落盘 | 结构化 + 级别 + 自动脱敏 + Error 保真；4xx→warn / 5xx→error |
| 审计 | 记录完整参数（含 SQL/密钥） | 只记元信息（工具名/字段名/耗时/成败） |
| 可观测性 | 无 | 14 项指标 + JSON 与 Prometheus 双格式 + uptime |
| 健康检查 | 单个 `/health`（混合存活与清单） | `/health` 存活 · `/health/ready` 依赖 · `/info` 清单 |
| 会话数 | 无上限（OOM 风险） | 上限 8 + LRU 回收 |
| SQL 结果 | 无行数上限 | 200 行上限 + 截断如实上报 |
| 快照大小 | 随历史无限增长 | 上限 500 条 + 截断标记 |
| 工具执行 | 挂死则永久阻塞，无信号 | 看门狗超时即中止（默认 20min，可豁免等人类的工具） |
| 知识库/技能 | 无体积上限 | 文档 512KB/500 篇、技能 32 路径/200 个，**读取前**判大小 |
| 慢客户端 | 只丢快照，不断连 | 连续丢弃超阈值即 `terminate()` |
| 重资源端点 | 无配额 | `/chat` 30/min、`/db/query` 120/min，探针不限流 |
| 错误处理 | 9 处重复 try/catch，内部文案直接外泄 | `AppError` 类型化 + 统一翻译；`internal` 默认隐藏内部细节 |
| 模型状态 | `agent.model` 是快照会过期；WS 切换不传播 | live getter + `hub.setModel()` 单一入口 |
| 路由组织 | `app.ts` 449 行全包 | 拆为 `src/http/routes.ts`，`app.ts` 266 行 |
| 测试 | 54 项 | **121 项**（含 13 项集成）+ 17 项运行时冒烟 |
| CI | 仅 typecheck/test/build | 六道关卡：+ 未使用符号门禁 + smoke + audit |
| 代码规模 | 42 文件 / 7067 行 | 54 文件 / 10097 行（+8 模块，**无重写**） |

---

## 九、给使用者的三条硬约束

1. **非 loopback 暴露必须前置鉴权代理。** 本项目**不内置鉴权**（这是刻意的定位选择，不是遗漏）。绑 `0.0.0.0` 等于把 Agent 与全部工具开放出去——启动时的 warn 是最后一道提醒。
2. **设置目前不落盘。** 重启后 `promptTemplate` / `disabledTools` 等会回到默认值。需要持久化见 L1。
3. **默认档位是安全的。** `builtinTools=off`（关 bash/edit/write）、审批默认关但 `deny` 规则始终生效、绑定 loopback。放开前请确认已理解对应风险。
