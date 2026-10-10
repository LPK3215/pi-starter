/**
 * pi-starter · 示例扩展：guard（工具调用闸门）
 *
 * 演示 tool_call 真正有价值的能力：执行前拦截。
 * 默认档位 off 仍会开 read（技能加载），coding / readonly 才会碰到 bash / write。
 *
 * 这不是沙箱。按你的业务改 DANGEROUS_BASH_RULES 和路径策略即可。
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { getLogger } from "../log.js";
import { isDeniedName } from "../secret-files.js";
import { matchGuardShellRule } from "./shell-rules.js";
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

/**
 * 命中危险 bash 规则则返回第一条；放行返回 undefined。
 *
 * 规则表来自 `shell-rules.ts`（与审批规则同源），这里只取 `guardBlocks` 的条目。
 * 返回的 `id` 与审批规则 id 的后缀一致（`builtin:bash.<id>`），便于两边对照与排查。
 */
export function findDangerousBash(command: string): BashDangerMatch | undefined {
  const rule = matchGuardShellRule(command);
  return rule ? { id: rule.id, description: rule.reason } : undefined;
}

/**
 * bash 与 exec 共用同一套硬拦截。其它工具名直接放行，避免 exec_jobs 的查询被当成命令。
 */
export function dangerousShellCommand(
  toolName: string,
  input: { command?: unknown },
): BashDangerMatch | undefined {
  if (toolName !== "bash" && toolName !== "exec") return undefined;
  if (typeof input.command !== "string") return undefined;
  return findDangerousBash(input.command);
}

/** 字面路径包含判定（不解析链接）。 */
function isInsideLiteral(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 取路径**最近的已存在祖先**的 realpath；整条路径都不存在（或解析失败）时返回 undefined。
 *
 * 对还不存在的目标（新建文件）而言，字面路径在 cwd 内不等于真实路径在 cwd 内——
 * 中间任何一层是符号链接就可能逃逸。所以要落到最近存在的祖先上再解析。
 */
function realpathOfNearestExisting(target: string): string | undefined {
  let probe = target;
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(probe)) {
      try {
        return realpathSync.native(probe);
      } catch {
        // 解析失败（权限 / 异常链接 / 与删除竞争）时按「不可信」处理。
        return undefined;
      }
    }
    const parent = dirname(probe);
    if (parent === probe) return undefined;
    probe = parent;
  }
  return undefined;
}

/**
 * 判断目标路径是否落在 cwd 内（含 cwd 自身）。
 *
 * 两道校验，与 `FileService` 同强度：
 *   1. `resolve` 后的**字面路径**在 cwd 内 —— 拦 `../` 与绝对路径穿越；
 *      Windows 跨盘符会得到绝对路径，`isAbsolute` 能拦住。
 *   2. 最近**已存在祖先**的 **realpath** 在 cwd 内 —— 拦符号链接逃逸。
 *      字面路径在 cwd 内并不等于真实路径在 cwd 内，符号链接正是把两者分开的机制。
 *
 * cwd 自身也用它自己的 realpath 作基准：macOS 的 `/tmp`、或用户从链接目录启动时，
 * 字面 cwd 与真实 cwd 不同，用字面值当基准会把合法操作误判成越界。
 *
 * 这不是沙箱（bash 命令体本身不受此约束），但至少让 read/write/edit 与文件服务一致。
 */
export function isPathInsideCwd(targetPath: string, cwd: string): boolean {
  const resolvedCwd = resolve(cwd);
  const resolvedTarget = resolve(resolvedCwd, targetPath);
  if (!isInsideLiteral(resolvedCwd, resolvedTarget)) return false;

  const realTarget = realpathOfNearestExisting(resolvedTarget);
  if (realTarget === undefined) return true; // 整条路径都不存在：没有可逃逸的实体
  const realCwd = realpathOfNearestExisting(resolvedCwd) ?? resolvedCwd;
  return isInsideLiteral(realCwd, realTarget);
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
    const shellHit = dangerousShellCommand(event.toolName, event.input as { command?: unknown });
    if (shellHit) {
      return block(`${event.toolName}：${shellHit.description}`, { ruleId: shellHit.id });
    }
    if (isToolCallEventType("bash", event)) return undefined;
    if (event.toolName === "exec") {
      const cwd = (event.input as { cwd?: unknown }).cwd;
      if (typeof cwd === "string" && cwd.trim() && !isPathInsideCwd(cwd, ctx.cwd)) {
        return block(`exec：工作目录越出工作区（${cwd}）`, {
          toolName: event.toolName,
          targetPath: cwd,
          cwd: ctx.cwd,
        });
      }
      return undefined;
    }

    const targetPath = pathFromEvent(event);
    // 敏感文件名：与 HTTP 文件服务（`files/service.ts` 的 `denyNames`）共用同一份名单
    // （`secret-files.ts`）。
    //
    // 这一步不能省：路径校验判的是「在不在工作目录内」，而 `.env` 恰好**就在**工作目录里
    // ——不拦的话，agent 用内置 `read` 就能把模型 Key 读进上下文（`read` 在任何档位都可用，
    // 而审批规则 `builtin:secret.access` 是 `ask`，`toolApprovalEnabled` 默认 false 时会
    // 被压制为 allow）。文件服务那条通道已堵，这条是同一铁律的另一半。
    if (targetPath && isDeniedName(basename(targetPath))) {
      return block(`${event.toolName}：拒绝访问敏感文件（${basename(targetPath)}）`, {
        toolName: event.toolName,
        targetPath,
        rule: "secret-file",
      });
    }
    // 字面 basename 无害 ≠ 真实目标无害：cwd 内一个 `notes.txt -> .env` 的符号链接，
    // 字面名（notes.txt）不命中名单、路径也确实在 cwd 内，于是上面两道都放行 ——
    // 而读出来的内容就是 `.env`。文件服务那边（`files/service.ts` 的 `resolvePath`）
    // 已经补了「真实目标名也要查」这一层，guard 这边此前漏了，等于同一道门只关了一半。
    if (targetPath) {
      const absolute = resolve(ctx.cwd, targetPath);
      // 只在目标**存在**时解析：不存在的路径没有可逃逸的实体，硬解析只会把父目录的名字
      // 误当成目标名（例如新建 `cwd/.env/foo` 也会去查 `.env`）。
      const real = existsSync(absolute) ? realpathOfNearestExisting(absolute) : undefined;
      const realName = real ? basename(real) : undefined;
      if (realName && realName !== basename(targetPath) && isDeniedName(realName)) {
        return block(
          `${event.toolName}：拒绝访问敏感文件（${basename(targetPath)} 经符号链接指向 ${realName}）`,
          {
            toolName: event.toolName,
            targetPath,
            rule: "secret-file-symlink",
          },
        );
      }
    }
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
