/**
 * pi-starter · MCP stdio 客户端（JSON-RPC 2.0 over newline-delimited JSON）
 *
 * **为什么要自己写**：`@earendil-works/pi-coding-agent` 不带 MCP 客户端
 * （实测 dist 内 "mcp" 只有 2 处命中，都是 highlight.min.js 里其它单词的子串），
 * 所以「接外部工具」这件事没有任何现成依赖可用。
 *
 * **为什么用 stdio 而不是 HTTP/SSE**：stdio 不占端口、不需要鉴权、子进程随宿主生死，
 * 与本项目「默认 loopback、不内置登录」的定位一致；HTTP 传输要另起服务与鉴权，是产品层的事。
 *
 * 协议只实现 Agent 真正需要的四个方法：
 *   initialize → notifications/initialized → tools/list → tools/call
 * （`ping` 留给健康检查；`resources` / `prompts` 不做——脚手架的能力面是工具。）
 *
 * 三件必须做对的事：
 *   1. **行缓冲**：对端不保证一行一条（半包 / 多包都可能），按 `\n` 切并留半截尾巴。
 *   2. **请求有超时**：子进程半死不活时 pending 必须被拒，否则一次工具调用会永久挂起。
 *   3. **子进程崩了要能看见**：`exit` 时把全部 pending 拒掉并置为不可用，
 *      而不是让调用方对着一个永远不回的 Promise 干等。stderr 只留最后几行做诊断。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getLogger } from "../log.js";
import { childProcessEnv } from "../child-env.js";

/** 一个 MCP 工具的声明（对应 MCP 的 `tools/list` 条目）。 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** JSON Schema。桥会把它转成本项目的 TypeBox/工具定义。 */
  inputSchema?: Record<string, unknown>;
}

export interface McpClientOptions {
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 单次请求超时（ms）。默认 30s。 */
  requestTimeoutMs?: number;
  /** 启动握手超时（ms）。默认 15s。 */
  startupTimeoutMs?: number;
}

/**
 * SIGTERM 之后等多久升级到 SIGKILL。
 *
 * 宽限期要够 MCP server 收尾（关连接、落盘），又不能长到把停机时间拖成秒级。
 */
const MCP_KILL_ESCALATION_MS = 2000;

/** 注入点：测试可以塞一个假进程，不真的拉子进程。 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env?: Record<string, string>; cwd?: string; stdio: ["pipe", "pipe", "pipe"] },
) => McpProcessHandle;

/** 桥接层与 `child_process` 之间的最小接口，便于测试替换。 */
export interface McpProcessHandle {
  write(chunk: string): void;
  end(): void;
  kill(signal?: NodeJS.Signals): void;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /**
   * 进程**启动失败**（命令不存在、cwd 不存在、权限不足）。
   *
   * 单独一个通道而不是并入 `onExit`：Node 在 spawn 失败时只发`error`，
   * **不发** `exit`。不接住它就是一个未捕获异常（直接把进程带走），
   * 而且在途请求不会被拒，只能等超时——配置里写错一个命令就是这两种故障叠加。
   */
  onError(listener: (err: Error) => void): void;
}

const realSpawn: SpawnFn = (command, args, options) => {
  const child: ChildProcessWithoutNullStreams = spawn(command, [...args], {
    // 只继承剔除密钥后的宿主环境；服务器自己的凭据由调用方经 options.env 显式传入。
    env: { ...childProcessEnv(), ...(options.env ?? {}) },
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return {
    write: (chunk) => child.stdin.write(chunk),
    end: () => child.stdin.end(),
    kill: (signal) => child.kill(signal),
    onStdout: (listener) => child.stdout.on("data", (data: Buffer) => listener(data.toString("utf8"))),
    onStderr: (listener) => child.stderr.on("data", (data: Buffer) => listener(data.toString("utf8"))),
    onExit: (listener) => child.on("exit", listener),
    // Always attached: an unhandled 'error' on a ChildProcess throws and takes the
    // whole process down, so there must never be a path where nobody listens.
    onError: (listener) => child.on("error", listener),
  };
};

/** 保留的 stderr 行数：够定位「脚本路径错」这类启动失败，又不会把日志撑爆。 */
const MAX_STDERR_LINES = 20;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** MCP `tools/call` 的结果（只看文本块，图片块本项目暂不接）。 */
export interface McpToolCallResult {
  text: string;
  isError: boolean;
}

export class McpClient {
  private child: McpProcessHandle | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderrLines: string[] = [];
  private disposed = false;
  private ready = false;
  private exitInfo: string | undefined;
  /** 当前子进程是否已退出（由 `onExit` / `onSpawnError` 维护，用于 SIGKILL 升级判断）。 */
  private childExited = false;

  constructor(private readonly options: McpClientOptions) {}

  get isReady(): boolean {
    return this.ready && !this.disposed;
  }

  /** 子进程已退出时的原因（未退出为 undefined）。用于把失败说清楚。 */
  get failure(): string | undefined {
    return this.exitInfo;
  }

  /** 最近几行 stderr（仅用于诊断，不含任何配置内容）。 */
  get stderrTail(): string[] {
    return [...this.stderrLines];
  }

  /**
   * 拉起子进程并完成 initialize 握手。
   * 握手失败会 kill 子进程——留一个没握上手的进程等于泄漏。
   */
  async start(spawnFn: SpawnFn = realSpawn): Promise<void> {
    // 已停机的客户端不能再拉起进程：那会 spawn 出一个没人回收的孤儿（dispose 已经跑过，
    // 不会再扫到它）。停机竞态下宁可让调用方拿到明确的失败。
    if (this.disposed) throw new Error("MCP 客户端已停机，不再启动子进程");
    if (this.child) return;
    let child: McpProcessHandle;
    try {
      child = spawnFn(this.options.command, this.options.args ?? [], {
        env: this.options.env,
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // Some spawn failures surface synchronously (bad option types) rather than as an
      // 'error' event. Both paths must end up as a rejected start(), not an uncaught throw.
      throw new Error(`无法启动 ${this.options.command}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.child = child;
    this.childExited = false;
    child.onStdout((chunk) => this.onStdout(chunk));
    child.onStderr((chunk) => this.onStderr(chunk));
    child.onExit((code, signal) => this.onExit(code, signal));
    child.onError((err) => this.onSpawnError(err));

    const timeoutMs = this.options.startupTimeoutMs ?? 15_000;
    try {
      await this.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "pi-starter", version: "0.2.0" },
        },
        timeoutMs,
      );
      this.notify("notifications/initialized", {});
      this.ready = true;
    } catch (err) {
      this.killChild();
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = await this.request("tools/list", {}, this.options.requestTimeoutMs ?? 30_000);
    const tools = (result as { tools?: unknown })?.tools;
    if (!Array.isArray(tools)) return [];
    const out: McpToolDescriptor[] = [];
    for (const entry of tools) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.name !== "string" || !item.name.trim()) continue;
      out.push({
        name: item.name,
        description: typeof item.description === "string" ? item.description : undefined,
        inputSchema:
          item.inputSchema && typeof item.inputSchema === "object" && !Array.isArray(item.inputSchema)
            ? (item.inputSchema as Record<string, unknown>)
            : undefined,
      });
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = (await this.request(
      "tools/call",
      { name, arguments: args },
      this.options.requestTimeoutMs ?? 30_000,
    )) as { content?: unknown; isError?: unknown };
    return {
      text: flattenContent(result?.content),
      isError: result?.isError === true,
    };
  }

  /** 停机：拒掉全部 pending 并 kill 子进程。幂等。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.failAllPending(new Error("MCP client disposed"));
    this.killChild();
  }

  /* ─────────────── 内部实现 ─────────────── */

  private killChild(): void {
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    if (!child) return;
    try {
      child.end();
    } catch {
      /* stdin already closed */
    }
    try {
      // SIGTERM first: a well-behaved MCP server exits on it and can clean up.
      child.kill("SIGTERM");
    } catch {
      return; // already dead
    }
    // SIGKILL escalation：忽略 SIGTERM 的 MCP server（自带信号处理的很常见）会变成孤儿进程
    // ——父进程退出后它还在跑，且占着端口/文件句柄。光发 SIGTERM 不叫"升级"。
    // 定时器 unref：不能为了等一个即将被杀的进程而拖住事件循环退出。
    const escalation = setTimeout(() => {
      // 已退出就什么都不做（`onExit` 会置位）。`McpProcessHandle` 刻意不暴露 exitCode，
      // 所以退出状态由自己的 onExit 回调维护，而不是去读子进程字段。
      if (!this.childExited) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, MCP_KILL_ESCALATION_MS);
    escalation.unref?.();
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 很多 MCP 服务器把日志写到 stdout。直接抛错会把一次正常连接打死，
      // 所以只记一行诊断然后继续。
      getLogger().child({ component: "mcp" }).debug("忽略无法解析的 stdout 行");
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const message = parsed as {
      id?: unknown;
      result?: unknown;
      error?: { message?: unknown };
      method?: unknown;
    };
    // 通知类消息（无 id）不需要应答。
    if (message.id === undefined || message.id === null) return;
    const id = typeof message.id === "number" ? message.id : Number(message.id);
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (message.error) {
      const text = typeof message.error.message === "string" ? message.error.message : "unknown error";
      entry.reject(new Error(text));
      return;
    }
    entry.resolve(message.result);
  }

  private onStderr(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      this.stderrLines.push(text);
      if (this.stderrLines.length > MAX_STDERR_LINES) this.stderrLines.shift();
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.ready = false;
    this.child = undefined;
    this.childExited = true;
    this.exitInfo = signal
      ? `exited on ${signal}`
      : `exited with code ${code ?? "unknown"}`;
    // 崩了就必须让在途请求失败。不这样做的话，调用方会一直等一个永远不来的应答——
    // 表现就是「工具卡住」，而不是「工具不可用」。
    this.failAllPending(new Error(`MCP server ${this.exitInfo}`));
  }

  /**
   * 启动失败（命令不存在 / cwd 不存在 / 权限不足）。
   *
   * 走和 `onExit` 一样的路径：置为不可用 + 拒掉在途请求。区别只是没有子进程可回收，
   * 且这里的失败是**立刻**的——写错一个命令不应该让人等满握手超时。
   */
  private onSpawnError(err: Error): void {
    this.ready = false;
    this.child = undefined;
    this.childExited = true;
    this.exitInfo = `failed to start: ${err.message}`;
    this.failAllPending(new Error(`MCP server ${this.exitInfo}`));
  }

  private failAllPending(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private notify(method: string, params: unknown): void {
    const child = this.child;
    if (!child) throw new Error("MCP client is not running");
    child.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("MCP client is not running"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      // Deliberately NOT unref'd: this timer is the only thing that guarantees a hung
      // server cannot pin a tool call open forever.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

/**
 * 把 MCP 的 content 块拍平成文本。
 *
 * 只取 `text` 块：图片 / 资源块在这个脚手架里没有落点，原样塞给模型只会变成
 * 一段无法解释的二进制标记，所以这里明确丢弃并在返回文本为空时保留空串。
 */
export function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part && typeof part === "object") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") out += text;
    }
  }
  return out;
}