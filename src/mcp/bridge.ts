/**
 * pi-starter · MCP 工具桥
 *
 * 把外部 stdio MCP 服务器的工具接进 Agent 会话，并让**改配置即生效**。
 *
 * 「热生效」在这里的确切含义（不要含糊）：
 *   - 配置一改，桥立刻 diff：新增的服务器拉起来、删掉的断掉、命令/参数变了的重连；
 *   - 子进程与工具目录同步更新，能力目录、`set_tool_enabled` 立刻反映最新集合；
 *   - **新建的会话**立即带上新工具。
 *   - 已经打开的会话**不会**凭空多出新工具：`createAgentSession` 的工具白名单
 *     （`tools` → `allowedToolNames`）在构造时固定，`_refreshToolRegistry()` 会把
 *     不在白名单里的名字整个滤掉，而 SDK 没有提供改写它的公开方法。重开该对话
 *     （`open_conversation`）会走一遍新的会话工厂，白名单重算，工具随即可用。
 *     这是 SDK 的硬约束，不是本模块偷懒——所以工具的白名单按会话重算而不是全局算一次。
 *
 * 三条硬约束：
 *   1. **工具名必须带服务器前缀**（`mcp__<server>__<tool>`）。两个服务器都叫 `search`
 *      时，不加前缀就是后注册的悄悄覆盖先注册的——而工具目录不会告诉你发生了什么。
 *   2. **子进程生命周期归 `addDisposer`**。忘记回收 = 每次热重载泄漏一批 stdio 子进程，
 *      而它们在父进程退出后仍然活着。
 *   3. **一个服务器连不上不许影响别人**。握手失败只把这一条标成不可用，其余照常接入。
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLogger } from "../log.js";
import { defineToolSpec, type ToolRegistry } from "../tools/registry.js";
import type { McpServerConfig } from "../settings.js";
import { McpClient, type SpawnFn } from "./client.js";

/** 运行期某个 MCP 服务器的状态（对外只暴露这个，不暴露子进程）。 */
export interface McpServerStatus {
  name: string;
  ready: boolean;
  toolCount: number;
  /** 失败原因（未失败为 undefined）。已剔除凭据类内容：这里只放服务器自己说的话。 */
  error?: string;
}

export interface McpBridgeOptions {
  /** 当前配置。每次 sync 都重读，因此改设置后无需重建桥。 */
  servers: () => readonly McpServerConfig[];
  registry: ToolRegistry;
  /** 进程拉起方式（测试注入替身）。 */
  spawn?: SpawnFn;
  /** 集合变化时回调，用于推送 WS notice / 刷新能力目录。 */
  onChange?: (status: McpServerStatus[]) => void;
  /** 单次 JSON-RPC 请求超时（ms）。 */
  requestTimeoutMs?: number;
}

interface Connected {
  client: McpClient;
  tools: Map<string, McpToolDescriptorWithName>;
  /** 去掉前缀后的工具名 → 注册表里的全名。 */
  byRemote: Map<string, string>;
  signature: string;
}

interface McpToolDescriptorWithName {
  /** 注册表 / LLM 看到的全名（`mcp__server__tool`）。 */
  name: string;
  description: string;
  schema: Record<string, unknown> | undefined;
}

const TOOL_PREFIX = "mcp__";

/** 工具名非法字符统一替换，避免 MCP 侧的名字把我们的标识符语法弄坏。 */
function sanitizeName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * 配置指纹：命令/参数/env/cwd 任一变化都要重连。
 * 不比较「工具列表」是因为服务器可能启动慢——先按配置判断，再握手。
 */
function signatureOf(server: McpServerConfig): string {
  return JSON.stringify([server.command, server.args ?? [], server.env ?? {}, server.cwd ?? ""]);
}

/**
 * 把 MCP 的 JSON Schema 转成本项目工具定义能用的 TypeBox schema。
 *
 * 只支持 object 顶层的常见关键字（其余一律放开）：MCP 服务器的 schema 风格不统一，
 * 而在这里写一个完整的 JSON-Schema→TypeBox 转换器，收益远小于它带来的新 bug 面。
 * 转换失败时退化成「接受任意参数」，宁可少校验，也不要让一个工具凭空不可用。
 */
function toParameters(schema: Record<string, unknown> | undefined) {
  const properties = schema?.properties;
  const required = new Set(
    Array.isArray(schema?.required) ? (schema.required as unknown[]).filter((v) => typeof v === "string") : [],
  );
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return Type.Object({}, { additionalProperties: true });
  }
  const shape: Record<string, ReturnType<typeof Type.Optional<any>>> = {};
  for (const [key, raw] of Object.entries(properties as Record<string, unknown>)) {
    const field = jsonSchemaToTypeBox(raw);
    shape[key] = required.has(key) ? field : Type.Optional(field);
  }
  return Type.Object(shape, { additionalProperties: true });
}

function jsonSchemaToTypeBox(raw: unknown): any {
  const node = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const type = typeof node.type === "string" ? node.type : undefined;
  const description = typeof node.description === "string" ? node.description : undefined;
  const enumValues = Array.isArray(node.enum) ? node.enum.filter((v) => typeof v === "string") : [];
  if (enumValues.length > 0) {
    return Type.Union(enumValues.map((value) => Type.Literal(value as string)), {
      ...(description ? { description } : {}),
    });
  }
  switch (type) {
    case "string":
      return Type.String(description ? { description } : {});
    case "number":
      return Type.Number(description ? { description } : {});
    case "integer":
      return Type.Integer(description ? { description } : {});
    case "boolean":
      return Type.Boolean(description ? { description } : {});
    case "array":
      return Type.Array(jsonSchemaToTypeBox(node.items), description ? { description } : {});
    case "object":
      return toParameters(node as Record<string, unknown>);
    default:
      // 没写 type 的 schema 不猜：全放行总比错判类型导致工具永远调不通要好。
      return Type.Unknown(description ? { description } : {});
  }
}

export class McpBridge {
  private readonly connected = new Map<string, Connected>();
  private readonly errors = new Map<string, string>();
  private disposed = false;
  /** 正在进行的 sync：并发调用共用同一轮，避免两次 diff 拉起两个子进程。 */
  private inflight: Promise<McpServerStatus[]> | undefined;

  constructor(private readonly options: McpBridgeOptions) {}

  /** 当前各服务器状态。 */
  status(): McpServerStatus[] {
    return [...this.connected.keys(), ...this.errors.keys()].map((name) => {
      const entry = this.connected.get(name);
      const error = this.errors.get(name);
      return {
        name,
        ready: entry !== undefined,
        toolCount: entry?.tools.size ?? 0,
        ...(error ? { error } : {}),
      };
    });
  }

  /**
   * 会话创建时由 agent 工厂调用：返回当前全部 MCP 工具定义。
   *
   * 注意返回的是**当时的快照**——SDK 在构造会话时就把工具白名单固定了，
   * 之后再改配置不会追溯影响这个会话（见文件头「热生效」说明）。
   */
  toolDefinitions(): ToolDefinition[] {
    if (this.disposed) return [];
    const out: ToolDefinition[] = [];
    for (const entry of this.connected.values()) {
      for (const tool of entry.tools.values()) out.push(this.toToolDefinition(tool, entry));
    }
    return out;
  }

  /** 依配置重算连接集合。可并发调用；同一时刻只会有一轮真正执行。 */
  async sync(): Promise<McpServerStatus[]> {
    if (this.disposed) return [];
    if (this.inflight) return this.inflight;
    this.inflight = this.runSync().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async runSync(): Promise<McpServerStatus[]> {
    const log = getLogger().child({ component: "mcp" });
    const wanted = new Map<string, McpServerConfig>();
    for (const server of this.options.servers()) {
      // 同名后写的覆盖先写的（配置校验已保证落盘时无重复，这里只是防御）。
      wanted.set(server.name, server);
    }

    // 1. 摘掉不再需要 / 配置已变的连接。
    for (const [name, entry] of [...this.connected]) {
      const server = wanted.get(name);
      if (server && signatureOf(server) === entry.signature) {
        wanted.delete(name);
        continue;
      }
      this.disconnect(name);
    }

    // 2. 拉起新增 / 变更的连接。一条失败不影响其余。
    for (const [name, server] of wanted) {
      try {
        await this.connect(server);
        this.errors.delete(name);
      } catch (err) {
        this.errors.set(name, err instanceof Error ? err.message : String(err));
        log.warn("MCP 服务器接入失败", { server: name, error: this.errors.get(name) });
        this.options.onChange?.(this.status());
      }
    }

    const status = this.status();
    log.info("MCP 服务器已同步", {
      servers: status.map((item) => `${item.name}:${item.ready ? `${item.toolCount}tools` : "failed"}`),
    });
    this.options.onChange?.(status);
    return status;
  }

  private async connect(server: McpServerConfig): Promise<void> {
    const log = getLogger().child({ component: "mcp" });
    const client = new McpClient({
      command: server.command,
      args: server.args ?? [],
      env: server.env,
      cwd: server.cwd,
      requestTimeoutMs: this.options.requestTimeoutMs,
    });
    try {
      if (this.options.spawn) client.start(this.options.spawn);
      else await client.start();
    } catch (err) {
      client.dispose();
      throw new Error(
        `${server.name}: ${err instanceof Error ? err.message : String(err)}` +
          (client.stderrTail.length > 0 ? ` (stderr: ${client.stderrTail.at(-1)})` : ""),
      );
    }

    let descriptors;
    try {
      descriptors = await client.listTools();
    } catch (err) {
      client.dispose();
      throw new Error(`${server.name}: tools/list 失败（${err instanceof Error ? err.message : String(err)}）`);
    }

    const tools = new Map<string, McpToolDescriptorWithName>();
    const byRemote = new Map<string, string>();
    for (const descriptor of descriptors) {
      const remote = sanitizeName(descriptor.name);
      const full = `${TOOL_PREFIX}${sanitizeName(server.name)}__${remote}`;
      if (tools.has(full)) {
        // 同一个服务器报了两个同名工具（规范化后撞名）：只取第一个，并说清楚。
        log.warn("MCP 工具名冲突，已忽略后者", { server: server.name, tool: descriptor.name });
        continue;
      }
      tools.set(full, {
        name: full,
        description: descriptor.description ?? `${server.name} 提供的工具 ${descriptor.name}`,
        schema: descriptor.inputSchema,
      });
      byRemote.set(descriptor.name, full);
    }

    this.connected.set(server.name, {
      client,
      tools,
      byRemote,
      signature: signatureOf(server),
    });

    for (const tool of tools.values()) {
      this.options.registry.register(
        defineToolSpec({
          name: tool.name,
          description: tool.description,
          source: "dynamic",
          // MCP 工具的破坏性完全取决于远端实现，本地无法判定，按最保守的等级登记。
          capabilities: ["mcp", "net"],
          risk: "high",
          origin: `mcp:${server.name}`,
        }),
      );
    }
    log.info("MCP 服务器已接入", { server: server.name, tools: [...tools.keys()] });
  }

  private disconnect(name: string): void {
    const entry = this.connected.get(name);
    if (!entry) return;
    this.connected.delete(name);
    this.errors.delete(name);
    // 工具先摘掉再杀进程：反过来会出现「目录里还有工具，但调过去必然连不上」的窗口。
    this.options.registry.unregisterWhere((spec) => spec.origin === `mcp:${name}`);
    entry.client.dispose();
  }

  /** 停机：断掉全部子进程并清空工具。必须由调用方挂到 `addDisposer`。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const name of [...this.connected.keys()]) this.disconnect(name);
    this.errors.clear();
  }

  /** 把一条 MCP 工具描述转成本项目的 ToolDefinition。 */
  private toToolDefinition(tool: McpToolDescriptorWithName, entry: Connected): ToolDefinition {
    const remoteFor = (full: string): string | undefined => {
      for (const [remote, name] of entry.byRemote) if (name === full) return remote;
      return undefined;
    };
    return defineTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: toParameters(tool.schema),
      async execute(_id, params) {
        const remote = remoteFor(tool.name);
        if (!remote) throw new Error(`MCP 工具 ${tool.name} 已不在当前连接中`);
        if (!entry.client.isReady) {
          throw new Error(`MCP 服务器不可用（${entry.client.failure ?? "尚未就绪"}），请检查配置后重试`);
        }
        const result = await entry.client.callTool(remote, (params ?? {}) as Record<string, unknown>);
        return {
          content: [{ type: "text", text: result.text || "(空结果)" }],
          details: { server: tool.name, isError: result.isError },
        };
      },
    });
  }
}