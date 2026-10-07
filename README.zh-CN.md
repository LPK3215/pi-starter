# π-starter

**中文** | [English](README.md)

基于 [pi-agent](https://github.com/earendil-works/pi) SDK 的 **Agent 脚手架**：拿到就能跑，往上加工具、加扩展、改人设，就变成一个垂直 Agent。

## 特性

- **双入口**：CLI（`npm run dev`）+ HTTP SSE（`npm run web`）。后端接口是产品；`public/index.html` 只是本地试接口的示例页
- **分层提示词**：`src/prompts/` 下 `persona.md`（人设）+ `rules.md`（规则），改文件即改性格
- **工具即插即用**：`src/tools/` 下定义，`tools/index.ts` 登记，自动注册进 Agent
- **技能管理**：`src/skills/<name>/SKILL.md`，走 SDK `DefaultResourceLoader.additionalSkillPaths`，目录由 `formatSkillsForPrompt` 注入，全文用内置 `read` 按 `<location>` 加载
- **知识库**：`src/knowledge/*.md`，系统提示词只放目录，正文由 `search_knowledge` / `read_knowledge` 按需取（SDK 没有原生知识库）
- **数据库**：Node 内置 `node:sqlite`，默认内存库 + 示例 `notes`；`GET /db` 探活，`db_query` 只读查询
- **扩展机制**：`src/extensions/` 下用 `pi.on()` 挂钩子。已带 `guard`（执行前拦截）和 `audit`（耗时日志）
- **一键写入 Pi 原生配置**：`npm run setup` merge 进 `~/.pi/agent/models.json` + `auth.json`，运行时不加兼容层
- **模型目录可配置、可切换**：`.env` 的 `PI_MODELS` 声明多个 provider 和模型，`PI_MODEL` 选默认；CLI 用 `/model`，HTTP 用 `POST /model`，都在当前会话里切换，不重建
- **内置工具默认关编码能力**：`off` 只开自定义工具 + `read`（技能加载需要它）；bash/edit/write 要显式打开
- **库导出**：`npm run build` 后可 `import { buildAgent, createApp } from "pi-starter"`，业务从参数注入，不必改脚手架源码

## 默认能力

脚手架默认是 **垂直 Agent 起点**，不是再包一层编码助手。clone 下来时：

| 有 | 没有（除非你打开） |
|---|---|
| `src/tools/` 里登记的自定义工具（现成示例：`current_time`） | SDK 内置 `bash` / `edit` / `write`（`off` 仍开 `read`，给技能用） |
| `src/skills/` 走 SDK `additionalSkillPaths`，全文用内置 `read` | 本机 `~/.pi/agent/skills`、Claude Code / Codex 技能目录 |
| `src/knowledge/` 知识库 + `search_knowledge` / `read_knowledge` | 向量库 / 外部 RAG |
| 内存 SQLite + `GET /db` / `db_query` | 远程 Postgres / 连接池（自己注入 `database`） |
| `persona.md` + `rules.md` 系统提示词 | `~/.pi/agent/extensions` 和 `<cwd>/.pi/extensions` 里的文件扩展 |
| `guard` 拦截危险 bash、路径越出 cwd（`read SKILL.md` 例外） | 完整沙箱 / 容器隔离 |
| `audit` 打印工具耗时 | 登录、多用户会话、公网暴露 |
| CLI 落盘会话；HTTP 内存会话、单用户防并发 | |

打开内置工具（优先级：命令行 > `.env` > 默认 `off`）：

```bash
# .env
PI_BUILTIN_TOOLS=off        # 默认：自定义工具 + read（技能加载）
# PI_BUILTIN_TOOLS=readonly # 再加上 grep / find / ls
# PI_BUILTIN_TOOLS=coding   # 再加上 bash / edit / write

# 或临时覆盖
npm run dev -- --builtin-tools coding
```

`readonly` / `coding` 走 SDK allowlist，自定义工具名会自动并进去。工具必须出现在 `src/tools/index.ts` 或 `buildAgent({ extraTools })` 里；只在扩展里 `pi.registerTool` 的名字不会自动放行。

打开 `coding` 之后，`guard` 才会真正拦到 bash / write：危险命令（如 `rm -rf`）和越出工作目录的路径会被 `{ block: true }`。改规则去 `src/extensions/guard.ts`。

## 快速开始

### 0. 前置条件

- Node.js ≥ 22.19
- 一个 ModelScope token（或你要换成的其他 OpenAI 兼容供应商的 Key）

### 1. 安装并写入 Pi 配置

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
# 编辑 .env，填 PI_API_KEY
npm run setup
```

`setup` 会 **merge**（不覆盖其他 provider）写入 Pi 原生路径：

- `~/.pi/agent/models.json` — ModelScope 的 `baseUrl` + 模型 id
- `~/.pi/agent/auth.json` — `{ "modelscope": { "type": "api_key", "key": "..." } }`（文件 mode 0o600）

已有该 provider 的密钥默认保留。覆盖才加 `--force`：

```bash
npm run setup -- --force
```

运行时仍由 SDK 读这两个文件，项目里的 `PI_API_KEY` 只给 setup 用，不会在请求路径上再套一层。

`.env` 里要有默认模型，两种写法：

```bash
PI_MODEL=modelscope/Qwen/Qwen3-Next-80B-A3B-Instruct
# 或分开写（模型 id 自带斜杠时，斜杠原样保留，不会被当成 provider）
PI_PROVIDER=modelscope
PI_MODEL=Qwen/Qwen3-Next-80B-A3B-Instruct
```

缺了会直接抛，**不会**落到 SDK 内置 huggingface。

多个模型写 `PI_MODELS`，一条一个 provider，模型用逗号，显示名用冒号：

```bash
PI_MODELS=modelscope|https://api-inference.modelscope.cn/v1|openai-completions|Qwen/Qwen3-Next-80B-A3B-Instruct:Qwen3-Next-80B,Qwen/Qwen2.5-72B-Instruct;zhipu|https://open.bigmodel.cn/api/paas/v4|openai-completions|glm-4.5-air:GLM-4.5-Air
```

不写 `PI_MODELS` 时，setup 只用上面那一条，地址走 `PI_BASE_URL`。

优先级：**命令行 `--model` / `--provider` > `.env`**。没有第三档「SDK 自选」。

密钥按 provider 分：默认 provider 用 `PI_API_KEY`，其余用 `PI_API_KEY_<PROVIDER>`（大写，如 `PI_API_KEY_ZHIPU`）。默认模型所在的 provider 没有密钥会直接失败；其他 provider 缺密钥只跳过并提示。

手写 `~/.pi/agent/` 也可以，格式：

```json
{
  "providers": {
    "modelscope": {
      "baseUrl": "https://api-inference.modelscope.cn/v1",
      "api": "openai-completions",
      "models": [
        { "id": "Qwen/Qwen3-Next-80B-A3B-Instruct", "name": "Qwen3-Next-80B" }
      ]
    }
  }
}
```

```json
{
  "modelscope": { "type": "api_key", "key": "ms-你的Key" }
}
```

- `api`：国内厂商 / OpenAI 兼容用 `openai-completions`，Anthropic 用 `anthropic-messages`
- `baseUrl` **只填到 `/v1`**，别带 `/chat/completions`

### 2. CLI 对话

```bash
npm run dev
# 临时换默认模型：
npm run dev -- --model zhipu/glm-4.5-air
# 会话中切换（不发给模型）：
#   /models
#   /model modelscope/Qwen/Qwen2.5-72B-Instruct
```

### 3. HTTP 接口（后端）

```bash
npm run web
# 默认 http://localhost:3000
```

`public/index.html` 只是本地试接口的示例页，不是产品前端。嵌进已有服务时用 `createApp({ staticDir: false })`，自己挂页面。

`GET /health` 返回当前模型、可用模型列表、技能 / 知识库目录、数据库探活、内置工具档位、是否忙碌。

不调模型也能测资源（虚拟 / 示例数据即可）：

```bash
curl http://localhost:3000/skills
curl http://localhost:3000/skills/summarize
curl http://localhost:3000/knowledge/search?q=切换模型
curl http://localhost:3000/knowledge/about
curl http://localhost:3000/db
curl http://localhost:3000/db/notes
curl -X POST http://localhost:3000/db/query -H "content-type: application/json" -d "{\"sql\":\"SELECT title FROM notes\"}"
```

`POST /model` 切换当前会话的模型，不重建会话：

```json
{ "model": "zhipu/glm-4.5-air" }
```

`POST /chat` 对外暴露的 SSE 接口协议（任何语言可调）：

| 事件 type | data | 含义 |
|---|---|---|
| `text` | `{delta}` | 回答的一段文字 |
| `thinking` | `{delta}` | 思考的一段 |
| `tool_start` | `{id,name,args}` | 工具开始执行 |
| `tool_end` | `{id,name,result,isError}` | 工具执行结束 |
| `done` | `{}` | 彻底结束 |
| `error` | `{message}` | 出错 |

## 项目结构

```
pi-starter/
├── src/
│   ├── index.ts          # CLI 入口（交互对话）
│   ├── server.ts         # Web 入口：解析命令行、listen
│   ├── app.ts            # ★ HTTP 应用：/health /skills /knowledge /db /model /chat
│   ├── lib.ts            # 库导出（buildAgent / createApp / setup）
│   ├── setup.ts          # npm run setup：merge 写入 ~/.pi/agent/
│   ├── agent.ts          # ★ 组装层：模型 + 人设 + 工具 + 扩展 → session
│   ├── config.ts         # 配置层：命令行 / .env / 内置工具档位
│   ├── cli-args.ts       # 命令行 flag 解析（CLI / Web 共用）
│   ├── sse.ts            # Agent 事件 → SSE 协议
│   ├── prompts/          # 分层提示词（改这里 = 改 Agent 性格）
│   │   ├── persona.md    #   人设：你是谁、你怎么回答
│   │   └── rules.md      #   规则：工作约束
│   ├── tools/            # 工具层：给 LLM 装「手」
│   │   ├── index.ts      #   ★ 静态工具登记入口
│   │   ├── current-time.ts
│   │   ├── knowledge.ts  #   检索 / 读知识库
│   │   └── database.ts   #   db_status / db_query
│   ├── skills/           # 技能：<name>/SKILL.md，SDK additionalSkillPaths
│   │   ├── index.ts
│   │   └── summarize/SKILL.md
│   ├── knowledge/        # 知识库：*.md，扫描加载
│   │   ├── index.ts
│   │   └── about.md
│   ├── db/               # 数据库：node:sqlite，默认内存 + 示例 notes
│   │   └── index.ts
│   └── extensions/       # 扩展层：在 Agent 干活环节挂钩子
│       ├── index.ts      #   ★ 登记入口
│       ├── guard.ts      #   示例：tool_call 拦截（危险 bash / 路径越界）
│       └── audit.ts      #   示例：工具调用审计日志
└── public/
    └── index.html        # 示例对话页（试接口用，不是产品前端）
```

契约类冒烟测试（不调模型、不写真实 `~/.pi/agent`）：

```bash
npm test
npm run typecheck
npm run build
```

## 二次开发：业务从接口进来

脚手架负责组装、模型、闸门、HTTP。业务（工具、人设、页面、登录）从外面接，不要改 `node_modules/@earendil-works`。

两种接法：

1. **改这个仓库**：人设改 `src/prompts/`，工具登记进 `src/tools/index.ts`，技能丢进 `src/skills/`，知识库丢进 `src/knowledge/`，扩展登记进 `src/extensions/index.ts`。
2. **当库用**：`npm run build` 后 `import { buildAgent, createApp } from "pi-starter"`，通过参数注入，本仓库保持干净。

```ts
import { buildAgent, createApp } from "pi-starter";

const agent = await buildAgent({
  systemPrompt: "你是客服助手……",
  extraTools: [myTool],
  extraExtensions: [myExtension],
  extraSkillPaths: ["./skills"],
  extraKnowledgeDirs: ["./docs"],
  databasePath: ":memory:",
  inMemory: true,
});
const { app, dispose } = createApp({ agent, staticDir: false });
// 把 app 挂到已有 Express；登录、多用户、前端自己包
```

`extraExtensions` 排在内置 `guard` / `audit` 后面。`createApp({ staticDir: false })` 只暴露接口，前端自己接。技能和知识库同名时仓库内置优先。

### 加一个工具

```ts
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const myTool = defineTool({
  name: "my_tool",
  label: "我的工具",
  description: "一句话说明这个工具能干什么（LLM 靠它决定什么时候调）",
  parameters: Type.Object({
    query: Type.String({ description: "参数说明" }),
  }),
  async execute(_id, params: { query: string }) {
    return { content: [{ type: "text", text: `结果是：${params.query}` }], details: {} };
  },
});
```

仓库内开发：登记进 `src/tools/index.ts` 的 `allTools`。当库用：传给 `buildAgent({ extraTools: [myTool] })`。`readonly` / `coding` 档位会把这些名字并进 SDK allowlist。

### 加一个扩展

仓库里已有可运行的拦截示例：`src/extensions/guard.ts`。新扩展照抄那个文件的结构。

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function myExtension(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName === "dangerous_tool") {
      return { block: true, reason: "禁止调用该工具" };
    }
    return undefined;
  });
}
```

仓库内开发：登记进 `src/extensions/index.ts` 的 `allExtensions`。当库用：传给 `buildAgent({ extraExtensions: [myExtension] })`。

### 加一个技能

技能是带 YAML frontmatter 的 `SKILL.md`（[Agent Skills](https://agentskills.io/specification)）。加载走 SDK：`noSkills: true` 关掉本机 `~/.pi` 扫描，`additionalSkillPaths` 只加载仓库 / 你注入的目录。SDK 在系统提示词里写 `<available_skills>`（含 `<location>`），模型用内置 `read` 读全文。

```
src/skills/refund/SKILL.md
```

```md
---
name: refund
description: 处理退款申请。用户说退款、退货、取消订单时使用。
---

# 退款流程

1. 先问订单号
2. 调业务工具查状态
3. 按规则决定是否可退
```

重启后会出现在 `GET /health` / `GET /skills`。模型匹配 description 后会 `read` `<location>` 指向的 SKILL.md。当库用：`buildAgent({ extraSkillPaths: ["/path/to/skills"] })`。

默认不扫 `~/.pi/agent/skills`。`off` 档会打开 `read`（技能加载需要它），但不打开 bash/edit/write。`guard` 对越出 cwd 的路径默认拦截，但放行 `read` SKILL.md。

### 加一篇知识库

```
src/knowledge/pricing.md
```

```md
---
title: 价格表
description: 套餐、单价、计费周期
---

基础版 99 / 月，专业版 299 / 月。
```

重启即可。模型先 `search_knowledge({ query: "专业版多少钱" })`，再 `read_knowledge({ name: "pricing" })`。当库用：`buildAgent({ extraKnowledgeDirs: ["/path/to/docs"] })`。

这是进程内 Markdown 检索，不是向量库。要接 RAG 就自己写工具，登记进 `extraTools`。

### 接一个数据库

SDK 没有原生数据库。脚手架用 Node 22 的 `node:sqlite`，默认 `:memory:`，启动写入两条 `notes`。`GET /db` 探活，`POST /db/query` 只跑 SELECT。Agent 侧工具是 `db_status` / `db_query`。

```ts
const agent = await buildAgent({
  databasePath: "./data/app.db", // 或 PI_DATABASE_PATH
});
```

换实现：实现 `DatabaseStore`，传 `buildAgent({ database: myStore })`。HTTP 和工具只依赖这个接口。

测试不调模型：

```bash
curl http://localhost:3000/db
curl http://localhost:3000/db/notes
curl -X POST http://localhost:3000/db/query \
  -H "content-type: application/json" \
  -d '{"sql":"SELECT id, title FROM notes"}'
```

### 常用 `pi.on` 事件

| 事件 | 时机 | 能力 |
|---|---|---|
| `tool_call` | 工具执行前 | 拦截 / 改参数 |
| `tool_result` | 工具执行后 | 改返回内容 |
| `context` | 发 LLM 前 | 注入消息（如用户偏好） |
| `input` | 收到用户输入后 | 改写 / 拦截输入 |
| `before_agent_start` | 开跑前 | 改系统提示词 |
| `agent_settled` | 一次 prompt 跑完 | 可靠结束信号 |

完整事件菜单见 pi-agent SDK 上游仓库。

### 接进现有模块 / 自己做前端

后端接口如下。页面以后再生成，现在不要改脚手架里的 HTML。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 当前模型、可用列表、技能 / 知识库目录、数据库探活、是否忙碌 |
| GET | `/skills` | 技能目录（不调模型） |
| GET | `/skills/:name` | 读 SKILL.md 全文 |
| GET | `/knowledge` | 知识库目录 |
| GET | `/knowledge/search?q=` | 关键词检索 |
| GET | `/knowledge/:name` | 读文档全文 |
| GET | `/db` | sqlite 探活 |
| GET | `/db/notes` | 示例表 |
| POST | `/db/query` | `{ "sql": "SELECT …" }`，只读 |
| POST | `/model` | `{ "model": "provider/modelId" }`，当前会话切换 |
| POST | `/chat` | `{ "message": "..." }`，响应是 SSE 流 |

嵌进已有 Express 时用 `createApp({ agent, staticDir: false })`，不要再开一个端口。登录用现有鉴权包一层。

## 功能边界

脚手架做完这些，其余留给业务：

| 做了 | 刻意不做 |
|---|---|
| 模型目录、启动选模型、运行中切换 | 登录 / 用户体系。本地工具不需要；接到现有系统时用现有鉴权包一层 |
| CLI + HTTP 共用 `buildAgent` | 多用户、多会话。现在一个进程一个 session，并发第二轮返回 429 |
| 仓库内技能走 SDK ResourceLoader；知识库 Markdown 检索；sqlite 探活 + 只读查询 | 向量库、外部 RAG、扫本机 `~/.pi/agent/skills` |
| `guard` 拦危险 bash 和越出 cwd 的路径 | 沙箱。正则挡不住命令替换、编码绕过、symlink。要隔离用容器 |
| `noExtensions` / `noSkills`，不扫本机扩展和技能 | 公网暴露。默认监听所有网卡，没有鉴权 |
| 默认 `PI_BUILTIN_TOOLS=off` | 打开 `coding` 等于把改磁盘、跑 shell 交给模型 |

为什么默认关编码工具、仍开 `read`：SDK 的 `createAgentSession()` 不传 `tools` 时会打开 `read` / `bash` / `edit` / `write`。脚手架是垂直 Agent 起点，所以 bash/edit/write 必须显式打开。但 SDK 只有在 `selectedTools` 含 `read` 时才把技能目录写进系统提示词，模型也用 `read` 加载 SKILL.md——这是官方路径，不另包 `read_skill`。

为什么不加载本机扩展和技能：用户机器上的 pi 扩展 / 技能可能再次注册 bash/write，或把不相干的工作流塞进这个垂直 Agent。

`guard` 不是沙箱。规则在 `src/extensions/guard.ts`，按业务改 `DANGEROUS_BASH_RULES`。

## 进阶（业务自己决定）

- **登录**：本地桌面 / 本机 CLI 可以没有。接到已有后台时，在 `createApp()` 外面加中间件，不要改脚手架。
- **多用户**：每个用户一个 `buildAgent()` + 独立 session；不要共用现在这个 `busy` 标志。
- **打开编码工具**：`PI_BUILTIN_TOOLS=coding` 或 `--builtin-tools coding`。打开后 `guard` 仍会拦截危险 bash 和越出 cwd 的路径。
- **模型切换**：启动时 `--model provider/modelId`；CLI `/model`；HTTP `POST /model`。只接受已配好 Key 的模型，走 `session.setModel`，不重建会话。
- **技能 / 知识库 / 数据库**：技能丢进 `src/skills/`；知识库丢进 `src/knowledge/`；数据库默认内存，或 `PI_DATABASE_PATH` / `buildAgent({ database })`。要接向量库或远程 SQL，写成工具从 `extraTools` 进来。

## 许可

基于 [MIT License](LICENSE) 发布。
