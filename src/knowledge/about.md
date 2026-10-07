---
title: 关于本脚手架
description: pi-starter 是什么、默认能力、怎么扩展工具 / 技能 / 知识库
---

# π-starter

基于 pi-agent SDK 的 Agent 脚手架。默认是垂直 Agent 起点，不是再包一层编码助手。

## 默认有什么

- 自定义工具：`src/tools/` 登记，示例 `current_time`
- 技能：`src/skills/<name>/SKILL.md`，SDK `additionalSkillPaths` 加载，全文用内置 `read`
- 知识库：`src/knowledge/*.md`，按需 `search_knowledge` / `read_knowledge`
- 数据库：默认内存 SQLite，`GET /db` 探活，`db_query` 只读查询
- 扩展：`guard` 拦危险 bash 和越出 cwd 的路径，`audit` 打工具耗时
- 模型：`.env` 的 `PI_MODELS` 声明目录，运行中可切换，不重建会话
- HTTP：`GET /health`、`GET /skills`、`GET /knowledge`、`GET /db`、`POST /model`、`POST /chat`（SSE）

## 默认没有什么

- 不打开 SDK 的 bash / edit / write（`PI_BUILTIN_TOOLS=off`）
- 不扫本机 `~/.pi/agent/extensions` 和 `~/.pi/agent/skills`
- 不内置登录、多用户、沙箱

## 怎么加东西

- 工具：`src/tools/` 新建文件，登记进 `src/tools/index.ts`
- 技能：`src/skills/<name>/SKILL.md`
- 知识库：`src/knowledge/<name>.md`
- 扩展：`src/extensions/` 新建文件，登记进 `src/extensions/index.ts`
- 当库用：`buildAgent({ extraTools, extraExtensions, extraSkillPaths, extraKnowledgeDirs, database })`，再 `createApp({ agent, staticDir: false })`
