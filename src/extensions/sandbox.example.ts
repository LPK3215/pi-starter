/**
 * 官方姿势的"工具路由/沙箱"扩展示例（默认不接线）
 *
 * 官方 SDK 的隔离主张写在 docs/containerization.md：Pi 默认全权限，隔离靠
 *   (a) 把整个进程塞进 Docker / Gondolin micro-VM / OpenShell，或
 *   (b) 用 examples/extensions/{gondolin,sandbox} 那种扩展，把内置工具（read/write/edit/
 *       bash/grep/find/ls）用 `pi.registerTool` **覆盖**掉，让执行改在隔离环境里跑。
 *
 * 这个文件演示的就是 (b) 的**机制**：覆盖 `bash`，把命令路由出宿主。默认实现是**拒绝宿主执行**
 * （安全兜底），真实接容器时把 `routeCommand` 换成 `docker exec ...` / VM RPC 即可——路由目标
 * 由你的部署决定，这里不替你猜。
 *
 * 它是**示例**，不进 `allExtensions`；要开：`buildAgent({ extraExtensions: [sandboxRoutingExample] })`
 * 且通常配合把进程跑在 Docker 里（见 docs/能力与边界.md 的"隔离"节）。
 * 注意：这不是把 guard 换掉——guard 仍是默认软闸门；本例是"能跑隔离时"的硬边界写法。
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 把命令送到隔离环境的落点。示例里拒绝宿主执行；接 Docker/Gondolin 时替换此函数。 */
async function routeCommand(_command: string): Promise<{ text: string; isError: boolean }> {
  return {
    text: "宿主 shell 已被沙箱路由拦截：请把进程跑在容器/VM 里，或实现 routeCommand() 送到 docker exec / VM RPC。",
    isError: true,
  };
}

export function sandboxRoutingExample(pi: ExtensionAPI): void {
  // 覆盖内置 bash：同名工具会替换 SDK 的内置实现（官方 override 机制）。
  pi.registerTool(
    defineTool({
      name: "bash",
      label: "Bash (sandbox-routed)",
      description: "Execute a shell command inside the isolated environment (never on the host).",
      parameters: Type.Object({ command: Type.String({ description: "Shell command" }) }),
      async execute(_id, params: { command: string }) {
        const result = await routeCommand(params.command);
        return {
          content: [{ type: "text", text: result.text }],
          details: { routed: true, isError: result.isError },
          isError: result.isError,
        };
      },
    }),
  );
}
