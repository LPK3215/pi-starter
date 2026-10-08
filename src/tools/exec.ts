/**
 * pi-starter · 进程执行工具
 *
 * 三件，缺一不可：
 *   - exec       跑命令（前台或后台）
 *   - exec_jobs  看还在跑什么、读已经捕获的输出
 *   - exec_stop  停掉后台任务
 *
 * 不放进 `allTools`。`allTools` 在 off / readonly / coding 三档都会进白名单，
 * 而 shell 必须跟着编码档走——默认关。`execToolsForMode` 是唯一的准入口，
 * `buildAgent` 按 `builtinTools` 调用它。
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BuiltinToolMode } from "../config.js";
import {
  ExecEnvironment,
  ExecError,
  MAX_TIMEOUT_MS,
  type ExecJobStatus,
  type ExecJobView,
} from "../exec/runner.js";
import { defineToolSpec, type ToolSpec } from "./registry.js";

export const EXEC_TOOL_NAMES = ["exec", "exec_jobs", "exec_stop"] as const;

const EXEC_DESCRIPTION =
  "在当前工作区内执行一条命令，返回 stdout、stderr 和退出码。background 为 true 时立刻返回任务 id，不阻塞本轮。不是交互式终端，不能跑 vim / top。工作目录必须留在工作区内。";

const JOBS_DESCRIPTION =
  "列出本进程里 exec 启动的任务。传入 id 时返回该任务已捕获的 stdout / stderr。任务是进程级的，不随单次对话关闭而消失。";

const STOP_DESCRIPTION = "停止一个由 exec 启动的后台任务，并杀掉它拉起的子进程。";

/** 登记进 ToolRegistry 的元数据。能力标签必须手写：按名字推断时 exec_jobs 不是 shell。 */
export function execRegistrySpecs(): ToolSpec[] {
  return [
    defineToolSpec({
      name: "exec",
      description: EXEC_DESCRIPTION,
      source: "custom",
      capabilities: ["shell"],
    }),
    defineToolSpec({
      name: "exec_jobs",
      description: JOBS_DESCRIPTION,
      source: "custom",
      capabilities: ["shell.observe"],
      risk: "low",
    }),
    defineToolSpec({
      name: "exec_stop",
      description: STOP_DESCRIPTION,
      source: "custom",
      capabilities: ["shell"],
    }),
  ];
}

/**
 * coding 档才把执行工具交出去。
 * off / readonly 返回空数组——调用方只要把结果拼进工具清单，就不会出现在白名单里。
 */
export function execToolsForMode(
  mode: BuiltinToolMode,
  env: ExecEnvironment | undefined,
): ToolDefinition[] {
  if (mode !== "coding" || !env) return [];
  return createExecTools(env);
}

export function createExecTools(env: ExecEnvironment): ToolDefinition[] {
  const exec = defineTool({
    name: "exec",
    label: "执行命令",
    description: EXEC_DESCRIPTION,
    parameters: Type.Object({
      command: Type.String({ description: "要执行的命令。一条，不要换行。" }),
      cwd: Type.Optional(
        Type.String({ description: "工作目录，相对当前工作区。缺省为工作区根。不能越出工作区。" }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: `超时秒数，上限 ${MAX_TIMEOUT_MS / 1000}。前台默认 30，后台默认 600。`,
        }),
      ),
      background: Type.Optional(
        Type.Boolean({ description: "true 时后台运行并立刻返回 id。之后用 exec_jobs / exec_stop。" }),
      ),
    }),
    async execute(_id, params: { command: string; cwd?: string; timeout_seconds?: number; background?: boolean }, signal) {
      try {
        const view = await env.run({
          command: params.command,
          cwd: params.cwd,
          timeoutMs: timeoutMsFromSeconds(params.timeout_seconds),
          background: params.background === true,
          signal,
        });
        const note = view.background && view.status === "running"
          ? "已在后台启动。用 exec_jobs 查看输出，用 exec_stop 停止。到时限会自动结束。"
          : undefined;
        return render(view, note);
      } catch (err) {
        return fail(asText(err));
      }
    },
  });

  const jobs = defineTool({
    name: "exec_jobs",
    label: "查看执行任务",
    description: JOBS_DESCRIPTION,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "不传则列出全部；传入则返回该任务的已捕获输出。" })),
    }),
    async execute(_id, params: { id?: string }) {
      const id = params.id?.trim();
      if (!id) {
        const views = env.list();
        if (views.length === 0) {
          return textResult("当前没有执行任务。", { ok: true, jobs: [] }, false);
        }
        const lines = views.map(summaryLine);
        return textResult(lines.join("\n"), { ok: true, jobs: views.map((view) => view.id) }, false);
      }
      const view = env.get(id);
      if (!view) return fail(`没有这个任务：${id}`);
      return render(view);
    },
  });

  const stop = defineTool({
    name: "exec_stop",
    label: "停止执行任务",
    description: STOP_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({ description: "exec 或 exec_jobs 返回的任务 id。" }),
    }),
    async execute(_id, params: { id: string }) {
      try {
        const view = await env.stop(params.id.trim());
        return render(view, "已请求停止。");
      } catch (err) {
        return fail(asText(err));
      }
    },
  });

  return [exec, jobs, stop];
}

interface ExecDetails {
  ok: boolean;
  id?: string;
  status?: ExecJobStatus;
  exitCode?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
  background?: boolean;
  jobs?: string[];
}

function textResult(text: string, details: ExecDetails, isError: boolean) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError,
  };
}

function timeoutMsFromSeconds(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new ExecError("timeout_seconds 必须是正数", "bad_timeout");
  }
  const ms = Math.round(raw * 1000);
  if (ms < 1 || ms > MAX_TIMEOUT_MS) {
    throw new ExecError(`timeout_seconds 必须在 0 到 ${MAX_TIMEOUT_MS / 1000} 之间`, "bad_timeout");
  }
  return ms;
}

function summaryLine(view: ExecJobView): string {
  const command = view.command.length > 80 ? `${view.command.slice(0, 80)}...` : view.command;
  const exit = view.exitCode === null ? "-" : String(view.exitCode);
  return `${view.id}  ${view.status}  exit=${exit}  ${command}`;
}

function formatView(view: ExecJobView, note?: string): string {
  const lines = [
    note,
    `id: ${view.id}`,
    `status: ${view.status}`,
    `exit: ${view.exitCode === null ? "null" : String(view.exitCode)}`,
    view.timedOut ? "timed_out: true" : undefined,
    view.truncated ? "truncated: true（输出超过上限，只保留前段）" : undefined,
    view.background ? "background: true" : undefined,
    `cwd: ${view.cwd}`,
    `command: ${view.command}`,
    "--- stdout ---",
    view.stdout,
    "--- stderr ---",
    view.stderr,
  ];
  return lines.filter((line) => line !== undefined).join("\n");
}

function failed(view: ExecJobView): boolean {
  if (view.background && view.status === "running") return false;
  return view.status !== "exited" || view.exitCode !== 0 || view.timedOut;
}

function render(view: ExecJobView, note?: string) {
  return textResult(formatView(view, note), {
    ok: !failed(view),
    id: view.id,
    status: view.status,
    exitCode: view.exitCode,
    timedOut: view.timedOut,
    truncated: view.truncated,
    background: view.background,
  }, failed(view));
}

function fail(text: string) {
  return textResult(text, { ok: false }, true);
}

function asText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
