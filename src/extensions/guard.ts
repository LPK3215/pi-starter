/**
 * pi-starter · 示例扩展：guard（工具调用闸门）
 *
 * 演示 tool_call 真正有价值的能力：执行前拦截。
 * 默认档位 off 仍会开 read（技能加载），coding / readonly 才会碰到 bash / write。
 *
 * 这不是沙箱。按你的业务改 DANGEROUS_BASH_RULES 和路径策略即可。
 */

import { basename, isAbsolute, relative, resolve } from "node:path";
import { getLogger } from "../log.js";
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

export interface BashDangerMatch {
  id: string;
  description: string;
}

const DANGEROUS_BASH_RULES: Array<{
  id: string;
  description: string;
  test: (command: string) => boolean;
}> = [
  {
    id: "rm-rf",
    description: "递归强制删除（rm -rf）",
    test: (cmd) =>
      /\brm\s+-(?=[a-zA-Z]*r)(?=[a-zA-Z]*f)[a-zA-Z]+\b/i.test(cmd) ||
      /\brm\s+--recursive\b/i.test(cmd),
  },
  {
    id: "mkfs",
    description: "格式化磁盘（mkfs）",
    test: (cmd) => /\bmkfs(\.\w+)?\b/i.test(cmd),
  },
  {
    id: "dd",
    description: "裸设备写入（dd of=）",
    test: (cmd) => /\bdd\b/i.test(cmd) && /\bof\s*=/i.test(cmd),
  },
  {
    id: "fork-bomb",
    description: "fork bomb",
    test: (cmd) => /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/.test(cmd),
  },
  {
    id: "shutdown",
    description: "关机 / 重启",
    test: (cmd) => /\b(shutdown|reboot|halt|poweroff)\b/i.test(cmd),
  },
  {
    id: "windows-destructive",
    description: "Windows 破坏性删除 / 格式化",
    test: (cmd) =>
      (/\bRemove-Item\b/i.test(cmd) && /-(Recurse|Force)\b/i.test(cmd)) ||
      /\bdel\s+\/s\b/i.test(cmd) ||
      /\brd\s+\/s\b/i.test(cmd) ||
      /\bformat\s+[a-z]:/i.test(cmd),
  },
];

/** 命中危险 bash 规则则返回第一条；放行返回 undefined */
export function findDangerousBash(command: string): BashDangerMatch | undefined {
  return DANGEROUS_BASH_RULES.find((rule) => rule.test(command));
}

/**
 * 判断目标路径是否落在 cwd 内（含 cwd 自身）。
 * 用 path.resolve + relative，Windows 跨盘符会得到绝对路径，isAbsolute 能拦住。
 * 不处理 symlink 逃逸——要沙箱请用容器，不要只靠这一层。
 */
export function isPathInsideCwd(targetPath: string, cwd: string): boolean {
  const resolvedCwd = resolve(cwd);
  const resolvedTarget = resolve(resolvedCwd, targetPath);
  const rel = relative(resolvedCwd, resolvedTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function block(reason: string, extra?: Record<string, unknown>): ToolCallEventResult {
  // Security blocks are warn-level: they must be visible in normal operation, not buried
  // in debug noise, because each one is a potential attack or model mistake.
  getLogger().child({ component: "guard" }).warn("拦截工具调用", { reason, ...extra });
  return { block: true, reason };
}

function pathFromEvent(event: ToolCallEvent): string | undefined {
  if (isToolCallEventType("read", event)) return event.input.path;
  if (isToolCallEventType("write", event)) return event.input.path;
  if (isToolCallEventType("edit", event)) return event.input.path;
  if (isToolCallEventType("ls", event)) return event.input.path;
  if (isToolCallEventType("grep", event)) return event.input.path;
  if (isToolCallEventType("find", event)) return event.input.path;
  return undefined;
}

export function guardExtension(pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const hit = findDangerousBash(event.input.command);
      if (hit) {
        return block(`bash：${hit.description}`, { ruleId: hit.id });
      }
      return undefined;
    }

    const targetPath = pathFromEvent(event);
    if (targetPath && !isPathInsideCwd(targetPath, ctx.cwd)) {
      // SDK 技能正文在 additionalSkillPaths 里，不一定落在 cwd。
      // 只放行 read SKILL.md，write/edit 越界照拦。
      if (event.toolName === "read" && basename(targetPath) === "SKILL.md") {
        return undefined;
      }
      // Log the path so operators can spot probing patterns; the model already knows the path.
      return block(`${event.toolName}：路径越出工作目录（${targetPath}）`, {
        toolName: event.toolName,
        targetPath,
        cwd: ctx.cwd,
      });
    }

    return undefined;
  });
}
