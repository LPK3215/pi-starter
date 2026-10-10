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

---

## 12. 现状校正（2026-10-10 第二轮，基线 commit `e0c4539`）

§8 / §9 / §11 写的部分条目在本报告落盘之后已随 `e0c4539` 等提交**失效**，这一节把它们
按当前源码改对，避免本报告自身变成下一个「过期结论」。改的只是判断，不删历史。

| 原条目 | 原结论 | 现状（已实测） |
|---|---|---|
| §1 / §2 / §8 P2-2 / §11 | `src/session-hub.ts` 2169 行，仓库最大单文件 | **已拆分**：现 **492 行**（`wc -l src/session-hub.ts`）。拆出的 `src/conversation/{conversation.ts,messages.ts}` 在文件头注明了职责边界。§8 P2-2 的「单体」判断已不成立 |
| §8 P2-3 / §11 | 分层倒置：编排层 import `./http/errors.js` | **已修**：错误原语下沉到 `src/errors.ts`，`src/http/errors.ts` 只留 Express 中间件（`errorHandler`）。实测 `src/agent.ts` / `src/session-hub.ts` / `src/app.ts` 等改从 `./errors.js` 取原语，方向回到「外层依赖内层」 |
| §9 | 「44 / 55 两个路由口径」 | 仍在（生成器按 method+path 去重 vs 按 `.get(`/`.post(` 计数）。**不是 bug**，但对外报数字时应只取一个口径并给指标改名 |
| §11 P1-1（关联） | 只在 `智能体视角评估.md` 的「我写错了」清单里补正，正文 §2.4 表格按「保留原样」不动 | 该「既有错误结论、又有它的更正」的状态**已就地改掉**：§2.4 表格那一行与 §5 第 15 条的下游引用都改成了正确边界 |
| §11 「中文 README 把 `/health` 描述成数据库探活」 | 记为已改正文与接口表两处，另称 `README.zh-CN.md:79` / `:96` 是漏掉的**第三处** | **第三处不存在**（本轮复核结论，属于原判断有误）：`:79` / `:96` 写的是 `GET /db` 探活，主语是数据库端点而不是 `/health`，与英文版 `README.md:80` 的 `GET /db` for liveness 表述一致，**无需改动**；`/health` 的两处表格行此前已改对（`README.zh-CN.md:249`、`:559`） |

补记这一轮新确认并修掉的问题（不在本报告前文的范围里）：

| 新发现 | 事实 | 落点 |
|---|---|---|
| 远端 frontend 作业的 audit 恒红，本地完全看不见 | `web/` 的依赖链里有一条**无可用修复**的高危通告（`braces` 的 GHSA-vfj7-8cjw-p6xm，经由 `shadcn -> fast-glob -> micromatch -> braces`）。裸 `npm audit` 建议的 `npm audit fix --force` 会把 `shadcn` 降到 1.0.0（breaking change）且换不来修复——`braces` 最新版本就是受影响的 3.0.3。而 `.cnb.yml` 的 audit 只在远端跑，`npm run verify` 里没有审计步骤，于是「本地绿 ≠ 远端绿」 | 见下 |
| `shadcn` 是**运行时 CSS 源**，不是纯 CLI | `src/index.css` 第 3 行 `@import "shadcn/tailwind.css"`，Tailwind v4 在**编译 CSS 时**解析它（自定义变体 `data-open` / `data-closed` 等只在这里定义，实测产物 CSS 里存在）。同时 `check:official` 又把 `shadcn` 当 CLI 调。所以它既不是纯运行时依赖、也不是纯开发依赖——但产物已内联进 `web/dist`，**构建期依赖**才是它的准确归类 | `web/package.json`：`shadcn` 从 `dependencies` 移到 `devDependencies`（构建阶段 `npm ci --prefix web` 与 Dockerfile 的 web-builder 都装全量依赖，不受影响） |
| 依赖审计缺一个「只对新增报错」的闸门 | 恒红的闸门等于没有闸门。改为与 `check-registry-sync.mjs` 同款的**基线化**门禁 | 新增 `web/scripts/check-audit.mjs` + `web/scripts/audit-baseline.json`：生产依赖（`--omit=dev`）必须 0 高危（硬门）；开发依赖里的已知通告登记后放过、只对**新增**或**影响范围变化**报错 |
| `npm run verify` 与远端门禁口径不一致 | 远端有审计步骤、本地没有——这个不对称本身就是隐患 | 新增 `scripts/verify-audit.mjs`（根包 + `web/` 两段审计，缺 `web/node_modules` 时明确 SKIP），并接进 `npm run verify` |

---

## 13. 第三轮：并发下的会话容量（2026-10-10，基线 commit `05ad53b`）

本轮不改文档判断，只记一条**在生产代码里实测到**的缺陷与它的修法。走查方式与前两轮一致：
读源码 → 写一个只替换 SDK 边界的驱动 → 用真身代码量出数字。

### 13.1 症状与根因

`ClientSession.addConversation()` 在「收容量」与「入册」之间有一个 `await`
（会话工厂要建 loader 与 AgentSession）。旧实现是「分配前收一次，分配后再补收一次」：

```
this.evictForCapacity();                 // 分配前
const session = await factory(...);      // ← 并发的调用在这里交错
this.evictForCapacity();                 // 「补收一次」
...
this.convs.set(conv.id, conv);           // 新会话到这里才入册
```

第二处 `evictForCapacity()` 跑在 `convs.set()` **之前**。它只遍历 `this.convs`，而本次
刚 `await` 出来的会话还不在其中——补收收得掉旧的，收不掉刚分配的这个。并发的多个
`new_conversation`（WS 的 `dispatch` 是并行的：`void this.dispatch(msg)`，
`src/transport/ws.ts:328`）各自看到同一个 `convs.size`、各自通过检查，于是每个都在
上限之外多分配一个完整 AgentSession。

旧实现的那句注释其实已经写到了症状（「把 size 抬到 cap+1」），但结论写成了「补收一次
确保上限是真正的上限」——补收没起到这个作用。

### 13.2 实测（驱动真身 `ClientSession`，只在 session 工厂与 push 出口注入替身）

度量的是「已分配但尚未 `dispose()` 的 session 数」的**峰值**：

| cap | 并发请求数 | 工厂延迟 | 原实现峰值存活 | 修复后峰值存活 |
|---|---|---|---|---|
| 4 | 64 | 5 ms | **5** | 4 |
| 4 | 64 | 50 ms | **5** | 4 |
| 8 | 200 | 30 ms | **9** | 8 |
| 2 | 32 | 100 ms | **3** | 2 |

超出量恒为 **+1**，不是无界增长（后续调用会回收更早的那些）。但「上限」在那个时刻是
假的，而每个 AgentSession 都带一整套 loader 与事件订阅；把工厂延迟调大或并发调高都
不会让它变成 +2，所以它的性质是「稳态被短暂突破」而不是「无界泄漏」——
这一点我第一轮汇报时说重了（当时写成「永久泄漏」），此处按实测改回准确表述。

### 13.3 修法

把「占名额」改成**同步判定 + 排队等待**的准入，并把在途计入占用：

- `inFlight`：已拿到名额、但还在 `await` 分配中的会话数。容量判定看
  `convs.size + inFlight`（真实占用），不再只看 `convs.size`。
- `acquireSlot()`：取不到名额就挂在 `slotWaiters` 里等；被唤醒后**重新判定**
  （`while` 而不是 `if`，因为名额可能被更早被唤醒的抢走）。
- `releaseSlot()`：归还名额后广播唤醒**全部**等待者。一次只唤醒队首会有一个坏路径——
  队首被唤醒后发现名额被抢走、重新排队，而它身后的人再也没人叫。广播 + 每个等待者
  自己重试，从结构上不存在丢名额的分支。
- 分配失败（工厂抛错）同样归还名额，否则失败调用会永久吃掉一个容量位。

### 13.4 验证

| 验证 | 结果 |
|---|---|
| 并发/应力（cap 4/8/2，请求 32–200，工厂延迟 5–100 ms） | 存活 session 峰值全部 `<= cap`（修复前为 `cap+1`） |
| 无死锁（10 个并发请求，cap 3） | 全部完成，无请求挂住 |
| 失败路径（连续 6 次工厂抛错后） | 名额全部归还，后续 4 个并发仍能成功 |
| 仓库回归 `src/integration.test.ts` 新增一条 | 修复前 **fail**（峰值 4 > 上限 3），修复后 pass |
| `npm run verify` | EXIT 0（491 后端 / 19 前端 / 23 冒烟 / 8 嵌入断言） |
| `npm run test:coverage` | EXIT 0（lines 92.95 / branches 81.36 / functions 86.05，较上轮均上升） |
| `npm run e2e` | EXIT 0（47 通过 / 0 跳过 / 0 失败） |
| `npm run docs:check` | 一致（README.md / README.zh-CN.md / docs/参考手册.md，数字已重新生成） |
| `npm --prefix web run lint` / `check:audit:ci` / `check:official:ci` | 均 EXIT 0 |

### 13.5 仍然不做的

- **不做「拒绝而非淘汰」的语义变更**：`evictForCapacity()` 的「淘汰最久未活动而不是
  报错」是刻意的（客户端开新对话时给错误比悄悄退休一个冷对话更糟），本轮只修准入，
  不动这个取舍。
- **不给 `ClientSession` 加通用互斥队列**：只有这一处存在跨 `await` 的容量竞争，
  为它引入一把全类互斥会把 `newConversation` 的并行度也一起收掉，代价不对等。
