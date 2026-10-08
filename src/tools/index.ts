/**
 * pi-starter · 工具层
 *
 * 静态工具在这里登记成 allTools。依赖运行时资源的工具（知识库、数据库）
 * 由 agent.ts 按扫描 / 连接结果装配，不要写进这个数组。
 * exec / exec_jobs / exec_stop 也不在这里：allTools 三档都会进白名单，
 * shell 只跟 coding 走，由 execToolsForMode 装配。
 *
 * 新增一个静态工具 = 三个动作：
 *   1. 在 src/tools/ 下新建一个文件（如 my-tool.ts）
 *   2. 用 defineTool() 定义工具（name / description / parameters / execute）
 *   3. 在下方 import 并加入 allTools 数组
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { currentTimeTool } from "./current-time.js";

/** 脚手架静态工具清单：新工具往这里加 */
export const allTools: ToolDefinition[] = [
  currentTimeTool,
];
