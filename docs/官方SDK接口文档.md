# 官方 Pi SDK 完整接口与能力全景文档

> **基准版本**：
> - `@earendil-works/pi-coding-agent@0.83.0`
> - `@earendil-works/pi-agent-core@0.83.0`
> - `@earendil-works/pi-ai@0.83.0`
>
> 本文档基于官方 npm 包的 TypeScript 类型定义（`dist/index.d.ts`）、底层源码实现、官方技术文档（`docs/*.md`）、官方示例（`examples/sdk/01-13`、`examples/extensions/`）以及开源社区深度实践总结**全量整理**。
> 涵盖架构设计理念、源码级生命周期状态机、所有一等公民 API/参数、扩展拦截机制、以及垂直智能体落地的关键裁剪策略。

---

## 目录

1. [SDK 架构体系与分层抽象](#1-sdk-架构体系与分层抽象)
   - 1.1 三层包结构与依赖倒置
   - 1.2 工具三层抽象演进（Tool → AgentTool → ToolDefinition）
   - 1.3 Agent Loop 运行机制与核心时序（Trace vs Turn）
2. [顶级创建方式与运行时工厂（Core Factories）](#2-顶级创建方式与运行时工厂core-factories)
   - 2.1 轻量单会话模式：createAgentSession
   - 2.2 跨工作区完整运行时：createAgentSessionRuntime
3. [AgentSession 核心实例接口](#3-agentsession-核心实例接口)
   - 3.1 会话门面全量方法与属性
   - 3.2 PromptOptions 选项与 preflightResult 预检通知
   - 3.3 官方事件体系（AgentSessionEvent）全集
4. [AgentSessionRuntime 多会话与进程状态管理](#4-agentsessionruntime-多会话与进程状态管理)
5. [ModelRuntime 与凭据认证系统](#5-modelruntime-与凭据认证系统)
   - 5.1 运行时模型管理与鉴权探测
   - 5.2 凭据解析四级优先级与存储格式
6. [ResourceLoader 与系统提示词 5 段拼装机制](#6-resourceloader-与系统提示词-5-段拼装机制)
   - 6.1 DefaultResourceLoader 配置与覆盖钩子
   - 6.2 buildSystemPrompt 源码级五段拼装流水线
   - 6.3 垂直智能体的提示词隔离原则
7. [SettingsManager 配置管理体系](#7-settingsmanager-配置管理体系)
8. [SessionManager、JSONL 存储与会话树导航](#8-sessionmanagerjsonl-存储与会话树导航)
   - 8.1 会话树与 DAG 分支结构
   - 8.2 JSONL Entry 数据格式规范全集
   - 8.3 navigateTree 树导航与分支摘要生成
9. [官方工具系统与自定义工具规范](#9-官方工具系统与自定义工具规范)
   - 9.1 7 个内置工具能力与构造函数
   - 9.2 工具执行五步管道（Pipeline）
   - 9.3 defineTool 自定义规范与 5 个 execute 参数
10. [扩展系统（Extensions）与生命周期钩子全集](#10-扩展系统extensions与生命周期钩子全集)
    - 10.1 两阶段绑定架构（Throwing Stubs + bindCore）
    - 10.2 四种扩展介入模式（通知 / 取消 / 修改 / 短路阻断）
    - 10.3 40+ 官方事件钩子全览
11. [上下文压缩（Compaction）与 Token 预算工程](#11-上下文压缩compaction与-token-预算工程)
    - 11.1 压缩时序契机：两轮对话之间
    - 11.2 压缩算法：切割点（CutPoint）与结构化摘要
    - 11.3 官方 chars/4 估算机制与中文低估偏差分析
12. [技能（Skills）、提示词模板与 AGENTS.md 规范](#12-技能skills提示词模板与-agentsmd-规范)
13. [程序化通信模式与宿主选型路径](#13-程序化通信模式与宿主选型路径)
    - 13.1 三档宿主集成路径（进程内 SDK vs 结构化 RPC vs 文本投影）
    - 13.2 官方 RPC Mode 协议与 RpcClient
    - 13.3 JSON Event Stream 模式与全局 EventBus
14. [官方 SDK 标准示例（Examples 01–13）范式总览](#14-官方-sdk-标准示例examples-0113范式总览)
15. [官方能力全景对照检查表（Checklist）](#15-官方能力全景对照检查表checklist)
16. [双轨教程章节系统对照视角（冬瓜 / dgzhuya 教程全景）](#16-双轨教程章节系统对照视角冬瓜--dgzhuya-教程全景)
    - 16.1 实战上手篇（P01–P07 逐章模型与落地业务）
    - 16.2 源码精读篇（M01–M11 逐章原理解析与架构图解）
17. [第三方生态与生产级 Web UI 视角（pi-web-ui 对照）](#17-第三方生态与生产级-web-ui-视角pi-web-ui-对照)
    - 17.1 pi-web-ui 架构剖析（pi 世界的 Yuxi）
    - 17.2 插件体系（plugin-sdk）与原生扩展双轨机制
    - 17.3 垂直脚手架（pi-starter）与完整驾驶舱（pi-web-ui）的定位取舍

---

## 1. SDK 架构体系与分层抽象

### 1.1 三层包结构与依赖倒置

官方 Pi SDK 由三层 npm 包构成清晰的依赖倒置架构：

```
┌────────────────────────────────────────────────────────┐
│             @earendil-works/pi-coding-agent             │
│  · 编码智能体生命周期 (AgentSession, AgentSessionRuntime) │
│  · 资源装载 (DefaultResourceLoader: 技能/提示词/扩展)     │
│  · 内置工具集 (read, bash, edit, write, grep, find, ls) │
│  · 会话管理与树导航 (SessionManager, navigateTree)       │
│  · 扩展系统 (ExtensionAPI, 40+ 生命周期钩子)           │
│  · 通信与运行模式 (RPC 模式, JSONL 事件流, TUI 模式)    │
└──────────────────────────┬─────────────────────────────┘
                           │ 依赖
┌──────────────────────────▼─────────────────────────────┐
│               @earendil-works/pi-agent-core             │
│  · LLM Agent 核心状态机 (Agent, AgentLoop, AgentState)  │
│  · 核心事件总线与消息流 (AgentSessionEvent, streamFn)   │
│  · 系统提示词组装 (buildSystemPrompt)                   │
│  · 核心上下文压缩算法 (compact, findCutPoint)            │
│  · 基础存储抽象 (SessionStorage, JsonlRepo, MemoryRepo) │
└──────────────────────────┬─────────────────────────────┘
                           │ 依赖
┌──────────────────────────▼─────────────────────────────┐
│                   @earendil-works/pi-ai                 │
│  · 多 Provider 统一抽象 (Anthropic, OpenAI, Google 等)   │
│  · 模型元数据与注册表 (getModel, getProviders)          │
│  · 认证与凭据解析 (InMemoryCredentialStore, auth.json) │
│  · 结构化类型定义 (TypeBox / Static / TSchema)          │
│  · 流式事件处理 (EventStream, TextStream, uuidv7)       │
└────────────────────────────────────────────────────────┘
```

### 1.2 工具三层抽象演进（Tool → AgentTool → ToolDefinition）

官方设计了三层递进的工具类型系统，将模型协议、循环执行与产品扩展解耦：

| 层次 | 所在包 | 接口类型 | 核心职责与新增字段 |
|---|---|---|---|
| **第一层：模型名片** | `@earendil-works/pi-ai` | `Tool<TParameters>` | **仅负责告诉模型“工具长什么样”**：`name`（工具名）、`description`（模型可见描述）、`parameters`（TypeBox JSON Schema）。不能执行。 |
| **第二层：执行能力** | `@earendil-works/pi-agent-core` | `AgentTool<TParams, TDetails>` | **赋予 Agent Loop 执行能力**：继承 `Tool`，新增 `label`（人读标签）、`prepareArguments`（参数预处理兼容层）、`execute(id, params, signal, onUpdate)`、`executionMode`（`"sequential"` \| `"parallel"`）。 |
| **第三层：产品门面** | `@earendil-works/pi-coding-agent` | `ToolDefinition` | **面向宿主与扩展的完整产品工具**：`execute` 额外增加第 5 个参数 `ctx: ExtensionContext`（可访问会话状态、模型与目录），并新增 `promptSnippet`（提示词注入片段）、`renderCall` / `renderResult`（UI 渲染）。 |

> **桥接器**：`wrapToolDefinition(definition, ctxFactory)` 函数将上层的 `ToolDefinition` 包装适配为 Agent Loop 认识的底层 `AgentTool`。

### 1.3 Agent Loop 运行机制与核心时序（Trace vs Turn）

官方框架运转的核心是 **Agent Loop** 状态机。在官方源码中，执行时序有严格的定义：

- **Trace（一次任务全生命周期）**：从用户输入开始，到 Agent 彻底完成并发出 `agent_end` 事件的整个过程。一个 Trace 包含一个或多个 Turn。
- **Turn（单轮次模型交互）**：**一次模型推理调用 + 本次调用触发的所有工具执行**。由一对 `turn_start` 和 `turn_end` 包裹。模型返回工具调用 → 执行该批工具 → 发出 `turn_end`；将工具结果送回模型进行下一次思考，属于下一个 Turn。

---

## 2. 顶级创建方式与运行时工厂（Core Factories）

官方提供了**两种级别**的标准创建方式：
1. **轻量单会话模式**：`createAgentSession()` —— 面向单对话、嵌入式 Agent 开发。
2. **完整运行时重建模式**：`createAgentSessionRuntime()` —— 官方 CLI、RPC 和 Interactive 模式使用的底座，支持跨 `cwd` 重建与会话热替换。

### 2.1 `createAgentSession(options)`

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const { session, extensionsResult, diagnostics } = await createAgentSession(options?: CreateAgentSessionOptions);
```

#### `CreateAgentSessionOptions` 参数规格全景：

| 参数名 | 类型 | 说明 | 默认行为 |
|---|---|---|---|
| `cwd` | `string` | 目标工作目录 | `process.cwd()` |
| `agentDir` | `string` | 全局配置目录 | `~/.pi/agent`（自动展开 `~`） |
| `model` | `Model` | 指定初始模型对象（来自 `pi-ai`） | 恢复会话模型 → 配置默认模型 → 首个已认证模型 |
| `thinkingLevel` | `ThinkingLevel` | 思考深度等级：`"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` | 根据模型配置默认值 |
| `scopedModels` | `ScopedModel[]` | 允许轮换的模型范围列表（模型 + 思考深度） | `[]`（可在会话中通过 `cycleModel()` 切换） |
| `resourceLoader` | `ResourceLoader` | 资源装载器（技能、模板、扩展、人设等） | 默认创建 `DefaultResourceLoader` 执行文件发现 |
| `tools` | `string[]` | 启用的工具名称白名单数组 | 默认开启全部注册工具 |
| `customTools` | `ToolDefinition[]` | 随会话注入的自定义工具定义列表 | `[]` |
| `sessionManager` | `SessionManager` | 会话存储管理器 | 默认基于 `cwd` 创建磁盘 `SessionManager` |
| `settingsManager` | `SettingsManager` | 设置管理器 | 默认读取 `~/.pi/agent/settings.json` |
| `modelRuntime` | `ModelRuntime` | 模型运行时（负责鉴权解析与提供商通信） | 默认基于 `agentDir` 自动创建 |
| `packageManager` | `PackageManager` | 扩展包管理器 | 默认创建 `DefaultPackageManager` |
| `authStorage` | `CredentialStore` | 凭据存储后端 | 默认由 `ModelRuntime` 管理 |

---

### 2.2 `createAgentSessionRuntime(factory, options)`

当需要支持用户随时切换项目目录（`cwd`）、创建全新会话、分叉会话（`fork`）时使用：

```typescript
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  getAgentDir,
  type CreateAgentSessionRuntimeFactory
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  // 1. 重建绑定到该 cwd 的底层资源（extensions, tools, settings, loaders）
  const services = await createAgentSessionServices({ cwd, agentDir: getAgentDir() });
  
  // 2. 从已有服务装配新 session
  const sessionResult = await createAgentSessionFromServices({
    services,
    sessionManager,
    sessionStartEvent,
  });

  return {
    ...sessionResult,
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});
```

---

## 3. AgentSession 核心实例接口

### 3.1 会话门面全量方法与属性

```typescript
export interface AgentSession {
  // 1. 会话标识与状态读取
  sessionId: string;
  sessionFile: string | undefined;
  agent: Agent;                        // 底层核心状态机 (pi-agent-core)
  model: Model | undefined;            // 当前激活模型
  thinkingLevel: ThinkingLevel;        // 当前思考深度
  messages: AgentMessage[];            // 对话上下文历史列表
  isStreaming: boolean;                // 是否正在生成

  // 2. 交互控制与队列插队
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(text: string): Promise<void>;      // 在生成中插队（当前 turn 工具执行完毕后抢先处理）
  followUp(text: string): Promise<void>;   // 在全部任务结束后追问
  abort(): Promise<void>;                  // 中止当前生成与工具调用

  // 3. 事件订阅
  subscribe(listener: AgentSessionEventListener): () => void; // 返回取消订阅函数

  // 4. 模型与思考深度控制
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;

  // 5. 树导航与分支操作 (会话回退与跳转)
  navigateTree(targetId: string, options?: {
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
  }): Promise<{ editorText?: string; cancelled: boolean }>;

  // 6. 会话上下文压缩 (Compaction)
  compact(customInstructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;

  // 7. 扩展绑定与资源释放
  bindExtensions(runtime: ExtensionRuntime): Promise<void>;
  dispose(): void;
}
```

### 3.2 `PromptOptions` 选项与 `preflightResult` 预检通知

```typescript
interface PromptOptions {
  expandPromptTemplates?: boolean;  // 是否自动展开 /name 提示词模板 (默认 true)
  images?: ImageContent[];          // 附带多模态图像 (base64 或 buffer)
  streamingBehavior?: "steer" | "followUp"; // 流式生成过程中的冲突排队行为
  source?: InputSource;             // 消息来源 (如 "user" | "extension")
  preflightResult?: (success: boolean) => void; // 预检回调：进入队列/接受时触发 true，拒绝时触发 false
}
```

### 3.3 官方事件体系（`AgentSessionEvent`）全集

通过 `session.subscribe((event) => ...)` 捕获：

| 事件类型 (`event.type`) | 关键携带字段 | 说明 |
|---|---|---|
| `message_start` | `message: AgentMessage` | 智能体开始生成新消息 |
| `message_update` | `assistantMessageEvent: { type: "text_delta" \| "thinking_delta", delta: string }` | 流式增量内容（正文或思考内容） |
| `message_end` | `message: AgentMessage` | 当前消息生成完毕 |
| `tool_execution_start` | `toolName: string, callId: string, input: any` | 工具开始执行 |
| `tool_execution_update`| `toolName: string, callId: string, delta: any` | 工具执行中间增量流 |
| `tool_execution_end` | `toolName: string, callId: string, result: any, isError: boolean` | 工具执行结束 |
| `turn_start` | - | 单轮交互开始（LLM 推理 + 工具调用循环的一轮） |
| `turn_end` | `message: AgentMessage, toolResults: any[]` | 单轮交互结束 |
| `agent_start` | - | 处理整个 prompt 的任务正式开始 |
| `agent_end` | `messages: AgentMessage[]` | 整个 prompt 任务全部结算完毕 |
| `queue_update` | `steering: string[], followUp: string[]` | 排队插队队列发生变动 |
| `compaction_start` | - | 上下文压缩启动 |
| `compaction_end` | `result: CompactionResult` | 上下文压缩完成 |
| `auto_retry_start` | `attempt: number, maxAttempts: number, error: any` | 请求模型自动重试触发 |
| `auto_retry_end` | `success: boolean` | 自动重试结束 |
| `summarization_retry_*`| 摘要生成阶段的重试事件族 | 分支切换或压缩时调用模型的重试流 |

---

## 4. AgentSessionRuntime 多会话与进程状态管理

在官方设计中，**替换活跃会话（新建、切换、fork、导入）**的权力不在 `AgentSession` 本身，而在 `AgentSessionRuntime`：

```typescript
export class AgentSessionRuntime {
  session: AgentSession;
  services: AgentSessionServices;
  diagnostics: AgentSessionRuntimeDiagnostic[];

  newSession(options?: NewSessionOptions): Promise<void>;
  switchSession(sessionFile: string): Promise<void>;
  fork(targetId?: string, options?: { position?: "at" | "after" }): Promise<void>;
  importFromJsonl(filePath: string): Promise<void>;
  reload(): Promise<void>;
}
```

> **生命周期注意点**：当调用 `runtime.newSession()` 或 `runtime.switchSession()` 时，`runtime.session` 会被替换为新实例，原来的事件订阅必须注销并在新 `session` 上重新 `subscribe()`。

---

## 5. ModelRuntime 与凭据认证系统

### 5.1 核心 API

```typescript
export class ModelRuntime {
  static create(options?: CreateModelRuntimeOptions): Promise<ModelRuntime>;
  getModel(providerId: string, modelId: string): Model | undefined;
  getAvailable(): Promise<Model[]>;
  getProviders(): ProviderInfo[];
  checkAuth(providerId: string): Promise<{ authenticated: boolean; method?: string; error?: string }>;
  setRuntimeApiKey(providerId: string, apiKey: string): void;
}
```

### 5.2 认证查找四级优先级（Official Priority）
1. **Runtime Override**：通过 `modelRuntime.setRuntimeApiKey()` 动态注入的密钥（适合多租户/运行时换 Key，永不落盘）。
2. **Stored Credentials**：`~/.pi/agent/auth.json` 中的持久化凭据（含 API 密钥与 OAuth 令牌）。
3. **Environment Variables**：环境变量（如 `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` 等）。
4. **Custom Models Config**：`~/.pi/agent/models.json` 中随 provider 定义绑定的 fallback 密钥。

---

## 6. ResourceLoader 与系统提示词 5 段拼装机制

### 6.1 `DefaultResourceLoader` 配置与覆盖钩子

```typescript
export class DefaultResourceLoader implements ResourceLoader {
  constructor(options?: {
    cwd?: string;
    agentDir?: string;
    systemPromptOverride?: (basePrompt: string) => string;
    skillsOverride?: () => Promise<{ skills: Skill[]; diagnostics: ResourceDiagnostic[] }>;
    promptsOverride?: () => Promise<{ prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }>;
    agentsFilesOverride?: () => Promise<{ agentsFiles: ContextFile[] }>;
    extensionFactories?: ExtensionFactory[];
    extraSkillPaths?: string[];
    extraPromptTemplatePaths?: string[];
    extraExtensionPaths?: string[];
    noSkills?: boolean;
    noPromptTemplates?: boolean;
    noExtensions?: boolean;
    includeAgentsFiles?: boolean;
  });

  reload(): Promise<void>;
  getPrompts(): PromptTemplate[];
  getSkills(): Skill[];
  getExtensions(): Extension[];
  getAgentsFiles(): ContextFile[];
}
```

### 6.2 `buildSystemPrompt` 源码级五段拼装流水线

官方 SDK 生成最终发给 LLM 的系统提示词时，按如下 **5 段顺序** 拼装：

```
最终提示词 = ① 基础人设        ← 模型的「角色设定」
           + ② 追加规则        ← 从 APPEND_SYSTEM.md 读取
           + ③ 项目上下文      ← 从 AGENTS.md / CLAUDE.md 读取
           + ④ 技能描述        ← 从 .pi/skills/*/SKILL.md 读取（需含 read 工具）
           + ⑤ 工作目录        ← SDK 固定追加：Current working directory: /path
```

- **① 基础人设**：三级优先级回退：
  1. 代码层 `systemPromptOverride`（优先级最高）
  2. 文件层 `{cwd}/.pi/SYSTEM.md` 或 `~/.pi/agent/SYSTEM.md`
  3. SDK 内置写死兜底：`You are an expert coding assistant...`
- **② 追加规则**：读取 `{cwd}/.pi/APPEND_SYSTEM.md`。
- **③ 项目上下文**：从 `cwd` 向上递归读取 `AGENTS.md` / `CLAUDE.md`。
- **④ 技能描述**：注入 `<available_skills>` 块。**关键机制：仅当工具集包含 `read` 工具时才会注入**（没有 read 工具，模型无法读取技能文件，注入反而误导）。
- **⑤ 工作目录**：末尾固定追加一行 `Current working directory: /path`。

### 6.3 垂直智能体的提示词隔离原则

官方 SDK 默认是专为**命令行写代码（coding agent）**优化的人设。如果做垂直 Agent（客服、数据分析、审批助手）：
- **必须**使用 `systemPromptOverride` 覆盖基础人设，否则模型会残留代码审查、文件编辑的预设行为。
- **必须**裁剪默认启用的高危工具（如 `bash`, `write`, `edit`）。

---

## 7. SettingsManager 配置管理体系

```typescript
export class SettingsManager {
  static create(options?: SettingsManagerCreateOptions): Promise<SettingsManager>;
  static inMemory(initialSettings?: Partial<Settings>): SettingsManager;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
}
```

### 官方 Settings 字段全集：

> ⚠️ **字段名以 `dist/core/settings-manager.d.ts` 为准**。本节初版凭印象写的子字段名与真实定义有出入，已按 `.d.ts` 校正（`compaction` 不是 `threshold/keepRecentTurns/reservedTokens`；`retry` 不是 `maxAttempts/maxDelayMs`；`images` 不是 `maxDimension/quality`；`disabledTools` 不属于官方 `Settings`——那是 pi-starter 自己的设置项）。

- `defaultProvider` / `defaultModel`：默认选中的 provider 与模型。
- `defaultThinkingLevel`：默认思考深度（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`）。
- `enabledModels`：允许列出的模型白名单数组。
- `transport`：出站传输方式。
- `steeringMode` / `followUpMode`：`"all"` | `"one-at-a-time"`（插队/追问队列消费策略）。
- `compaction`：`{ enabled?, reserveTokens?, keepRecentTokens? }`（自动压缩开关/预留/保留最近 token）。
- `branchSummary`：`{ reserveTokens?, skipPrompt? }`（分支摘要预算/是否跳过确认）。
- `retry`：`{ enabled?, maxRetries?, baseDelayMs?, provider?: { timeoutMs?, maxRetries?, maxRetryDelayMs? } }`。
- `images`：`{ autoResize?, blockImages? }`（图像自动降采/屏蔽）。
- `thinkingBudgets`：`{ minimal?, low?, medium?, high? }`（各思考档 token 预算）。
- 其余服务层字段：`httpIdleTimeoutMs`（出站 provider 空闲超时）、`websocketConnectTimeoutMs`、`sessionDir`、`httpProxy`、`hideThinkingBlock`、`packages`/`extensions`/`skills`/`prompts`/`themes`（资源装载）等。
- **pi-starter 覆盖状态**：`compaction`/`retry`/`images`/`enabledModels`/`httpIdleTimeoutMs`/`websocketConnectTimeoutMs`/`steeringMode`/`followUpMode`/`thinkingBudgets`/`branchSummary` 经 `buildAgent({ sdkSettings })` + `PI_*` 环境变量透传给官方 `SettingsManager`；默认不配则不建 SettingsManager、行为不变。

---

## 8. SessionManager、JSONL 存储与会话树导航

### 8.1 会话树与 DAG 分支结构

官方 `.jsonl` 文件中的每条记录都有 `id` 和 `parentId`。因此会话不是单一线性数组，而是一棵**以节点指针构成的树状图**，天然支持多分支（Branching）与安全回退。

### 8.2 JSONL Entry 数据格式规范全集

| Entry Type | 结构字段说明 |
|---|---|
| `header` | 会话第一行：`version`, `sessionId`, `cwd`, `timestamp` |
| `message` | 对话消息条目（Role: `user` \| `assistant` \| `tool`） |
| `compaction` | 压缩标记：包含被压缩的节点范围、结构化摘要文本（`summary`） |
| `branch_summary` | 分支摘要标记：在会话分支跳转时自动生成的承前启后摘要 |
| `model_change` | 运行期间模型变更记录（`fromModel`, `toModel`, `timestamp`） |
| `thinking_level_change` | 思考深度等级变动记录 |
| `custom` | 扩展或宿主写入的私有标记数据（不污染模型上下文） |

### 8.3 `navigateTree` 树导航与分支摘要生成

当用户要求回退到历史某一轮对话时：
- `session.navigateTree(targetId, { summarize: true })` 将活跃叶子节点切换到历史目标节点。
- 若 `summarize: true`，官方调用 `generateBranchSummary` 生成当前分支工作成果的简短摘要，以 `branch_summary` 形式追加到新分支，保证上下文连续性。

---

## 9. 官方工具系统与自定义工具规范

### 9.1 7 个内置工具能力与构造函数

```typescript
import {
  createReadTool, createBashTool, createEditTool, createWriteTool,
  createGrepTool, createFindTool, createLsTool,
  createCodingTools, createReadOnlyTools
} from "@earendil-works/pi-coding-agent";
```

- `read`: 读文件，自动分页与超限截断。
- `bash`: 执行 shell 命令，包含进程树回收与超时控制。
- `edit`: 精确文本定位替换并生成 Unified Patch。
- `write`: 全量写入或覆盖文件。
- `grep` / `find` / `ls`: 文件系统检索与遍历。

### 9.2 工具执行五步管道（Pipeline）

每当模型发出 `tool_call` 时，Agent Loop 按照严格的五步管道执行：

```
[模型输出 tool_call]
        │
        ▼
1. 参数预处理 (prepareArguments)  ← 处理某些模型的 JSON 输出怪癖
        │
        ▼
2. Schema 校验 (TypeBox 自动验证) ← 失败则自动生成错误消息回传模型，不崩溃
        │
        ▼
3. 权限安全拦截 (tool_call 钩子)  ← 扩展可在此阻断执行 (block: true) 或改写参数
        │
        ▼
4. 工具执行 (execute 函数)        ← 捕获 AbortSignal 取消信号并报告 onUpdate 进度
        │
        ▼
5. 结果后处理 (tool_result 钩子)  ← 扩展可修改或脱敏返回给模型的内容
```

### 9.3 `defineTool` 自定义规范与 5 个 execute 参数

```typescript
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

export const queryDataTool = defineTool({
  name: "query_data",
  label: "查询销售数据",
  description: "按指定列条件过滤 sales.csv",
  parameters: Type.Object({
    column: Type.String({ description: "列名" }),
    value: Type.String({ description: "目标值" }),
  }),
  // 官方 execute 提供的 5 个参数：
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 1. toolCallId: 当前调用的唯一 UUID
    // 2. params: 经过 TypeBox 校验完全类型安全的对象
    // 3. signal: AbortSignal 取消信号 (用户点击停止时触发)
    // 4. onUpdate: 实时进度通知回调 (流式输出给 UI)
    // 5. ctx: ExtensionContext (当前会话的上下文，含模型、cwd 等)
    return {
      content: [{ type: "text", text: "查询结果..." }],
      details: { rowCount: 10 },
    };
  },
});
```

---

## 10. 扩展系统（Extensions）与生命周期钩子全集

### 10.1 两阶段绑定架构（Throwing Stubs + bindCore）

官方 Extension 系统采用了精妙的**两阶段解耦设计**：
1. **注册阶段（加载期）**：扩展工厂函数（`ExtensionFactory`）在 SDK 启动时执行，此时 Agent 实例、会话和消息循环尚未就绪。官方给扩展传入的 `pi` 门面中，运行时方法（如 `pi.sendMessage`）是 **Throwing Stubs**（调用即报警）。扩展在此阶段只允许“声明意图”（`pi.on`、`pi.registerTool`、`pi.registerCommand`）。
2. **绑定阶段（运行期）**：当会话建立后，SDK 内部调用 `bindCore`（对外为 `session.bindExtensions()`），将所有 Throwing Stubs 切换为针对当前会话的真实可执行方法。

### 10.2 四种扩展介入模式

扩展通过 `pi.on(eventName, handler)` 介入 Agent 行为，官方支持 4 种模式：
- **通知型（纯监听）**：不改变任何行为，仅用于日志审计或监控。
- **取消型**：返回 `{ cancel: true }`，例如取消用户输入的发送。
- **修改型（流水线中间件）**：返回修改后的输入或参数（如改写提示词、修改工具输入参数）。
- **短路阻断型**：在 `tool_call` 中返回 `{ block: true, reason: "..." }`，跳过工具执行，将原因作为错误消息反馈给 LLM。

### 10.3 40+ 官方事件钩子全览

- **执行流钩子**：`before_agent_start`, `input`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`
- **安全与工具钩子**：`tool_call`, `tool_result`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `user_bash`
- **会话拓扑钩子**：`session_start`, `session_shutdown`, `session_before_switch`, `session_switch`, `session_before_fork`, `session_fork`, `session_before_compact`, `session_compact`, `session_before_tree`, `session_tree`, `session_info_changed`
- **模型网络钩子**：`before_provider_request`, `before_provider_headers`

---

## 11. 上下文压缩（Compaction）与 Token 预算工程

### 11.1 压缩时序契机：两轮对话之间

**压缩不是在 LLM 流式生成过程中触发的，而是在两轮对话之间发生的**：
每当一个 Trace 结束（`agent_end`），SDK 检查当前消息的 token 占用。若 `contextTokens > contextWindow - reserveTokens`，立即在后台启动压缩，寻找切割点、生成结构化摘要并写入 `CompactionEntry`。下一轮对话开始时，`buildSessionContext()` 将旧消息替换为摘要卡片发给模型。

### 11.2 压缩算法：切割点（CutPoint）与结构化摘要
- `findCutPoint`：在历史消息中智能寻找安全的分割线，严格保证不会切断 `tool_use` 与 `tool_result` 之间的对应闭环。
- `generateSummary`：调用轻量模型生成包含“任务目标、关键决策、已修改文件、当前进度”的高密度 Markdown 笔记。

### 11.3 官方 chars/4 估算机制与中文低估偏差分析
- 官方内置 `estimateTokens(message)` 使用 `Math.ceil(chars / 4)` 快速估算。
- **中文严重低估偏差**：1 个英文字符约 0.25 token，但 1 个汉字实际占用 1~2 token。若纯用官方 `chars/4`，在中文长对话中模型上下文实际已接近溢出，而 SDK 仍误判为“未达压缩阈值”。
- **工程解决实践**：在垂直 Agent 脚手架中，针对 CJK 字符必须采用加权估算（例如 CJK 字符按 1:1 或 1:1.5 计算），确保压缩在真实窗口耗尽前可靠触发。

---

## 12. 技能（Skills）、提示词模板与 AGENTS.md 规范

- **Skills 规范**：`.pi/skills/<name>/SKILL.md`，包含 YAML Frontmatter。仅当会话具备 `read` 工具时，SDK 自动将 `<available_skills>` 注入提示词。
- **Prompt Templates 规范**：`.pi/prompts/<name>.md`。在 `session.prompt()` 中输入 `/name [args]` 自动展开。
- **AGENTS.md 规范**：递归向上查找项目级约束文件，自动合并进上下文工程。

---

## 13. 程序化通信模式与宿主选型路径

### 13.1 三档宿主集成路径对比

| 档位 | 集成形态 | 通信媒介 | 控制权 | 适用场景 |
|---|---|---|---|---|
| **第 1 档：SDK 模式** | **进程内 TypeScript 集成** | 进程内对象引用 (`AgentSession`) | **最高**（完全控制模型、拦截工具、修改会话） | **自建垂直 Agent 脚手架（如本项目）、专属服务端** |
| **第 2 档：RPC 模式** | **双向子进程 STDIO** | JSON-RPC 2.0 结构化事件流 | **高**（语言无关、进程硬隔离、支持 RPC Extension UI） | 跨语言客户端（Python/Go 宿主）、桌面 GUI、独立沙箱进程 |
| **第 3 档：Print 模式** | **单向输出管道** | NDJSON / 纯文本行 | **只读**（仅用于日志采集或结果投影） | 简易 CI/CD 流水线、纯监控 |

### 13.2 官方 RPC Mode 协议与 RpcClient
- 服务端：`runRpcMode({ cwd })`
- 客户端：`new RpcClient({ process })`，支持全部 session 命令并提供结构化响应。

### 13.3 JSON Event Stream 模式与全局 EventBus
- `POST /chat?format=jsonl` 或 `--mode json` 提供原始事件流。
- `createEventBus()` 提供跨组件全局解耦总线。

---

## 14. 官方 SDK 标准示例（Examples 01–13）范式总览

| 示例文件 | 官方主题 | 核心 API 与官方推荐写法 |
|---|---|---|
| `01-minimal.ts` | 极简起步 | `createAgentSession({ sessionManager: SessionManager.inMemory() })` |
| `02-custom-model.ts` | 模型选择与思考等级 | `getModel("anthropic", "claude-opus-4-5")` + `thinkingLevel: "high"` |
| `03-custom-prompt.ts` | 系统提示词重写/注入 | `new DefaultResourceLoader({ systemPromptOverride: (base) => ... })` |
| `04-skills.ts` | 技能发现与过滤 | `new DefaultResourceLoader({ skillsOverride: () => ... })` |
| `05-tools.ts` | 工具白名单与只读化 | `createAgentSession({ tools: ["read", "grep", "find", "ls"] })` |
| `06-extensions.ts` | 扩展生命周期注入 | `extensionFactories: [myExtension]` + `pi.on("tool_call")` |
| `07-context-files.ts` | 上下文文件管理 | `new DefaultResourceLoader({ agentsFilesOverride: () => ... })` |
| `08-prompt-templates.ts`| 模板配置与展开 | `promptsOverride: () => ...` + `/template-name` 展开 |
| `09-api-keys-and-oauth.ts`| 密钥与认证状态解析 | `modelRuntime.getProviders()` + `modelRuntime.checkAuth(p)` |
| `10-settings.ts` | 压缩与重试配置覆盖 | `SettingsManager.inMemory({ compaction: { threshold: 0.8 } })` |
| `11-sessions.ts` | 磁盘持久化与会话恢复 | `SessionManager.create(cwd)` + `sessionManager.continue()` |
| `12-full-control.ts` | 彻底接管全部发现 | 手工注入所有 override，零本地文件探测 |
| `13-session-runtime.ts`| 完整运行时热重建管理 | `createAgentSessionRuntime(createRuntimeFactory, options)` |

---

## 15. 官方能力全景对照检查表（Checklist）

| 编号 | 官方功能特性 | 官方 SDK 接口 / 类型 | pi-starter 接入状态 | 架构实现与对照说明 |
|---|---|---|:---:|---|
| **C01** | 单会话标准装配 | `createAgentSession()` | ✅ **已对齐** | 位于 `src/agent.ts`，组装 tools、loader 与 runtime |
| **C02** | 完整运行时重建体系 | `createAgentSessionRuntime()` | ✅ **已对齐** | 位于 `src/rpc.ts`，支持 `--mode rpc` 标准运行时 |
| **C03** | 官方资源装载器 | `DefaultResourceLoader` | ✅ **已对齐** | 位于 `src/agent.ts`，完全托管技能、模板与扩展加载 |
| **C04** | 原生技能目录规范 | `<available_skills>` | ✅ **已对齐** | 删除了早期手写目录，只依赖官方原生注入 |
| **C05** | 官方模板清单获取 | `loader.getPrompts()` | ✅ **已对齐** | 位于 `src/prompt-templates/`，走官方统一装载器 |
| **C06** | 原生模型运行时 | `ModelRuntime` | ✅ **已对齐** | 位于 `src/models.ts`，负责鉴权解析与模型目录 |
| **C07** | 模型轮换 API | `session.cycleModel()` | ✅ **已对齐** | REST `/model/cycle` 与 WS `cycle_model` 均接入 |
| **C08** | 思考深度轮换 API | `session.cycleThinkingLevel()` | ✅ **已对齐** | 暴露于 CLI 与 WS 协议 |
| **C09** | 树导航带摘要回退 | `session.navigateTree()` | ✅ **已对齐** | 位于 `src/sessions/edit.ts`，支持 `summarize` 选项 |
| **C10** | 提示词预检通知 | `PromptOptions.preflightResult` | ✅ **已对齐** | 位于 `src/session-hub.ts`，冲突排队时回传明确状态 |
| **C11** | 消息排队插入 | `session.steer()` / `followUp()` | ✅ **已对齐** | 位于 `src/session-hub.ts`，接入流式抢先排队 |
| **C12** | 会话存储与隔离 | `SessionManager.create()` | ✅ **已对齐** | 位于 `src/sessions/`，会话目录与 CLI 独立隔离 |
| **C13** | 官方扩展机制 | `ExtensionFactory` / `ExtensionAPI` | ✅ **已对齐** | 位于 `src/extensions/`，支持注入官方标准扩展 |
| **C14** | 工具调用拦截钩子 | `pi.on("tool_call")` | ✅ **已对齐** | 位于 `src/approval/gate.ts`，实现 HITL 审批闸门 |
| **C15** | 官方内置工具封装 | `createCodingTools()` 等 | ✅ **已对齐** | 位于 `src/tools/`，按 `off`/`readonly`/`coding` 档位挂载 |
| **C16** | 官方 RPC 标准模式 | `runRpcMode` | ✅ **已对齐** | 位于 `src/rpc.ts`，可通过 `--mode rpc` 独立启动 |
| **C17** | 官方事件总线 | `createEventBus()` | ✅ **已对齐** | 暴露为 `BuiltAgent.eventBus` |
| **C18** | 会话标签变更机制 | `appendLabelChange` / `getLabel` | ✅ **已对齐** | WS `set_label` 与快照 `labels` 接入 |
| **C19** | Provider 鉴权探测 | `getProviders()` / `checkAuth()` | ✅ **已对齐** | 暴露于 `GET /providers` 与 `/info` |
| **C20** | AGENTS.md 级联发现 | `includeAgentsFiles` | ✅ **已对齐** | 位于 `src/config.ts` 可选开启 |
| **C21** | 官方上下文压缩 | `session.compact()` | ✅ **已对齐** | 位于 `src/session-hub.ts`，支持指令触发压缩 |
| **C22** | 官方事件流通道 | `POST /chat?format=jsonl` | ✅ **已对齐** | 位于 `src/app.ts`，与官方 `json.md` 事件流规范一致 |

---

## 16. 双轨教程章节系统对照视角（冬瓜 / dgzhuya 教程全景）

> 本章整理自开源社区深度教程（《Pi Agent 双轨教程》，作者：冬瓜，在线地址：`https://www.dgzhuya.com/`，本地 Markdown 镜像库位于 `D:\Program Files (x86)\LPK\obsidian-notes\02-AI\Agent\Pi项目\pi-agent-notes`）。
> 提供**按章节叙事展开**的对照阅读视角，与前文的接口字典形成互补。

### 16.1 实战上手篇（P01–P07 逐章核心模型与业务落地）

以开发一个企业级数据分析助手（DataAgent）为主线，聚焦“改哪一层、为什么这样接”：

| 章节编号 | 章节标题 | 解决的核心问题 | 核心 API 模式与关键代码 | 实战避坑与落地指导 |
|---|---|---|---|---|
| **P01** | 环境部署 —— 10 分钟跑通第一个 Agent | 搭建 Node ≥ 22.19 原生 ESM 开发环境，消除环境配置摩擦 | `import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent"` | 必须为纯 ESM 模块（`"type": "module"`），避免用传统 CJS 的 `require`；必须安装外壳包 `@earendil-works/pi-coding-agent`。 |
| **P02** | 读懂第一个 Agent —— 核心 API 与三层架构 | 拆解 12 行最小 Agent 代码背后的 5 件大事，理解阻塞式 prompt 与流式监听 | `ModelRuntime.create()`<br>`modelRuntime.getAvailable()`<br>`createAgentSession({ model, modelRuntime })`<br>`session.subscribe(...)`<br>`await session.prompt(...)` | `session.prompt()` 在底层是阻塞等待直到整个 Trace 完成，中间增量必须通过 `subscribe` 捕获；退出必须在 `finally` 中调用 `session.dispose()` 释放。 |
| **P03** | 模型配置关键点 —— 判断企业内网模型能否接入 | 弄清认证解析优先级，企业私有模型（Ollama / vLLM / 智谱 / DeepSeek）如何接入，多租户运行时如何动态换 Key | `modelRuntime.setRuntimeApiKey(provider, key)`<br>`~/.pi/agent/models.json` 配置自定义兼容提供商 | `setRuntimeApiKey` 仅在内存中生效、永不写盘，天然适合 Web 多租户隔离；配置私有端点时需注意 `baseURL` 必须兼容 OpenAI Responses 格式。 |
| **P04** | 系统提示词 —— 必须覆盖默认 Agent 人设 | 消除 SDK 内置的“写代码和改文件”默认人设，给垂直 Agent 注入纯净业务角色 | `new DefaultResourceLoader({`<br>&nbsp;&nbsp;`systemPromptOverride: (base) => "你是一个专业数据分析师..."`<br>`})` | 源码 `buildSystemPrompt` 会拼装 5 段内容。做垂直 Agent 时，**必须**使用 `systemPromptOverride` 覆盖第 ① 段基础人设；若不需要追加规则和上下文文件，不创建对应文件即可自动保持纯净。 |
| **P05** | 定义工具 —— 从功能实现到交互体验 | 消除手写校验与异常处理的繁琐工作，掌握 `defineTool` 与 5 个参数的威力 | `defineTool({`<br>&nbsp;&nbsp;`name, description, parameters,`<br>&nbsp;&nbsp;`async execute(id, params, signal, onUpdate, ctx) { ... }`<br>`})` | 框架已自动用 TypeBox 做完参数校验并兜底 try/catch；`execute` 中一定要消费 `signal`（响应用户中止）和 `onUpdate`（推送中间执行状态）。内置工具默认开着 `bash`/`write`/`edit`，垂直场景务必通过白名单 `tools: [...]` 隐藏。 |
| **P06** | 事件监听 —— 实现你的所有个性化需求 | 掌握 `subscribe` 的完整事件状态机，向前端或控制台精确分发流式状态 | 监听 `message_update`（`text_delta`、`thinking_delta`）<br>监听 `tool_execution_*`<br>监听 `turn_*` 与 `agent_*` | `message_update` 是细粒度流式文本，而 `agent_end` 才是整个任务结束的权威结算信号；思考模型的思维链通过 `thinking_delta` 独立推送。 |
| **P07** | 准备上线 —— 把 Agent 封装成一个服务 | 摆脱 CLI 脚本，把 Agent 包装成生产级 HTTP/SSE 流式 Web 服务 | Express / 原生 HTTP + SSE 事件映射 + 会话生命周期隔离 | 区分长生命周期服务（`ModelRuntime`、`ResourceLoader`）与短生命周期会话（`AgentSession`）；每个用户连接必须拥有独立的 session，不可并发共享同一实例。 |

---

### 16.2 源码精读篇（M01–M11 逐章原理解析与架构图解）

深入 SDK 内部内核，从状态机、事件总线、内存数据结构到算法设计进行系统剖析：

| 章节编号 | 主题 | 源码层级与关键文件 | 核心架构原理与精髓 |
|---|---|---|---|
| **M01** | 开篇总览 | 框架全貌 | 确立 Pi-Agent 作为“现代化生产级 Agent Harness 底座”的地位，阐明其比 LangChain/AutoGPT 更加精简、高内聚的设计哲学。 |
| **M02** | 三层架构 | 包依赖结构 | 拆解 `pi-ai`（纯模型抽象）、`pi-agent-core`（核心状态机与循环）、`pi-coding-agent`（产品层封装与资源加载）的单向依赖树。 |
| **M03** | Agent Loop | `agent-loop.ts`<br>`agent.ts` | 厘清 **Trace vs Turn** 状态机模型。说明模型驱动循环流转的判据（是否返回 `tool_use`），以及人类硬规则判停机制（无工具调用即停）。 |
| **M04** | 模型调用 | `packages/ai/src/` | 剖析多提供商统一适配层，如何抹平 Anthropic、OpenAI、Google 等不同协议流式 chunk 的结构异构。 |
| **M05** | 工具系统 | `tool-definition-wrapper.ts`<br>`tools/index.ts` | 揭示 **Tool → AgentTool → ToolDefinition** 三层类型演进与 `wrapToolDefinition` 包装器。拆解参数预处理、Schema 校验、权限拦截、执行与后处理的**五步管道**。 |
| **M06** | 消息系统 | `messages.ts` | 剖析对话消息模型（User / Assistant / ToolResult / Custom），以及消息在底层如何保持严格的时序交替约束。 |
| **M07** | 事件驱动 | `event-bus.ts` | 剖析 Agent 内部事件总线的设计，如何通过强类型事件流驱动 UI 渲染、日志审计与扩展拦截。 |
| **M08** | 上下文工程 | `system-prompt.ts` | 拆解滑动窗口预算管理、提示词模板动态注入、以及级联上下文文件查找合并算法。 |
| **M09** | 上下文压缩 | `compaction/compaction.ts` | 揭秘“两轮对话之间”触发压缩的核心时序，安全切割点 `findCutPoint` 保护机制，以及官方 `chars / 4` 估算在中文语境下严重低估的底层原因与应对。 |
| **M10** | 会话管理 | `session-manager.ts`<br>`jsonl-storage.ts` | 拆解 JSONL 持久化格式，揭示基于 `parentId` 构成的有向无环会话树（DAG），以及 `navigateTree` 和 `generateBranchSummary` 的分支切换算法。 |
| **M11** | 扩展系统设计 | `core/extensions/` | 深入“两阶段绑定”架构（Throwing Stubs 在加载期解耦、运行期 `bindCore` 激活），剖析通知、取消、修改、短路阻断四种扩展介入模式。 |

---

## 17. 第三方生态与生产级 Web UI 视角（pi-web-ui 对照）

> 本章整理自《Pi 生态与第三方 Web UI 调研》（2026-10 锁定基线：`pi-web-ui@0.99.0`）。
> 探讨如何利用外部成熟的 Web 宿主生态，以及我们脚手架与大型驾驶舱之间的互补边界。

### 17.1 `pi-web-ui` 架构剖析（pi 世界的 Yuxi）

在社区生态中，`pi-web-ui` 被视为最贴近生产级“AI 编码驾驶舱”的宿主实现：
- **完整后端**：基于 Node + Express + WS，自研约 130 个 TS 文件。
- **进程内起 Agent（SDK 档）**：`PI_WEB_ENGINE=pi`，直接在进程内 `import { createAgentSession }`，拥有绝对的结构化对象控制权（非外部 RPC 旁观）。
- **业务扩展槽位**：原生支持 Pi 扩展、自身插件体系（`plugin-sdk`）与自定义 CSS 主题。

### 17.2 插件体系（`plugin-sdk`）与原生扩展双轨机制

在 `pi-web-ui` 这一类高阶宿主中，存在两条平行的扩展路径：
1. **Pi 原生扩展（`extensions/`）**：
   - 走 Pi SDK 标准规范（`ExtensionFactory` + `pi.on(...)`）。
   - 负责干涉底层 Agent Loop、拦截工具（`tool_call`）、注册自定义斜杠命令与模型提供商。
2. **宿主级插件体系（`plugin-sdk/`）**：
   - 具备前端组件（Client View）与后端入口（Server Entry `index.mjs`）。
   - 负责在宿主界面中注入专有面板（如任务看板、代码审查界面、多模态预览窗）。

### 17.3 垂直脚手架（pi-starter）与完整驾驶舱（pi-web-ui）的定位取舍

在工程实践中，二者并不是非此即彼，而是职责清晰的分工定位：

| 维度 | `pi-starter`（当前脚手架） | `pi-web-ui`（生产驾驶舱） | 架构取舍与工程边界 |
|---|---|---|---|
| **核心定位** | **垂直业务 Agent 脚手架**（客服、分析师、审批机器人） | **通用 AI 编码驾驶舱**（改代码、终端、git、文件管理） | 绝不把驾驶舱的大量改代码专用工具搬进轻量脚手架内核。 |
| **依赖与体积** | 极简零重依赖（仅 SDK、Express、`ws`、TypeBox，无 node-pty） | 约 130 个文件，最大单文件约 1.5 万行，重度依赖 PTY/桌面端 | 脚手架保持纯净、透明、易单测、单进程启动。 |
| **内置工具策略** | 默认全部关闭编码工具（`off`），按需开启，业务从接口注入 | 深度捆绑 LSP、diff patch、Office 解析、ConPTY 终端 | 垂直场景默认安全，杜绝命令注入与越权修改。 |
| **协议与状态机** | 单源 `protocol.ts`，强类型 WS 快照 + rev 链，审批声明式规则 | 约 100 个 WS 命令，含复杂过户、项目空间与 SCM 事务 | 脚手架继承其“服务端快照唯一真源”的思想，裁剪其重度业务命令。 |
| **上下文与 Token** | 增加中文加权预算算法（`budget.ts`，修复官方 chars/4 偏差） | 依赖官方上下文压缩与模型切换 | 脚手架在中文长文本分析场景具备更高可靠性。 |

