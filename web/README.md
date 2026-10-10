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

其余是 UI：当前用的是 **assistant-ui 官方 registry 组件**（base-nova 主题），对话区
`src/components/assistant-ui/elements/thread.aui.tsx`、会话列表 `thread-list.aui.tsx`（含 New / 搜索 / 分组条目）；
`src/components/thread.tsx` 与 `pi-panels.tsx` 里的 `ConversationList` 是我最初手写的版本，
**保留作回退与对照**（在 `App.tsx` 改 import 就能切回）。`pi-panels.tsx` 仍在用：运行轨迹条、审批卡片、
HITL 反问弹窗、控制面。

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

- **审批与 HITL 反问自绘卡片**：官方 `toolApproval` / human tool 需要工具调用以带归属信息的
  tool-call part 挂在消息上，而后端快照只告诉客户端“哪个请求在等人类”，所以这两块自绘。
- **会话删除走 `delete_conversation`，不是 `close_conversation`**：close 会先 `rememberConversation`
  再 dispose，会话仍留在索引里，刷新后又是一条磁盘态条目；只有 delete 会连磁盘会话文件一起删。
  入口有两层：官方 `ThreadList` 的「…」菜单逐条 Rename / Archive / Delete，加上左侧底部的
  「批量管理」多选清理。当前会话不可选删（服务端本来就拒删最后一条），正在生成回复的会话也会被拒。
- **官方 Archive 菜单项被重定向到 close**：后端没有归档语义，而 ExternalStore 适配层缺 `onArchive`
  时 runtime 会直接 `throw new Error("... does not support archiving")`——不接上它，点一下就是一个未捕获异常。
- **思维链与工具调用随消息下发**：`UiMessage` 带 `thinking` / `calls`（含配对结果与耗时）/
  `stopReason`，历史重建是完整的——**刷新后官方 Reasoning / ToolGroup 仍渲染得出来**。
  `src/pi/client.ts` 里的 `tools` 只是事件帧的实时补位（本轮刚开始、带 toolCall 的那条消息
  还未落定的那一刻）。
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

## 与官方一致性校验（别靠眼看）

官方组件是**落盘源码**，会随上游更新，也会被 CLI 改写。两个脚本把“和官方一样”变成可验证命题：

```bash
npm run check:official        # 比对本地与 registry；只对**新增**偏离报错（退出 1）
npm run check:official:ci     # 同上，但拉不到 registry 时按跳过处理（退出 0）——给 CI 用
npm run sync:official         # 按 registry 声明的路径与内容原样重写（会把本地改动覆盖掉）
npm run check:official -- --write-baseline   # 认下当前这批偏离（须在 PR 里可见地提交）
```

为什么需要：`shadcn add` 会改写 import 路径并把文件平铺到 `src/components/`，实测第一次比对出 15 处差异
（包含一处 Base UI `render` 与官方 `asChild` 的组件风味差异）。

**为什么是"基线 + 只报新增"而不是"必须完全一致"**：上游 registry 是**实时**拉取的、没有版本号，
"与官方逐字节一致"不可能长期成立；而一个恒红的检查只会被排除出门禁，等于没人守。所以
`scripts/registry-baseline.json` 记下当前这批已知偏离（连同**本地内容哈希**），此后：

- 偏离没变 → 打印出来但不阻断；
- 偏离未登记、或登记过但本地内容又被改 → 判失败（这才是要人看的信号）；
- 拉不到 registry → 退出 2（网络故障，与"内容不一致"区分开）。

同步（`sync:official`）会把本地改动**覆盖**掉——包括我们有意做的适配；要保留本地改动就别同步，
而是把偏离登记进 baseline。shadcn 内置件（button/skeleton/tooltip 等）不属本 registry，不比对。

## 链路自检

```bash
npm run dev &                 # 先起前端（或直接起后端 3000）
npm run probe:ws              # 默认连 ws://localhost:5173/ws，走 Vite 代理
PI_WS=ws://127.0.0.1:3000/ws npm run probe:ws   # 直连后端
```

它会真发一轮 prompt，打印帧序列、流式增量段数、逐条消息的角色与文本长度、以及后端 stats。
不依赖浏览器，改完适配层第一时间用它判断链路是否还通。
