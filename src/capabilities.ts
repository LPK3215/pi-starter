/**
 * pi-starter · 能力目录整形（REST 与 WS 共用）
 *
 * 改造前 `http/routes.ts` 的 `GET /capabilities` 与 `transport/ws.ts` 的 `buildCapabilities`
 * 各写一份「工具 / 技能 / 知识库」整形。协议单源只统一了**类型**，没统一**行为**，
 * 于是同一份能力在两条通道上可能漂移（字段名、过滤规则、顺序各改各的）。
 *
 * 这里把两条通道共同的那部分收敛成单一函数：
 *   - REST `GET /capabilities` 直接返回它；
 *   - WS 的 `capabilities` 帧在它之上再加 `promptTemplates` / `commands` / `planModeDefault`。
 *
 * 只做整形，不读运行时状态，因此是纯函数，便于单测。
 */

import type { UiCapabilities, UiTool } from "./protocol.js";

/** 两条通道共同的能力字段（WS 在此基础上扩展）。 */
export type CapabilityBase = Pick<
  UiCapabilities,
  "builtinTools" | "tools" | "skills" | "knowledge"
>;

/** 能力来源：已经取好的原始集合，函数只负责整形。 */
export interface CapabilitySource {
  /** 内置工具档位（off / readonly / coding）。 */
  builtinTools: string;
  /** 工具注册表的目录（已含启用态与能力标签）。 */
  tools: readonly UiTool[];
  skills: readonly { name: string; description: string }[];
  knowledge: readonly { name: string; title: string; description: string }[];
}

/** 把原始能力集合整形为线协议结构。 */
export function buildCapabilityBase(source: CapabilitySource): CapabilityBase {
  return {
    builtinTools: source.builtinTools,
    tools: [...source.tools],
    skills: source.skills.map((skill) => ({ name: skill.name, description: skill.description })),
    knowledge: source.knowledge.map((doc) => ({
      name: doc.name,
      title: doc.title,
      description: doc.description,
    })),
  };
}
