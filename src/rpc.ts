/**
 * pi-starter · 官方 RPC 模式入口（`runRpcMode`，stdio JSONL）
 *
 * 用途：把 pi-starter 当 agent 后端，用 stdin/stdout 的 JSONL 协议驱动——适合跨语言 /
 * 子进程集成（另一门语言或工具不想走 HTTP/WS）。协议见 SDK 的 `docs/rpc.md`。
 *
 * 定位（与现有通道的分工）：
 *   - REST/SSE：语言无关的 HTTP 接口；
 *   - WebSocket：产品化前端（打字机、工具卡、审批、多对话）；
 *   - RPC：同一进程/子进程里、按官方 JSONL 协议逐行收发的轻量集成面。
 *   三者共用 `buildAgent` 的同一装配核心，不会在人设 / 工具白名单 / 隔离上分叉。
 *
 * 边界：RPC 是**单会话** stdio 入口，不携带 server 层的 MCP 桥与 HTTP 审批闸门；
 * 需要那些请用 `npm run web`。
 */

import {
  createAgentSessionRuntime,
  getAgentDir,
  runRpcMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { buildAgent, type BuildAgentOptions } from "./agent.js";

/**
 * 组装 Agent 并进入官方 RPC 模式（阻塞直到 stdin 关闭）。
 * 复用 `buildAgent` 的运行时工厂，保证与 REST/WS 一致的隔离与人设。
 */
export async function startRpcMode(options: BuildAgentOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const agent = await buildAgent(options);
  try {
    const factory = agent.createRuntimeFactory?.();
    if (!factory) {
      throw new Error("当前装配不支持 RPC 运行时（需要 buildAgent 提供的 createRuntimeFactory）");
    }
    const runtime = await createAgentSessionRuntime(factory, {
      cwd,
      agentDir: getAgentDir(),
      sessionManager: SessionManager.create(cwd),
    });
    await runRpcMode(runtime);
  } finally {
    agent.dispose();
  }
}
