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
import { allTools } from "./tools/index.js";
import { allExtensions, type ExtensionFactory } from "./extensions/index.js";
import { loadScaffoldSkills, resolveSkillPaths, type LoadedSkill } from "./skills/index.js";
import { formatKnowledgeCatalog, loadScaffoldKnowledge, type KnowledgeDoc } from "./knowledge/index.js";
import { openScaffoldDatabase, type DatabaseStore } from "./db/index.js";
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
    throw new Error(`找不到 prompts/persona.md（试过 ${candidates.join("、")}）`);
  }
  return found;
}

/** 组装 Agent 的配置选项 */
export interface BuildAgentOptions {
  /** 指定 provider（如 modelscope / zhipu），不传则读 .env 的 PI_PROVIDER */
  provider?: string;
  /** 指定模型 id，不传则读 .env 的 PI_MODEL。两者都缺会直接抛，不会落到 huggingface */
  modelId?: string;
  /** 系统提示词：默认读取 prompts/ 目录下的 persona + rules */
  systemPrompt?: string;
  /** 是否使用内存会话（Web 场景推荐；CLI 可落盘） */
  inMemory?: boolean;
  /** 注入额外工具（叠在 src/tools 登记的工具之上） */
  extraTools?: ToolDefinition[];
  /** 注入额外扩展（叠在 src/extensions 登记的钩子之上，排在 guard / audit 后面） */
  extraExtensions?: ExtensionFactory[];
  /** 额外技能目录（叠在 src/skills 之上，同名时仓库内置优先）。交给 SDK additionalSkillPaths */
  extraSkillPaths?: string[];
  /** 额外知识库目录（叠在 src/knowledge 之上，同名时仓库内置优先） */
  extraKnowledgeDirs?: string[];
  /** sqlite 路径。默认 :memory:，也读 PI_DATABASE_PATH */
  databasePath?: string;
  /** 注入已打开的数据库。传了就不再 openScaffoldDatabase */
  database?: DatabaseStore;
  /** 内置编码工具档位。不传则走 .env / 默认 off */
  builtinTools?: BuiltinToolMode | string;
}

/** 组装完成后的结果 */
export interface BuiltAgent {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  model: Model<any>;
  builtinTools: BuiltinToolMode;
  skills: LoadedSkill[];
  knowledge: KnowledgeDoc[];
  database: DatabaseStore;
  /** 当前已配好 Key、可以切过去的模型 */
  listModels(): Promise<Model<any>[]>;
  /**
   * 运行中切换模型，不重建会话。
   * ref 支持 provider/modelId，也支持唯一的裸 modelId。
   */
  switchModel(ref: string): Promise<Model<any>>;
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
    throw new Error(`没有可用模型。${SETUP_HINT}`);
  }

  const picked = resolveModelRef({ provider: cfg.provider, model: cfg.modelId }, available);
  if (!picked?.model) {
    throw new Error(
      `找不到模型 ${cfg.provider}/${cfg.modelId}。可用的是：\n${formatModelChoices(available)}\n  ${SETUP_HINT}`,
    );
  }
  const model = picked.model;

  const skillPaths = resolveSkillPaths(options.extraSkillPaths);
  const skills = loadScaffoldSkills(options.extraSkillPaths);
  const knowledge = loadScaffoldKnowledge(options.extraKnowledgeDirs);
  const database =
    options.database ??
    openScaffoldDatabase({
      path: options.databasePath?.trim() || process.env.PI_DATABASE_PATH?.trim() || undefined,
    });

  let systemPrompt = options.systemPrompt;
  if (!systemPrompt) {
    const promptsDir = resolvePromptsDir();
    const [persona, rules] = await Promise.all([
      readFile(join(promptsDir, "persona.md"), "utf-8"),
      readFile(join(promptsDir, "rules.md"), "utf-8"),
    ]);
    systemPrompt = `${persona}\n\n${rules}`;
  }
  const knowledgeCatalog = formatKnowledgeCatalog(knowledge);
  if (knowledgeCatalog) systemPrompt = `${systemPrompt}\n\n${knowledgeCatalog}`;

  const dynamicTools = [
    ...(knowledge.length > 0
      ? [createSearchKnowledgeTool(knowledge), createReadKnowledgeTool(knowledge)]
      : []),
    createDbStatusTool(database),
    createDbQueryTool(database),
  ];
  const allToolList = [...allTools, ...dynamicTools, ...(options.extraTools ?? [])];

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    additionalSkillPaths: skillPaths,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [
      (pi) => {
        for (const tool of allToolList) pi.registerTool(tool);
      },
      ...allExtensions,
      ...(options.extraExtensions ?? []),
    ],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: options.inMemory
      ? SessionManager.inMemory()
      : SessionManager.create(process.cwd()),
    ...sessionToolPolicy(
      cfg.builtinTools,
      allToolList.map((tool) => tool.name),
    ),
  });

  return {
    session,
    model,
    builtinTools: cfg.builtinTools,
    skills,
    knowledge,
    database,
    listModels: async () => [...(await modelRuntime.getAvailable())],
    switchModel: async (ref) => {
      const choices = await modelRuntime.getAvailable();
      const next = resolveModelRef({ model: ref }, choices);
      if (!next?.model) throw unknownModelError({ model: ref }, choices);
      await session.setModel(next.model);
      return next.model;
    },
    dispose: () => {
      session.dispose();
      database.close();
    },
  };
}

/** 已配好 Key 的模型（供 /models 和 Web 列目录用） */
export async function listModels(): Promise<Model<any>[]> {
  const modelRuntime = await ModelRuntime.create();
  return [...(await modelRuntime.getAvailable())];
}
