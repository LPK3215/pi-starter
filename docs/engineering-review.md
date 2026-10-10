# pi-starter 走查报告

> 走查基线：commit `e17b114`，`git status` 无未提交改动。
> 走查日期：2026-10-10。
>
> **本文的定位**：这是一份**独立的代码走查**，只写本次实际读到的源码与实际跑出的结果。
> 仓库里已有一份归档快照 [`项目分析报告.md`](项目分析报告.md)（历史判断，已被作者标注过期）
> 和一份第一人称自评 [`智能体视角评估.md`](智能体视角评估.md)（从「我在这里当智能体」的体感出发）。
> 本文不重复上述两份的结论；凡与它们冲突处，以源码为准，并在文中标明冲突点。

---

## 1. 走查方式与实测证据

读的范围：`src/` 全量目录结构 + 组装/编排/协议/HTTP/传输/配置/审批/设置等关键文件正文，
`web/src` 结构与胶水层，`scripts/` 与 CI 配置，`.github/workflows/ci.yml`、`Dockerfile`、
`pipeline.config.json`、`package.json`、`CHANGELOG.md`（当前区间）、`docs/*.md`。

实际执行过的命令（非交互、带超时）：

| 命令 | 结果 |
|---|---|
| `node -v` / `npm -v` | `v24.21.0` / `11.19.0`（`engines.node` 要求 `>=22.19`，满足） |
| `npm test` | **470 passed / 0 failed**（12.8s）——与 README Numbers 表的「49 files · 470 cases」一致 |
| `npm run docs:check` | `README.md` 一致、`README.zh-CN.md` 一致、`docs/参考手册.md` 一致 |
| `find src -name '*.ts' ! -name '*.test.ts' \| wc -l` | 77（与 Numbers 表一致） |
| `find src -name '*.test.ts' \| wc -l` | 49（与 Numbers 表一致） |
| `wc -l src/session-hub.ts` | 2169（与 Numbers 表「最大单文件」一致） |

结论先行：**门禁是真的、数字在它保护的范围内是真的**；本次确认的两处缺陷都落在
**生成器覆盖不到的手写散文**里（见 §8）。

---

## 2. 项目定位与运行形态

`package.json`：包名 `pi-starter`，版本 `0.3.0`，`"type": "module"`，`engines.node >= 22.19`
（硬依赖 `node:sqlite`）。运行时依赖只有 5 个：pi 三件套（`pi-agent-core` / `pi-ai` /
`pi-coding-agent`，全部钉在 `0.83.0`）、`express@^5.2.1`、`typebox`、`ws`。
`@huggingface/transformers` 在 `optionalDependencies`，代码懒加载。

三个入口，全部汇到同一个组装函数 `buildAgent()`：

| 入口 | 文件 | 形态 |
|---|---|---|
| CLI 交互 | `src/index.ts` | readline 循环，`session.prompt()` 阻塞式一轮 |
| Web 服务 | `src/server.ts` | Express + WebSocket，单进程，`listen` 后常驻 |
| 官方 RPC | `src/rpc.ts`（`--mode rpc`） | stdio JSONL，给跨语言 / 子进程集成 |

对外有**两条并行通道**，不互相替代：

1. **REST + SSE**（`src/app.ts`）：语言无关，`POST /chat` 是单向流式出口，另有大量资源
   与运维接口（探活、指标、技能/知识库/数据库、文件、审批规则、provider key、日志）。
2. **WebSocket**（`src/transport/ws.ts`，911 行）：双向、快照驱动、多对话，产品化前端走这条。

---

## 3. 架构与依赖方向

分层（自上而下）：

| 层 | 位置 | 职责 |
|---|---|---|
| 入口 | `index.ts` / `server.ts` / `rpc.ts` | 解析命令行、拼装、监听 |
| 组装 | `agent.ts`（797 行，`buildAgent`） | 模型 + 人设 + 工具 + 技能 + 知识库 + 扩展 → `AgentSession` |
| 编排 | `session-hub.ts`（**2169 行，仓库最大单文件**） | `SessionHub` → `ClientSession` → `Conversation` → `SnapshotEmitter` |
| 协议 | `protocol.ts`（535 行） | 前后端唯一线协议单源（`UiState` / `ClientMessage` / `ServerMessage`） |
| HTTP | `app.ts` + `http/*`（14 个文件） | 路由 + 加固 + 限流 + 错误翻译 + 请求上下文 |
| 传输 | `transport/ws.ts` | 快照推送、背压、命令分派、Origin 校验 |
| 业务资源 | `tools/` `skills/` `knowledge/` `prompt-templates/` `prompts/` `db/` `extensions/` `mcp/` `modes/` `subagents/` `approval/` `exec/` `files/` `sessions/` | 全部可替换或可注入 |
| 基础设施 | `log.ts` `metrics.ts` `snapshot.ts` `graceful.ts` `sdk-adapter.ts` `child-env.ts` `secret-files.ts` `settings.ts` `provider-keys.ts` | 横切能力 |

装配链（`server.ts` 头部注释与代码一致）：`settings → rules → gate → buildAgent(带审批扩展)
→ registry → hub → app/http → ws`。请求链：HTTP body → busy guard → `session.prompt` →
`tool_call` 钩子（扩展链，如 `guard`）→ 工具执行 → `tool_result` 钩子（如 `audit`）→
SDK 事件 → `translateEvent()` → SSE/WS 帧。

**依赖方向的一处倒置**：组装层与编排层反向 import HTTP 层的错误原语——
`src/agent.ts:68` 与 `src/session-hub.ts:29` 都 `import { badRequest } from "./http/errors.js"`。
方向上 `http/` 是外层，内层依赖外层。当前没有实际故障（纯函数与类型），但库消费方
`import { buildAgent } from "pi-starter"` 会连带加载 http 模块；若将来 http 层反向依赖编排层
即成环。见 §8 P2-3。

---

## 4. 工程亮点（均有源码依据）

1. **fail-closed 贯穿 I/O 路径**。敏感文件按 basename + **真实目标名（realpath）**双判，
   `read` / `write` / 目录列表预览三个出口同一名单（`src/secret-files.ts`）；会话恢复走
   `assertSessionFileAllowed` + 白名单，空数组即「不允许打开任何已有文件」；协议层
   `isClientMessage` 拒绝空串与纯空白 `type`。
2. **契约单源**。`protocol.ts` 被前端以别名 `@pi/protocol` 直接引用（`web/tsconfig.app.json`
   include `../src/protocol.ts`），没有第二份翻译表；客户端命令集合有**编译期守卫**
   （`src/protocol.ts:533-535` 的 `Exclude<...> extends never` 断言）。
3. **门禁链真实且被执行**。`verify` = typecheck → lint:unused（死代码门禁）→ test → test:web
   → docs:check → smoke → build → verify:embed；CI 是三 OS × 三 Node 矩阵
   （`.github/workflows/ci.yml:24-27`），另加覆盖率棘轮（`scripts/coverage.mjs:23`，
   lines 92 / branches 81 / functions 85）、依赖审计、生成物一致性检查。
4. **「生成器即检查」**。`scripts/visualization/generate_reference.mjs` 在生成过程中带硬断言：
   解析出的命令集合必须与 `CLIENT_MESSAGE_TYPES` 完全一致；`src/tools/*` 里出现的工具名必须
   在分组表里登记，新增工具忘了归类直接让门禁变红。
5. **SDK 私有面收敛**。所有 SDK 私有形状访问收进 `src/sdk-adapter.ts`，不在各调用点各写兜底。
6. **子进程不继承模型密钥**。`src/child-env.ts` 剔除 `PI_API_KEY*`，`exec` 与 MCP 同口径，
   并有单测与 e2e 锁定。
7. **限额有上界且如实上报截断**：SQL 200 行、快照 500 条、知识文档 512KB、JSON body 1MB、
   联网 256KB（硬顶 2MB）/15s（硬顶 60s）。
8. **默认最小权限**：`PI_BUILTIN_TOOLS` 默认 `off`（只放 `read` + 自定义工具），
   联网默认关（`PI_WEB=off`），审批默认 off——后者是明示的取舍，写进了 `SECURITY.md`。

---

## 5. 安全模型（与 `SECURITY.md` 自述一致，此处只做复核）

- **无鉴权是设计取舍**：`src/server.ts:84-90` 对非 loopback 绑定只 `logger.warn`，不阻断。
  因此公网暴露等于把 Agent 及其工具一起交出去。
- **`guard` 不是沙箱**：它是正则 + 路径的软闸门，README 与 `SECURITY.md` 都已明确
  「命令体无路径约束、正则可被绕过」。硬隔离走部署层——仓库自带 `Dockerfile`
  （非 root、`PI_HOST=0.0.0.0` 但文档要求只 `-p 127.0.0.1:`）。
- **文件服务于 `process.cwd()`**：`FileService({ root: process.cwd() })`，越界与符号链接逃逸
  在 service 内部拒绝，敏感名单同样生效。
- **未缓解项如实声明**：联网 URL 由模型决定；DNS 解析与建连之间存在 TOCTOU 窗口。

---

## 6. 前端

`web/` 是**独立 npm 项目**（自己的 `package.json` / lockfile / CI 作业）：React 19 + Vite 8 +
assistant-ui + Tailwind 4。手写代码只有一层胶水 `web/src/pi/`：

| 文件 | 职责 |
|---|---|
| `client.ts` | `PiWsClient`：把 `ServerMessage` 推流收敛成只读快照 `PiSnapshot`，含 `hello→ready` 握手、`rev/baseRev` 修订链与断链自愈、跨会话帧过滤、退避重连 |
| `usePiRuntime.ts` | 适配 assistant-ui 的 `ExternalStoreAdapter`，`useSyncExternalStore` 桥接 |
| `logClient.ts` | 唯一 REST 客户端，查 `GET /logs`、`/logs/stats` |

测试：`client.test.ts`（11 例）+ `logClient.test.ts`（8 例）= **19 例**，用 `node:test`，
不引入新依赖，也不依赖 DOM（因此不碰 React 层）。

已在 `web/README.md` 自述的缺口：无 i18n（文案硬编码中文）、无 a11y 专项、无前端 e2e、
离线不重发（`send()` 直接返回 `false`）、审批卡的「改写后允许」按钮被移除。

---

## 7. 文档体系

9 份 `docs/*.md`（Numbers 表把它记作「手写文档」，但其中 `参考手册.md` 是生成的，
本报告本身也是新增的一份）+ 3 张生成 SVG + 1 个静态全景页（`docs/project_overview/`）。
其中两份 README 的数字、`docs/参考手册.md` 是**从源码生成**的，且进了 CI 门禁。
`项目分析报告.md` 已被作者主动改成归档页（标注历史快照 + 「当时判断 → 现在状态」对照表）。

---

## 8. 本次走查确认的问题

### P1-1 英文 README 的「设置仅内存、重启重置」与实现直接矛盾（已修复，见 §11）

- 症状：`README.md:113` 写 `settings are currently in-memory only, so promptTemplate /
  disabledTools reset on restart`。
- 事实：`src/server.ts:97-109` 构造 `SettingsService` 时注入的是
  `fileSettingsPort(defaultSettingsFile())`；`defaultSettingsFile()` =
  `~/.pi/agent/pi-starter-settings.json`（`src/settings.ts:258-261`）；
  `fileSettingsPort` 是原子写 + 损坏回落（`src/settings.ts:186` 起）。
  中文 README 写的是正确表述：「会话 / 设置 / 规则落盘」（`README.zh-CN.md:102`）。
- **已被项目自己的 e2e 反证**：`scripts/e2e-restart.mjs:408-446` 明确断言
  「改 → 落盘 → 重启后生效」（`PATCH /settings` → 校验磁盘文件 → SIGKILL → 重启 → 断言生效）。
- 影响：读者会以为配置在长驻部署里每次重启丢失，据此做出错误决策（例如每次重启重新 PATCH）。
- 根因：这是手写散文，不在生成器漂移门禁的覆盖范围内——`docs:check` 只保护 README 的
  Numbers 标记块与 `docs/参考手册.md`。
- 关联：`docs/智能体视角评估.md:190` 重复了同一说法（依据写的是「`src/settings.ts:313`；
  README 亦声明」）。`settings.ts:313` 说的是**类默认参数**是 `memorySettingsPort()`，
  对「库内直接 new `SettingsService()`」成立，但**不适用于随包提供的 `server.ts` 装配**。
  两处都需要更正为「默认落盘到 `~/.pi/agent/pi-starter-settings.json`；直接 new 才走内存」。

### P1-2 README 的「60+ REST 路由，由源码生成、不会漂移」与生成物矛盾（已修复，见 §11）

- 症状：`README.md:251` 写 `all **34 WS client commands**, **21 server frames**,
  **60+ REST route handlers** ... is generated from source into docs/参考手册.md ...
  so it cannot drift`。
- 事实：`docs/参考手册.md:93` 写「共 **44** 个路由处理器」（生成器按 method+path 去重，
  `scripts/visualization/generate_reference.mjs:393`）；README 的 Numbers 表写 **55**
  （`scripts/visualization/generate_readme_numbers.mjs:97-115`，按 `.get(`/`.post(` 出现次数计）。
  同一件事出现三个数字：44 / 55 / 60+。前两个各自有生成器且 `--check` 均通过，
  说明它们是**口径不同**而非漂移；`60+` 是手写且不受任何门禁保护。
- 影响：按 60+ 估算接口面会偏大；更重要的是，这句话本身断言「不会漂移」，
  却包含了一个未被门禁保护的手写数字，削弱了该保证的可信度。

### P2-1 两份 README 内容不对等（已修复，见 §11）

`README.md:251` 那一整段（34 条命令 / 21 个帧 / 60+ 路由 / 参考手册入口）在
`README.zh-CN.md` 中**不存在**（`grep -n "参考手册" README.zh-CN.md` 无输出）。
中文读者拿不到参考手册的入口。

### P2-2 `session-hub.ts` 单体 2169 行

仓库最大单文件。作者已把它作为公开指标写进 Numbers 表，自评文档也把「拆 `session-hub.ts`」
列为未处理项。拆分是可理解地被推迟的重构（它是热路径，且 `Conversation` / `SnapshotEmitter`
已经分出去），但它同时是编排、投影、上下文预算、会话树导航、看门狗的结合点，
任何一处修改都要在一个 2169 行的文件里定位。

### P2-3 分层倒置：组装/编排层依赖 HTTP 层

`src/agent.ts:68`、`src/session-hub.ts:29` import `./http/errors.js` 的 `badRequest` / `AppError`；
而 `src/app.ts:46` 又 type-only import `./session-hub.js`。当前无故障，但方向是反的。
建议方向（属重构，不是修复）：把错误原语下沉到独立模块（如 `src/errors.ts`），
`http/errors.ts` 只保留 HTTP 状态码映射。

---

## 9. 复核后判定「不构成问题」的几处

记录下来，避免下一轮重复劳动：

- **README Numbers 表与生成器一致**：实测 `npm run docs:numbers:check` 通过，
  Numbers 块内 7 个数字与源码一致（含「最大单文件 2169 行」）。散文里的数字不被保护，
  这是 P1-2 的**根因边界**，不是生成器失效。
- **44 与 55 的差异不是 bug**：前者是去重后的路由处理器数，后者是 `.get(`/`.post(`
  静态出现次数（含静态托管等）。两者都有各自生成器，只是对同一概念给出了不同数字，
  容易误读；建议统一口径或给指标改名。
- **覆盖率棘轮注释与阈值自洽**：`coverage.mjs:12` 的实测基线
  （lines 92.82 / branches 81.15 / functions 85.73）与 `:23` 的阈值（92/81/85）一致，
  属刻意的「略低于实测值」的棘轮设计。
- **`npm test` 与 README 用例数一致**：实测 470/470，与 Numbers 表完全对齐。

---

## 10. 结论与建议顺序

**结论**：这是一个工程纪律明显高于同类脚手架平均水准的项目——门禁真实（本次实测
470/470 全绿、`docs:check` 全绿）、fail-closed 原则贯穿读路径、契约单源、注释写的是
「为什么」。它的主要缺陷**不在代码，而在生成器覆盖不到的手写散文**：本次确认的两处
（P1-1、P1-2）恰好都是「文档声称的一件事与实现/生成物不符」，也正是作者反复声明
要消灭的那一类问题，在门禁边界之外复发。

**建议顺序**（第 1–3 条已在后续一轮执行完毕，见 §11；第 4 条是重构，未擅自做）：

1. 修 P1-1：`README.md:113` 改为「设置默认落盘到 `~/.pi/agent/pi-starter-settings.json`，
   重启保留；直接 `new SettingsService()` 才走内存端口」，并同步更正
   `docs/智能体视角评估.md` 里同一说法。
2. 修 P1-2：把 `README.md:251` 的 `60+` 换成参考手册的实际数字，或改为不带数字的表述
   （例如「完整的 REST 接口清单」），避免手写数字混进「不会漂移」的断言里。
3. 修 P2-1：把 `README.md:251` 那段的等价内容补进 `README.zh-CN.md`。
4. 视需要再做 P2-2（拆 `session-hub.ts`）与 P2-3（下沉错误原语）——两者都是重构，
   建议单独一轮、单独验证。

**本轮改动范围**：新增本报告 + `项目分析报告.md` 的入口清单一行（`README` 的 Numbers 块
因新增文档由生成器重算，`docs/*.md` 计数 8 → 9）；随后按 §11 修掉三处已确认的文档缺陷
及走查中新发现的同类缺陷。**未改动任何源码。**

---

## 11. 本轮修复记录

§8 的 P1-1 / P1-2 / P2-1 已修；P2-2 / P2-3 是重构，按「不擅自做未要求的重构」留待单独一轮确认。
修复全部落在文档层，源码未动。

| 条目 | 改了什么 | 落点 |
|---|---|---|
| P1-1 | 「设置仅内存、重启重置」改为「默认落盘到 `~/.pi/agent/pi-starter-settings.json`（原子写 + 损坏回落），`promptTemplate` / `disabledTools` 重启保留；只有库内直接 `new SettingsService()` 且不传 port 才是纯内存。`builtinKnowledge` / `builtinSkills` 在装配时读一次，改动需重启」 | `README.md:113` |
| P1-1（关联） | 在该文档既有的「我写错了 / 需要更正的（重要）」清单里补一条，讲清 §2.4 表格那句错在哪、正确边界是什么（正文按该文档自身「§2–§7 保留原样」的约定不动） | `docs/智能体视角评估.md` §0.1 |
| P1-2 | 删掉手写的 `60+ REST route handlers`，改为 `the complete REST route table`。`34 WS client commands` / `21 server frames` 经与生成的参考手册逐项核对一致，保留 | `README.md:251` |
| P2-1 | 补回缺失的整段（34 条命令 / 21 个帧 / 参考手册入口），并补齐探活表（`/health` liveness、`/health/ready` readiness 503、`/metrics`、`/info`）、加固头与 body 上限说明、`curl` 示例 | `README.zh-CN.md` HTTP 接口一节 |

走查过程中新发现、并在本轮一并修掉的同类缺陷：

| 新发现 | 事实 | 落点 |
|---|---|---|
| 中文 README 把 `/health` 描述成「当前模型、可用列表、技能 / 知识库目录、数据库探活、是否忙碌」 | 那是**拆分前** `/health` 的响应体，现在属于 `/info`（`src/app.ts:242-243` 注释写明 "superset of the old /health body"）。`/health` 现只返回 `{ ok, uptimeSeconds, nodeVersion, pid }`（`src/http/routes.ts:65-67`）。已更正正文与接口表两处，并补齐中文表缺失的 `/health/ready`、`/metrics`、`/info` 三行、删掉与英文版重复的 `/providers` 行 | `README.zh-CN.md` 正文 + 接口表 |
| 两份 README 都写「技能重启后会出现在 `GET /health` / `GET /skills`」 | `/health` 不返回技能目录，`/info` 与 `/skills` 才返回 | `README.md:484`、`README.zh-CN.md` 加技能一节 |
| 中文 README 的 `test:web` 注释写死「11 个 WS 客户端测试」 | 实际 19（Numbers 表也是 19）。改为不带数字，避免第二处手写计数 | `README.zh-CN.md` 自检命令一节 |
| 两份 README 的 `docs/` 目录树既不完整、又把归档页当现状（中文标「工程体检报告」） | 补上 `参考手册.md`（生成的）、`智能体视角评估.md`、本报告、`官方SDK接口文档.md`、`前端调研.md`、`assistant-ui.md`、`project_overview/`，并把 `项目分析报告.md` 标为「已归档快照（0.3.0 之前），仅供追溯」 | `README.md` / `README.zh-CN.md` 项目结构一节 |

复验：

| 命令 | 结果 |
|---|---|
| `npm run docs:check` | 一致：`README.md` / `README.zh-CN.md` / `docs/参考手册.md`（改动后复跑仍绿） |
| `npm run typecheck` / `npm run lint:unused` / `npm test` | 见本轮汇报（源码未动，跑一遍确认无连带影响） |
| `git diff --stat` | `README.md`、`README.zh-CN.md`、`docs/智能体视角评估.md`、`docs/项目分析报告.md` 四处；`docs/engineering-review.md` 为新增未跟踪文件 |

仍未处理：§8 P2-2（`session-hub.ts` 2169 行单体）与 P2-3（分层倒置）——两者都是重构，
需要单独一轮并单独验证；§9 记录的「44 / 55 口径不同」建议在需要对外报数字时统一口径或给指标改名。
