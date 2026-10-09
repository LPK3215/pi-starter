# web/ — pi-starter 前端

独立 npm 项目：Vite + React + TypeScript + [assistant-ui](https://www.assistant-ui.com)。
它和仓库根的后端**互不隶属**：各自的 `package.json`、`node_modules`、`tsconfig`，
后端的 `npm run verify` / Docker / npm 发布管道对它零感知。

## 怎么跑

开发（两个终端）：

```bash
# 终端 1：后端，默认 127.0.0.1:3000
npm run web                       # 在仓库根执行

# 终端 2：前端，:5173，/ws 代理到后端
npm run ui:dev                    # 在仓库根执行；等价于 cd web && npm run dev
```

生产（单进程）：

```bash
npm run ui:build   # 产出 web/dist
npm run web        # Express 直接把应用挂在 /，同源提供 /ws（staticDir 默认值 = web/dist）
```

嵌入别人服务时传 `createApp({ staticDir: false })`，自己挂前端。

## 目录里真正重要的只有两个文件

| 文件 | 职责 |
|---|---|
| `src/pi/client.ts` | WS 客户端。`hello`→`ready` 握手、`snapshot` / `snapshot_delta` 的 `rev`/`baseRev` 修订链与断链自愈、`message_delta` 流式缓冲、`tool_status`/`tool_delta` 聚合、退避重连 |
| `src/pi/usePiRuntime.ts` | 把后端快照翻译成 assistant-ui 的 `ExternalStoreAdapter`（含多对话 `adapters.threadList`） |

其余是 UI：当前用的是 **assistant-ui 官方 registry 组件**（`shadcn add @assistant-ui/thread @assistant-ui/thread-list`，base-nova 主题），
入口是 `src/components/assistant-ui/elements/thread.aui.tsx`；`src/components/thread.tsx` 是我最初手写的 primitives 版，
**保留作回退与对照**（在 `App.tsx` 改一行 import 就能切回）。`pi-panels.tsx` 两种 UI 下都在用：运行轨迹条、审批卡片、
HITL 反问弹窗、控制面、对话列表。

接官方组件时有两个必须知道的坑：它的落盘目录与文件内部 import 基准不一致，要按**每个文件自己的 import 行**归位（直接
搬到一个目录会得到一批 TS2307）；Base UI 的 Tooltip 必须有 Provider 祖先，所以 `App.tsx` 里包了一层 `TooltipProvider`。

**线协议不重复定义。** `tsconfig.app.json` 把仓库根的 `src/protocol.ts` 映射成 `@pi/protocol`，
前后端共用同一份类型；后端 `npm run typecheck` 会连带校验它。

## 为什么是 ExternalStoreRuntime

assistant-ui 接自定义后端有四条路，这里取 ExternalStore，因为**消息的权威状态在后端快照里**，
前端只做翻译与回调转发：

- `LocalRuntime` 会自己管消息状态，和后端的 snapshot / rollback / fork 语义打架；
- `DataStream` 与 `AssistantTransport` 都要求后端改吐它的线格式，违反"不改后端"。

## 已知边界（有意为之，不是遗漏）

- **审批与 HITL 反问不走官方 `toolApproval` / human tool**：那两条都要求工具调用以 tool-call part
  形式存在于消息里，而后端 `UiMessage` 只有 `role` / `text`。所以按官方对控制面的口径自绘。
- **工具轨迹是运行级的，且刷新后不保留**：后端快照不持久化工具历史，`tool_status` 只描述"这一刻哪
  个工具在跑"。多轮 ReAct 里工具恰好在两轮之间执行，那一刻流式尾消息是空的，所以做成独立轨迹条而
  不是只挂消息。
- **没接 `onEdit` / `onReload` / `setMessages`**（UI 的编辑 / 重生成 / 分支因此自动关闭）：后端
  `edit_message` 的语义是"回滚到该条 + 原文交回输入框、**不自动再发一轮**"，与 assistant-ui 期望的
  "编辑即新一轮"不等价，硬接会得到一条和后端会话树不一致的分支。
- **颜色 token 分工**：语义色板由 `src/index.css` 里 shadcn 官方主题（Nova / neutral）提供；Tailwind v4 的 `@theme` 后声明者胜，
  不要在本文件前面再写一份同名 token（会被默默覆盖）。只有 `--color-ok` / `--color-warning` 是官方表里没有的自定义状态色。
- **深浅色**：官方预设默认浅色，深色靠 `<html class="dark">` 切换，不会自动跟随系统。

## 一个别踩的代理坑

后端 `originAllowed`（`../src/transport/ws.ts`）要求 `Origin` 的 host 等于请求 `Host`。
给 Vite 代理加 `changeOrigin: true` 会把转发 Host 改成后端地址，于是**浏览器的握手被 403 拒掉，
而不带 `Origin` 的脚本客户端照样能连**——"脚本能连、浏览器不能连"的不对称现象就来自这里。
`vite.config.ts` 里刻意透传原始 Host。

## 链路自检

```bash
npm run dev &                 # 先起前端（或直接起后端 3000）
node scripts/probe-ws.mjs     # 默认连 ws://localhost:5173/ws，走 Vite 代理
PI_WS=ws://127.0.0.1:3000/ws node scripts/probe-ws.mjs   # 直连后端
```

它会真发一轮 prompt，打印帧序列、流式增量段数、逐条消息的角色与文本长度、以及后端 stats。
不依赖浏览器，改完适配层第一时间用它判断链路是否还通。
