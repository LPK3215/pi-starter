/**
 * pi-starter · CLI 入口（交互模式）
 *
 * 运行：npm run dev
 * 效果：终端里跟 Agent 对话，流式输出，支持换行发送。
 * 退出：输入 exit 或按 Ctrl+C。
 *
 * 可选参数：
 *   npm run dev -- --provider zhipu --model glm-4.5-air
 *   npm run dev -- --builtin-tools coding
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { buildAgent } from "./agent.js";
import { parseCliFlags } from "./cli-args.js";
import { describeBuiltinToolMode } from "./config.js";
import { toolResultPreview } from "./sse.js";

const flags = parseCliFlags(process.argv.slice(2));

console.log("🔧 正在组装 Agent...");
const {
  session,
  model,
  builtinTools: toolMode,
  switchModel,
  listModels,
  skills,
  knowledge,
  database,
  dispose,
} = await buildAgent({
  provider: flags.provider,
  modelId: flags.model,
  builtinTools: flags.builtinTools,
  inMemory: false, // CLI 场景允许落盘，多轮对话可持久化
});
let currentModel = model;
console.log(`✅ 就绪。模型：${currentModel.provider}/${currentModel.id}`);
console.log(`   内置工具：${toolMode}（${describeBuiltinToolMode(toolMode)}）`);
console.log(`   技能：${skills.map((s) => s.name).join("、") || "无"}`);
console.log(`   知识库：${knowledge.map((d) => d.name).join("、") || "无"}`);
console.log(`   数据库：${database.driver} ${database.path}`);
console.log("   /models 查看可切换模型，/model <provider>/<modelId> 切换\n");

session.subscribe((event: AgentSessionEvent) => {
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    stdout.write(event.assistantMessageEvent.delta);
  } else if (event.type === "tool_execution_start") {
    console.log(`\n  🔧 调用工具：${event.toolName}`);
  } else if (event.type === "tool_execution_end") {
    const mark = event.isError ? "❌" : "✅";
    const preview = toolResultPreview(event.result, 120);
    console.log(`  ${mark} ${event.toolName}${preview ? " " + preview : ""}`);
  }
});

const rl = createInterface({ input: stdin, output: stdout });

console.log("💬 输入你的问题（exit 退出）：\n");
try {
  while (true) {
    let line: string;
    try {
      line = await rl.question("你 > ");
    } catch (err: unknown) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined;
      if (code === "ERR_USE_AFTER_CLOSE") break;
      throw err;
    }
    const text = line.trim();
    if (!text) continue;
    if (text.toLowerCase() === "exit") break;

    if (text === "/models" || text === "/model") {
      const choices = await listModels();
      console.log(choices.length === 0 ? "（没有已配置 Key 的模型）" : "");
      for (const choice of choices) {
        const mark = choice.provider === currentModel.provider && choice.id === currentModel.id ? "← 当前" : "";
        console.log(`  ${choice.provider}/${choice.id} ${mark}`.trimEnd());
      }
      console.log("");
      continue;
    }

    if (text.toLowerCase().startsWith("/model ")) {
      const ref = text.slice("/model ".length).trim();
      try {
        currentModel = await switchModel(ref);
        console.log(`✅ 已切换到 ${currentModel.provider}/${currentModel.id}\n`);
      } catch (err: unknown) {
        console.error(`❌ ${err instanceof Error ? err.message : String(err)}\n`);
      }
      continue;
    }

    process.stdout.write("🤖 ");
    try {
      await session.prompt(line);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ 出错：${message}`);
    }
    console.log("\n");
  }
} finally {
  dispose();
  rl.close();
  console.log("👋 再见");
}
