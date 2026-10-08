/**
 * pi-starter · Agent 组装层
 *
 * CLI 和 Web 都从这里拿 session。
 *
 *   1. ModelRuntime.create()      → 读 ~/.pi/agent/ 配置
 *   2. 选模型
 *   3. DefaultResourceLoader      → additionalSkillPaths 走 SDK 技能扫描；
 *                                   noSkills 只关掉 ~/.pi，不关 extra 路径
 *   4. 知识库 / 数据库            → 进程内 Markdown + node:sqlite（SDK 没有这两项）
 *   5. createAgentSession()       → 默认档位带 read，好让 SDK 把技能目录写进系统提示词
 *
 * 多对话支持：`createSession()` 每次新建一套独立的 loader + session（每个对话一个 runtime），
 * 供 Web 端「多对话并发」使用；CLI / 库调用方只用首个 session，无需感知。
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  requireConfiguredModel,
  sessionToolPolicy,
  SETUP_HINT,
  type BuiltinToolMode,
} from "./config.js";
import { formatModelChoices, resolveModelRef, unknownModelError } from "./models.js";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { ExecEnvironment } from "./exec/runner.js";
import { allTools } from "./tools/index.js";
import { execToolsForMode } from "./tools/exec.js";
import { allExtensions, type ExtensionFactory } from "./extensions/index.js";
import { loadScaffoldSkills, resolveSkillPaths, type LoadedSkill } from "./skills/index.js";
import {
  loadScaffoldPromptTemplates,
  resolvePromptTemplatePaths,
  type LoadedPromptTemplate,
} from "./prompt-templates/index.js";
import { badRequest } from "./http/errors.js";
import { assertSessionFileAllowed } from "./sessions/store.js";
import { formatKnowledgeCatalog, loadScaffoldKnowledge, type KnowledgeDoc } from "./knowledge/index.js";
import {
  composePrompt,
  defaultPromptTemplate,
  type PromptLayers,
} from "./prompts/composer.js";
import { openScaffoldDatabase, type DatabaseStore } from "./db/index.js";
import { getLogger } from "./log.js";
import { createReadKnowledgeTool, createSearchKnowledgeTool } from "./tools/knowledge.js";
import { createDbQueryTool, createDbStatusTool } from "./tools/database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolvePromptsDir(): string {
  const candidates = [
    join(__dirname, "prompts"),
    join(__dirname, "..", "src", "prompts"),
    join(__dirname, "..", "prompts"),
  ];
  const found = candidates.find((dir) => existsSync(join(dir, "persona.md")));
  if (!found) {
    throw new Error(`prompts/persona.md not found (tried ${candidates.join(", ")})`);
  }
  return found;
}

/**
 * Render the system prompt from an optional template.
 * Empty template → the default `{{persona}}\n\n{{rules}}\n\n…` order.
 */
function renderSystemPrompt(template: string | undefined, layers: PromptLayers): string {
  const trimmed = template?.trim();
  return composePrompt(trimmed ? trimmed : defaultPromptTemplate(), layers);
}

/** One-line-per-skill catalog for the `{{skills}}` prompt layer (empty when no skills). */
function formatSkillCatalog(skills: readonly LoadedSkill[]): string | undefined {
  if (skills.length === 0) return undefined;
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return `Available skills (load with /<name>):\n${lines.join("\n")}`;
}

/** 组装 Agent 的配置选项 */
export interface BuildAgentOptions {
  /** 指定 provider（如 modelscope / zhipu），不传则读 .env 的 PI_PROVIDER */
  provider?: string;
  /** 指定模型 id，不传则读 .env 的 PI_MODEL。两者都缺会直接抛，不会落到 huggingface */
  modelId?: string;
  /** 系统提示词：默认读取 prompts/ 目录下的 persona + rules */
  systemPrompt?: string;
  /**
   * 提示词模板（`{{persona}}` / `{{rules}}` / `{{knowledge}}` / `{{skills}}` / `{{cwd}}` 等）。
   * 留空走默认顺序。接入 settings 时传 `settings.promptTemplate` 即可让该设置真正生效。
   */
  promptTemplate?: string;
  /** 追加到系统提示词的业务段（对应模板的 `{{append}}`），垂直 Agent 注入领域规则用。 */
  promptAppend?: string;
  /** 是否使用内存会话（默认 false = 落盘；传 true 则完全不写盘） */
  inMemory?: boolean;
  /**
   * 会话落盘目录。不传则交给 SDK 按 `~/.pi/agent/sessions/--<cwd>--` 推导（CLI）。
   * Web 必须传入本脚手架自己的目录（见 `scaffoldSessionDir`），不要和 CLI 的记录混放。
   */
  sessionDir?: string;
  /**
   * `resumeFrom` 允许落在哪些目录里。空数组 = 不允许打开已有文件（fail-closed）。
   * Web 传入 `[sessionDir]`。只传 `sessionDir` 不会自动放开恢复。
   */
  allowedSessionRoots?: readonly string[];
  /**
   * 恢复一个已有会话文件（重启后接回上次的对话）。
   *
   * 只有 SDK 的 `SessionManager.open()` 能做到——`createAgentSession` 本身没有
   * `resume` 参数，它只认 `sessionManager`。路径会在 open 之前再校验一次。
   */
  resumeFrom?: string;
  /** 注入额外工具（叠在 src/tools 登记的工具之上） */
  extraTools?: ToolDefinition[];
  /**
   * 运行期增删的工具来源（MCP 桥）。
   *
   * 是**函数**而不是数组：MCP 工具随配置变化，必须在每次建会话的那一刻取当时最新的集合。
   * 传数组的话，MCP 服务器是会话建好之后才连上的，工具就永远进不了白名单。
   */
  dynamicTools?: () => readonly ToolDefinition[];
  /** 注入额外扩展（叠在 src/extensions 登记的钩子之上，排在 guard / audit 后面） */
  extraExtensions?: ExtensionFactory[];
  /** 额外技能目录（叠在 src/skills 之上，同名时仓库内置优先）。交给 SDK additionalSkillPaths */
  extraSkillPaths?: string[];
  /** 额外知识库目录（叠在 src/knowledge 之上，同名时仓库内置优先） */
  extraKnowledgeDirs?: string[];
  /**
   * 额外提示词模板路径（目录或 `.md` 文件，叠在 src/prompt-templates 之上，同名时内置优先）。
   * 交给 SDK `additionalPromptTemplatePaths`，`session.prompt("/<name>")` 自动展开。
   */
  extraPromptTemplatePaths?: string[];
  /**
   * 是否加载包内置的**示例**知识库（`about.md`）。默认 true。
   *
   * `extraKnowledgeDirs` 是叠加不是替换，且内置目录排在最前、同名时内置优先——
   * 也就是说业务方**没有任何办法**把内置示例文档从系统提示词里去掉，只能靠这个开关。
   * 嵌入别人已有服务时通常应当传 false：那份文档介绍的是 pi-starter 自己，
   * 留在业务 Agent 的提示词里既是噪声，也会让模型去检索无关内容。
   */
  builtinKnowledge?: boolean;
  /**
   * 是否加载包内置的**示例**技能（`summarize`）。默认 true。同样只有这个开关能关掉它。
   *
   * 与知识库不同，这里必须同时从交给 SDK 的 `additionalSkillPaths` 里去掉，
   * 否则 SDK 仍会把技能目录写进 `<available_skills>`，出现「清单里没有、提示词里有」的漂移。
   */
  builtinSkills?: boolean;
  /**
   * 是否加载包内置的**示例**提示词模板（`review`）。默认 true。同样只有这个开关能关掉它。
   *
   * 与技能一致：关掉时必须同时从交给 SDK 的 `additionalPromptTemplatePaths` 里去掉，
   * 否则 SDK 仍会把模板登记到可展开的斜杠命令清单里。
   */
  builtinPromptTemplates?: boolean;
  /** sqlite 路径。默认 :memory:，也读 PI_DATABASE_PATH */
  databasePath?: string;
  /** 注入已打开的数据库。传了就不再 openScaffoldDatabase */
  database?: DatabaseStore;
  /** 内置编码工具档位。不传则走 .env / 默认 off */
  builtinTools?: BuiltinToolMode | string;
}

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

/**
 * 选一个 SessionManager：内存 / 新建落盘 / 打开已有文件。
 *
 * 打开已有文件的唯一出口在这里：先 `assertSessionFileAllowed`，再 `SessionManager.open`。
 * 内存会话不能恢复——静默忽略 `resumeFrom` 会让「已经接上恢复」变成空会话。
 */
export function resolveSessionManager(
  inMemory: boolean | undefined,
  sessionDir: string | undefined,
  resumeFrom: string | undefined,
  allowedRoots: readonly string[],
): SessionManager {
  if (resumeFrom) {
    if (inMemory) throw badRequest("内存会话不能恢复磁盘文件");
    assertSessionFileAllowed(resumeFrom, allowedRoots);
    return SessionManager.open(resumeFrom, sessionDir);
  }
  if (inMemory) return SessionManager.inMemory();
  return SessionManager.create(process.cwd(), sessionDir);
}

/** 组装完成后的结果 */
export interface BuiltAgent {
  session: AgentSession;
  /**
   * The live active model.
   *
   * A getter, not a snapshot: `switchModel()` mutates the underlying session, and a frozen
   * copy would keep reporting the pre-switch model to `/info`, `/health` and any library
   * consumer that reads `agent.model`.
   */
  readonly model: Model<any>;
  builtinTools: BuiltinToolMode;
  skills: LoadedSkill[];
  knowledge: KnowledgeDoc[];
  /** 已加载的提示词模板清单（名称/说明/正文），供 /prompt-templates 与 capabilities 展示。 */
  promptTemplates: LoadedPromptTemplate[];
  database: DatabaseStore;
  /** 当前已配好 Key、可以切过去的模型 */
  listModels(): Promise<Model<any>[]>;
  /**
   * 运行中切换模型，不重建会话。
   * ref 支持 provider/modelId，也支持唯一的裸 modelId。
   *
   * Only affects the shared `session`. Multi-conversation servers should route switches
   * through `SessionHub.setModel()` instead so every conversation stays consistent.
   */
  switchModel(ref: string): Promise<Model<any>>;
  /**
   * 新建一套独立的 session（每个对话一个 runtime），供多对话并发使用。
   * 每次调用都会重建 loader，保证对话之间不共享可变状态。
   * 可选：缺席时 Web 端自动降级为单对话模式（复用 `session`）。
   */
  createSession?(opts?: { resumeFrom?: string }): Promise<AgentSession>;
  /**
   * 换掉某个 provider 运行时使用的 API Key。
   *
   * 走 SDK 的 `ModelRuntime.setRuntimeApiKey()`：它会同时更新凭据与「已配置 provider」
   * 快照，所以随后的 `listModels()` / `switchModel()` 立刻看到新 key 对应的可用模型，
   * 不需要重建 ModelRuntime。原始 key 只在这里出现一次，调用方不要往日志里打。
   */
  applyApiKey?(provider: string, apiKey: string): Promise<void>;
  dispose(): void;
}

/**
 * 把零件组装成一个可用的 AgentSession。
 * 拿到的 session 提供三个方法：
 *   prompt(text)      → 阻塞式发消息，跑完一轮 ReAct 后 resolve
 *   subscribe(cb)     → 订阅事件（打字机效果、工具卡片都靠它）
 *   abort()           → 中断当前这轮 prompt
 */
export async function buildAgent(options: BuildAgentOptions = {}): Promise<BuiltAgent> {
  const cfg = loadConfig({
    provider: options.provider,
    modelId: options.modelId,
    builtinTools: options.builtinTools,
  });
  requireConfiguredModel(cfg);

  const modelRuntime = await ModelRuntime.create();
  const available = await modelRuntime.getAvailable();
  if (available.length === 0) {
    throw new Error(`No available model. ${SETUP_HINT}`);
  }

  const picked = resolveModelRef({ provider: cfg.provider, model: cfg.modelId }, available);
  if (!picked?.model) {
    throw new Error(
      `Model ${cfg.provider}/${cfg.modelId} not found. Available:\n${formatModelChoices(available)}\n  ${SETUP_HINT}`,
    );
  }
  const model = picked.model;

  // Same filter for both the SDK's paths and our own inventory, so `/skills` can never
  // disagree with what the system prompt actually carries. Surfaces what was dropped —
  // a silently missing skill is far harder to debug than a noisy log line.
  const skillOptions = {
    includeBuiltin: options.builtinSkills,
    onSkip: (skillDir: string, reason: string) => {
      getLogger().warn("技能已跳过", { skillDir, reason });
    },
  };
  const skillPaths = resolveSkillPaths(options.extraSkillPaths, skillOptions);
  const skills = loadScaffoldSkills(options.extraSkillPaths, skillOptions);
  const knowledge = loadScaffoldKnowledge(options.extraKnowledgeDirs, {
    includeBuiltin: options.builtinKnowledge,
  });
  // Prompt templates follow the same isolation rule as skills/extensions: the loader never
  // scans ~/.pi (noPromptTemplates), only repo + injected paths go through additionalPromptTemplatePaths.
  const promptTemplatePaths = resolvePromptTemplatePaths(options.extraPromptTemplatePaths ?? [], {
    includeBuiltin: options.builtinPromptTemplates,
    onSkip: (file, reason) => {
      getLogger().warn("提示词模板已跳过", { file, reason });
    },
  });
  const promptTemplates = loadScaffoldPromptTemplates(promptTemplatePaths);
  const database =
    options.database ??
    openScaffoldDatabase({
      path: options.databasePath?.trim() || process.env.PI_DATABASE_PATH?.trim() || undefined,
    });

  const knowledgeCatalog = formatKnowledgeCatalog(knowledge);
  const layers: PromptLayers = {
    persona: "",
    rules: "",
    knowledge: knowledgeCatalog || undefined,
    cwd: process.cwd(),
    skills: formatSkillCatalog(skills),
    append: options.promptAppend,
  };

  let systemPrompt = options.systemPrompt;
  if (!systemPrompt) {
    const promptsDir = resolvePromptsDir();
    const [persona, rules] = await Promise.all([
      readFile(join(promptsDir, "persona.md"), "utf-8"),
      readFile(join(promptsDir, "rules.md"), "utf-8"),
    ]);
    layers.persona = persona;
    layers.rules = rules;
    // Route the default path through the composer so `settings.promptTemplate` is honoured.
    // With no template this renders exactly `persona + rules + knowledge` (empty layers are
    // dropped), i.e. the previous hardcoded concatenation — no behaviour change by default.
    systemPrompt = renderSystemPrompt(options.promptTemplate, layers);
  } else if (knowledgeCatalog) {
    // Caller-supplied prompts stay verbatim; only append the knowledge catalog as before.
    systemPrompt = `${systemPrompt}\n\n${knowledgeCatalog}`;
  }

  const dynamicTools = [
    ...(knowledge.length > 0
      ? [createSearchKnowledgeTool(knowledge), createReadKnowledgeTool(knowledge)]
      : []),
    createDbStatusTool(database),
    createDbQueryTool(database),
  ];

  /**
   * 每个会话各自的工具清单。
   *
   * 刻意在 `createSession` **内部**求值：`createAgentSession` 的 `tools` 会变成 SDK 的
   * `allowedToolNames` 硬白名单，构造之后无法增补。所以运行期新增的工具（MCP）
   * 只能从下一次建会话起生效——白名单必须按会话重算，不能在build 的时候算一次存起来。
   */
  // shell 只在 coding 档出现。环境是进程级的一份：后台任务不跟某一次会话一起死，
  // 但整个 Agent dispose 时要一起杀掉，否则停机后还留着子进程。
  const execEnv =
    cfg.builtinTools === "coding" ? new ExecEnvironment({ workspace: process.cwd() }) : undefined;

  const resolveToolList = (): ToolDefinition[] => {
    const live = options.dynamicTools?.() ?? [];
    const execTools = execToolsForMode(cfg.builtinTools, execEnv);
    return [...allTools, ...dynamicTools, ...execTools, ...live, ...(options.extraTools ?? [])];
  };

  /** Build a fresh resource loader (one per session, so conversations stay isolated). */
  const buildLoader = async (toolList: readonly ToolDefinition[]): Promise<DefaultResourceLoader> => {
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      additionalSkillPaths: skillPaths,
      additionalPromptTemplatePaths: promptTemplatePaths,
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
      extensionFactories: [
        (pi) => {
          for (const tool of toolList) pi.registerTool(tool);
        },
        ...allExtensions,
        ...(options.extraExtensions ?? []),
      ],
    });
    await loader.reload();
    return loader;
  };

  /**
   * 造一个会话工厂。
   *
   * `resumeFrom` 让调用方（SessionHub）能把「磁盘上的某个会话文件」接回来——这是重启后
   * 恢复对话的唯一途径：`createAgentSession` 只认 `sessionManager`，而只有
   * `SessionManager.open(path)` 会把历史消息、模型与 thinkingLevel 一并恢复。
   * 路径校验在 `resolveSessionManager` 里，不在调用方的注释里。
   */
  const createSession = async (opts?: { resumeFrom?: string }): Promise<AgentSession> => {
    const toolList = resolveToolList();
    const toolPolicy = sessionToolPolicy(
      cfg.builtinTools,
      toolList.map((tool) => tool.name),
    );
    const loader = await buildLoader(toolList);
    const sessionManager = resolveSessionManager(
      options.inMemory,
      options.sessionDir,
      opts?.resumeFrom,
      options.allowedSessionRoots ?? [],
    );
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      model,
      modelRuntime,
      resourceLoader: loader,
      sessionManager,
      ...toolPolicy,
    });
    return session;
  };

  const session = await createSession(
    options.resumeFrom ? { resumeFrom: options.resumeFrom } : undefined,
  );

  /**
   * Single source of truth for "which model is active".
   *
   * This used to be a frozen `model` field captured at build time, so after any
   * `switchModel()` the exported object still reported the ORIGINAL model — `/info` and
   * `/health` would advertise a model the agent was no longer using. Making it a getter
   * removes the class of bug entirely: there is no longer a value that can go stale.
   */
  const currentModel = (): Model<any> => session.model ?? model;

  return {
    session,
    /**
     * The live model. Prefer this over any cached copy; it reflects `switchModel()`
     * immediately.
     */
    get model() {
      return currentModel();
    },
    builtinTools: cfg.builtinTools,
    skills,
    knowledge,
    promptTemplates,
    database,
    listModels: async () => [...(await modelRuntime.getAvailable())],
    switchModel: async (ref) => {
      const choices = await modelRuntime.getAvailable();
      const next = resolveModelRef({ model: ref }, choices);
      if (!next?.model) throw unknownModelError({ model: ref }, choices);
      await session.setModel(next.model);
      return next.model;
    },
    createSession,
    applyApiKey: async (provider, apiKey) => {
      await modelRuntime.setRuntimeApiKey(provider, apiKey);
    },
    dispose: () => {
      session.dispose();
      execEnv?.dispose();
      database.close();
    },
  };
}

/** 已配好 Key 的模型（供 /models 和 Web 列目录用） */
export async function listModels(): Promise<Model<any>[]> {
  const modelRuntime = await ModelRuntime.create();
  return [...(await modelRuntime.getAvailable())];
}
