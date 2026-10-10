/**
 * pi-starter · 进程执行（不是 PTY）
 *
 * Agent 没有「跑一条命令、拿回输出」就没有手。交互式终端（vim / top、Windows ConPTY）
 * 是另一件大一个数量级的事，这里刻意不做：没有伪终端、没有原始模式、没有终端尺寸。
 *
 * 做到的是：
 *   - 前台：等到退出、超时或中止，返回 stdout / stderr / 退出码
 *   - 后台：立刻返回任务 id，之后可以列出、读已捕获的输出、停掉
 *   - 超时和中止杀掉整个进程树，而不是只杀掉 shell、把孙子留在系统里
 *   - 工作目录两道校验：字面路径在工作区内，realpath 之后仍在工作区内；解析失败即拒绝
 *
 * shell：Windows 用 cmd.exe（不依赖 Git Bash），其它平台用 /bin/sh。
 * 命令作为一个参数交给 shell，不再套 `shell: true` 的二次转义。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isPathInsideCwd } from "../extensions/guard.js";
import { childProcessEnv } from "../child-env.js";

/** 前台默认超时。模型没写超时时，不让一条命令无限挂住这一轮。 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 后台默认寿命。不传就永不结束的话，忘了 stop 的任务会一直占着进程表。 */
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 10 * 60_000;
/** 调用方能要求的最长时限。再长就该拆任务，而不是把看门狗顶满。 */
export const MAX_TIMEOUT_MS = 10 * 60_000;
/** 单路输出上限。截断时保留前段，并继续把管道读干，避免子进程堵在满管道上。 */
export const MAX_OUTPUT_BYTES = 64 * 1024;
/**
 * 命令长度上限。Windows `CreateProcess` 的命令行大约 8191，再扣掉 `cmd /c` 的包装，
 * 8000 在两边都安全。
 */
export const MAX_COMMAND_CHARS = 8_000;
/** 同时处于 running 的任务数。占满就拒绝，而不是无界地 fork。 */
export const MAX_JOBS = 8;
/** 已结束任务的保留条数。运行中的不淘汰。 */
export const MAX_FINISHED = 32;

const KILL_GRACE_MS = 2_000;

export type ExecJobStatus = "running" | "exited" | "killed" | "timed_out";

export class ExecError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ExecError";
    this.code = code;
  }
}

export interface ExecRequest {
  command: string;
  /** 相对工作区，或工作区内的绝对路径。缺省为工作区根。 */
  cwd?: string;
  /** 毫秒。缺省：前台 {@link DEFAULT_TIMEOUT_MS}，后台 {@link DEFAULT_BACKGROUND_TIMEOUT_MS}。 */
  timeoutMs?: number;
  /** true：进程拉起后立刻返回，不把这一轮工具调用挂到它退出。 */
  background?: boolean;
  signal?: AbortSignal;
}

/** 给工具和调用方的快照。字符串是当时的副本，之后的输出不会改到已返回的对象。 */
export interface ExecJobView {
  id: string;
  command: string;
  cwd: string;
  status: ExecJobStatus;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  background: boolean;
  startedAt: number;
  endedAt?: number;
  pid?: number;
  stdout: string;
  stderr: string;
}

interface Job {
  id: string;
  command: string;
  cwd: string;
  status: ExecJobStatus;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  background: boolean;
  startedAt: number;
  endedAt?: number;
  pid?: number;
  stdout: string;
  stderr: string;
  child?: ChildProcess;
  done: Promise<void>;
  /** 只由 {@link ExecEnvironment.settle} 调用，把 `done` 放行。 */
  resolveDone: () => void;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  grace?: ReturnType<typeof setTimeout>;
  detachAbort?: () => void;
}

export interface ExecEnvironmentOptions {
  /** 允许执行的根。相对 cwd 一律相对它解析，并且 realpath 之后仍必须落在它里面。 */
  workspace: string;
}

/**
 * 一个 Agent 进程一份。
 * 后台任务不属于某一次工具调用：对话关掉之后它们还在，直到 stop、超时，或整个 Agent dispose。
 */
export class ExecEnvironment {
  private readonly workspaceLiteral: string;
  private readonly workspaceReal: string;
  private readonly jobs = new Map<string, Job>();
  private seq = 0;
  private disposed = false;

  constructor(options: ExecEnvironmentOptions) {
    this.workspaceLiteral = resolve(options.workspace);
    try {
      this.workspaceReal = realpathSync(this.workspaceLiteral);
    } catch {
      throw new ExecError(`工作区无法解析：${this.workspaceLiteral}`, "workspace_unresolved");
    }
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(this.workspaceReal);
    } catch {
      throw new ExecError(`工作区无法确认：${this.workspaceLiteral}`, "workspace_unresolved");
    }
    if (!info.isDirectory()) {
      throw new ExecError(`工作区不是文件夹：${this.workspaceLiteral}`, "workspace_not_dir");
    }
  }

  /** 工作区的 realpath。测试用它对照子进程里打印出来的 cwd。 */
  get workspace(): string {
    return this.workspaceReal;
  }

  async run(request: ExecRequest): Promise<ExecJobView> {
    if (this.disposed) throw new ExecError("执行环境已关闭", "disposed");
    const command = normalizeCommand(request.command);
    const background = request.background === true;
    const timeoutMs = resolveTimeout(request.timeoutMs, background);
    const cwd = this.resolveCwd(request.cwd);
    if (request.signal?.aborted) throw new ExecError("执行已中止", "aborted");

    this.pruneFinished();
    if (this.runningCount() >= MAX_JOBS) {
      throw new ExecError(`同时运行的任务已达上限 ${MAX_JOBS}`, "too_many_jobs");
    }

    const job = this.createJob(command, cwd, background);
    // 插入发生在第一个 await 之前：并发的 run() 无法同时穿过上限检查。
    this.jobs.set(job.id, job);

    let child: ChildProcess;
    try {
      child = launch(command, cwd);
    } catch (err) {
      this.failSpawn(job, err);
      return snapshot(job);
    }
    job.child = child;
    this.wire(job, child, timeoutMs, request.signal);

    if (background) {
      await launched(child);
      return snapshot(job);
    }
    await job.done;
    return snapshot(job);
  }

  list(): ExecJobView[] {
    return [...this.jobs.values()].reverse().map(snapshot);
  }

  get(id: string): ExecJobView | undefined {
    const job = this.jobs.get(id);
    return job ? snapshot(job) : undefined;
  }

  async stop(id: string): Promise<ExecJobView> {
    const job = this.jobs.get(id);
    if (!job) throw new ExecError(`没有这个任务：${id}`, "not_found");
    if (job.status === "running") {
      job.status = "killed";
      killJob(job);
      this.armGrace(job);
    }
    await Promise.race([job.done, delay(KILL_GRACE_MS + 1_000)]);
    return snapshot(job);
  }

  /**
   * 同步发起杀掉全部运行中的任务。
   * 停机路径是同步的（`BuiltAgent.dispose`），这里不能等进程真正退出才返回。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      job.status = "killed";
      killJob(job);
      this.armGrace(job);
    }
  }

  private resolveCwd(requested: string | undefined): string {
    const raw = requested?.trim() ? requested.trim() : ".";
    const literal = resolve(this.workspaceLiteral, raw);
    if (!isPathInsideCwd(literal, this.workspaceLiteral)) {
      throw new ExecError(`工作目录越出工作区：${raw}`, "outside_workspace");
    }
    let real: string;
    try {
      real = realpathSync(literal);
    } catch {
      // 不存在、断链、权限不够，都当不能用。没有「解析失败就放行」。
      throw new ExecError(`工作目录不存在或无法解析：${raw}`, "cwd_unresolved");
    }
    if (!isPathInsideCwd(real, this.workspaceReal)) {
      throw new ExecError(`工作目录经 realpath 后越出工作区：${raw}`, "outside_workspace");
    }
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(real);
    } catch {
      throw new ExecError(`工作目录无法确认：${raw}`, "cwd_unresolved");
    }
    if (!info.isDirectory()) {
      throw new ExecError(`工作目录不是文件夹：${raw}`, "cwd_not_dir");
    }
    return real;
  }

  private createJob(command: string, cwd: string, background: boolean): Job {
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    return {
      id: `ex-${++this.seq}`,
      command,
      cwd,
      status: "running",
      exitCode: null,
      timedOut: false,
      truncated: false,
      background,
      startedAt: Date.now(),
      stdout: "",
      stderr: "",
      done,
      resolveDone,
      settled: false,
    };
  }

  /** 收尾只发生一次：清定时器、解绑中止、放行 `done`。 */
  private settle(job: Job): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    if (job.grace) clearTimeout(job.grace);
    job.detachAbort?.();
    if (!job.endedAt) job.endedAt = Date.now();
    job.resolveDone();
  }

  private wire(job: Job, child: ChildProcess, timeoutMs: number, signal: AbortSignal | undefined): void {
    const stdoutLeft = { n: MAX_OUTPUT_BYTES };
    const stderrLeft = { n: MAX_OUTPUT_BYTES };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      job.stdout = take(job, job.stdout, asBuffer(chunk), stdoutLeft);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      job.stderr = take(job, job.stderr, asBuffer(chunk), stderrLeft);
    });

    child.once("error", (err: Error) => {
      job.stderr = take(job, job.stderr, Buffer.from(err.message), stderrLeft);
      if (job.status === "running") job.status = "exited";
      this.settle(job);
    });

    // exit 之后管道里可能还有没读完的字节。等两端都 close 再结算，
    // 否则前台快照会偶发地少掉最后一块输出。
    let exited = false;
    let stdoutClosed = !child.stdout;
    let stderrClosed = !child.stderr;
    const maybeSettle = () => {
      if (exited && stdoutClosed && stderrClosed) this.settle(job);
    };
    child.stdout?.once("close", () => {
      stdoutClosed = true;
      maybeSettle();
    });
    child.stderr?.once("close", () => {
      stderrClosed = true;
      maybeSettle();
    });
    child.once("exit", (code) => {
      if (job.status === "running") job.status = "exited";
      if (typeof code === "number") job.exitCode = code;
      job.endedAt = Date.now();
      exited = true;
      maybeSettle();
    });

    child.once("spawn", () => {
      if (typeof child.pid === "number") job.pid = child.pid;
    });

    job.timer = setTimeout(() => {
      if (job.status !== "running") return;
      job.timedOut = true;
      job.status = "timed_out";
      killJob(job);
      this.armGrace(job);
    }, timeoutMs);

    if (signal) {
      const onAbort = () => {
        if (job.status !== "running") return;
        job.status = "killed";
        killJob(job);
        this.armGrace(job);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      job.detachAbort = () => signal.removeEventListener("abort", onAbort);
    }
  }

  private armGrace(job: Job): void {
    if (job.grace) return;
    // 杀了但 exit 一直不来时，前台调用也不能挂死。unref：这条兜底不该单独撑住进程。
    job.grace = setTimeout(() => this.settle(job), KILL_GRACE_MS);
    job.grace.unref?.();
  }

  private failSpawn(job: Job, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    job.stderr = message;
    job.status = "exited";
    job.endedAt = Date.now();
    this.settle(job);
  }

  private runningCount(): number {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "running") n += 1;
    }
    return n;
  }

  private pruneFinished(): void {
    const finished = [...this.jobs.values()].filter((job) => job.status !== "running");
    const overflow = finished.length - MAX_FINISHED + 1;
    if (overflow <= 0) return;
    // Map 保插入顺序，finished 同样从旧到新。腾出一格给即将插入的新任务。
    for (let i = 0; i < overflow; i += 1) {
      const oldest = finished[i];
      if (oldest) this.jobs.delete(oldest.id);
    }
  }
}

function snapshot(job: Job): ExecJobView {
  return {
    id: job.id,
    command: job.command,
    cwd: job.cwd,
    status: job.status,
    exitCode: job.exitCode,
    timedOut: job.timedOut,
    truncated: job.truncated,
    background: job.background,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    pid: job.pid,
    stdout: job.stdout,
    stderr: job.stderr,
  };
}

function normalizeCommand(raw: unknown): string {
  if (typeof raw !== "string") throw new ExecError("命令必须是字符串", "bad_command");
  const command = raw.trim();
  if (!command) throw new ExecError("命令是空的", "empty_command");
  if (/[\0\r\n]/.test(command)) throw new ExecError("命令不能包含换行或 NUL", "bad_command");
  if (command.length > MAX_COMMAND_CHARS) {
    throw new ExecError(`命令超过 ${MAX_COMMAND_CHARS} 字符`, "command_too_long");
  }
  return command;
}

function resolveTimeout(raw: number | undefined, background: boolean): number {
  if (raw === undefined) return background ? DEFAULT_BACKGROUND_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(raw) || raw < 1) throw new ExecError("timeoutMs 必须是正数", "bad_timeout");
  if (raw > MAX_TIMEOUT_MS) {
    throw new ExecError(`timeoutMs 超过上限 ${MAX_TIMEOUT_MS}`, "bad_timeout");
  }
  return Math.floor(raw);
}

function launch(command: string, cwd: string): ChildProcess {
  if (process.platform === "win32") {
    // `/s /c` 配合最外层一对引号：cmd 会剥掉这一对，内层引号原样留下。
    // 这是 Node 自己对 `shell: true` 的做法。命令以引号开头时如果不包这一层，
    // cmd 会把第一个和最后一个引号吃掉，路径里一带空格就裂开。
    const file = process.env.ComSpec?.trim() || "cmd.exe";
    return spawn(file, ["/d", "/s", "/c", `"${command}"`], {
      cwd,
      env: childProcessEnv(),
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn("/bin/sh", ["-c", command], {
    cwd,
    // 与 Windows 分支、MCP、taskkill 同口径：不给子进程继承模型密钥。
    // （原先这里直接传 `process.env`，是 `child-env.ts` 的说明「凡是 spawn 的地方都从这里取」
    // 唯一没兑现的地方——而它恰好是 Linux/macOS 的主执行路径。）
    env: childProcessEnv(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function launched(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once("spawn", done);
    child.once("error", done);
    child.once("exit", done);
  });
}

function asBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk) : chunk;
}

function take(job: Job, current: string, chunk: Buffer, left: { n: number }): string {
  if (chunk.length === 0) return current;
  if (left.n <= 0) {
    job.truncated = true;
    return current;
  }
  if (chunk.length > left.n) {
    job.truncated = true;
    const slice = chunk.subarray(0, left.n);
    left.n = 0;
    return current + slice.toString("utf8");
  }
  left.n -= chunk.length;
  return current + chunk.toString("utf8");
}

/** 杀掉 shell 以及它拉起来的子进程。失败就当对方已经不在了。 */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      // 同样不给子进程继承模型密钥——凡是 spawn 的地方口径一致（`launch()` 的两个分支、
      // MCP、这里），避免漏一个。
      env: childProcessEnv(),
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref?.();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已经退出 */
    }
  }
}

function killJob(job: Job): void {
  const pid = job.pid ?? job.child?.pid;
  if (typeof pid === "number") {
    killProcessTree(pid);
    return;
  }
  try {
    job.child?.kill("SIGKILL");
  } catch {
    /* 还没拉起来，或已经退出 */
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
