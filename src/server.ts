/**
 * pi-starter · Web 入口
 *
 * 运行：npm run web
 * 解析命令行、组装 Agent、listen。应用本身在 app.ts。
 *
 *   npm run web -- --port 8080 --model zhipu/glm-4.5-air
 *   npm run web -- --builtin-tools coding
 */

import { buildAgent } from "./agent.js";
import { createApp } from "./app.js";
import { parseCliFlags } from "./cli-args.js";
import { describeBuiltinToolMode } from "./config.js";

const flags = parseCliFlags(process.argv.slice(2));
const PORT = flags.port ?? 3000;

console.log("🔧 正在组装 Agent...");
const agent = await buildAgent({
  provider: flags.provider,
  modelId: flags.model,
  builtinTools: flags.builtinTools,
  inMemory: true,
});
console.log(`✅ 就绪。模型：${agent.model.provider}/${agent.model.id}`);
console.log(`   内置工具：${agent.builtinTools}（${describeBuiltinToolMode(agent.builtinTools)}）`);
console.log(`   技能：${agent.skills.map((s) => s.name).join("、") || "无"}`);
console.log(`   知识库：${agent.knowledge.map((d) => d.name).join("、") || "无"}`);
console.log(`   数据库：${agent.database.driver} ${agent.database.path}\n`);

const { app, dispose } = createApp({ agent });
const server = app.listen(PORT, () => {
  console.log(`\n════════ Pi Starter Web ════════`);
  console.log(`  打开浏览器：http://localhost:${PORT}`);
  console.log(`  模型：${agent.model.provider}/${agent.model.id}`);
  console.log(`  内置工具：${agent.builtinTools}（${describeBuiltinToolMode(agent.builtinTools)}）`);
  console.log(`  试试问：现在几点了？\n`);
});

function shutdown() {
  console.log("\n[Server] 正在关闭...");
  dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
