/**
 * pi-starter · 工具注册表（Tool Registry + ActiveSet）
 *
 * 脚手架的工具来源有三类，统一收进一个注册表：
 *   - builtin   SDK 内置（read / bash / edit / write / grep / find / ls）
 *   - custom    src/tools 静态登记（如 current_time）
 *   - dynamic   运行时装配（知识库 / 数据库工具）
 *
 * 相对 pi-web-ui 的改进：
 *   1. pi-web-ui 的 AGENT_TOOL_CATALOG 是硬编码常量 + `installToolOverrides` 覆盖链；
 *      这里改成**数据驱动的注册表**——工具带 capabilities/risk 元数据，策略、审批、UI 分组
 *      都从元数据推导，新增工具只登记一次，不必在多处同步。
 *   2. ActiveSet 支持**运行中开关**（set_tool_enabled 命令 → SDK ActiveSet），
 *      与持久化开关分离，重启可回落默认。
 *   3. 纯内存 + 零 IO，可单测；不依赖 SDK 内部私有字段（pi-web-ui 直接改 `_customTools`）。
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** 工具来源。 */
export type ToolSource = "builtin" | "custom" | "dynamic";

/** 风险等级：驱动默认审批策略。 */
export type ToolRisk = "low" | "medium" | "high";

/** 一个工具的完整描述（定义 + 元数据）。 */
export interface ToolSpec {
  /** 工具名，需与 ToolDefinition.name 一致。 */
  name: string;
  /** 供 LLM 与 UI 的简述。 */
  description: string;
  source: ToolSource;
  /** 能力标签，如 fs.read / fs.write / shell / net / kb。 */
  capabilities: string[];
  /** 风险等级。 */
  risk: ToolRisk;
  /** SDK 工具定义（builtin 之外才有；builtin 由 SDK 提供时可为 undefined）。 */
  definition?: ToolDefinition;
}

/** 由工具名推断默认能力标签（登记时可覆盖）。 */
export function inferCapabilities(name: string): string[] {
  switch (name) {
    case "read":
      return ["fs.read"];
    case "write":
      return ["fs.write"];
    case "edit":
      return ["fs.write"];
    case "ls":
    case "grep":
    case "find":
      return ["fs.read"];
    case "bash":
      return ["shell"];
    default:
      return ["custom"];
  }
}

/** 由能力标签推断风险等级（登记时可覆盖）。 */
export function inferRisk(capabilities: readonly string[]): ToolRisk {
  if (capabilities.includes("shell") || capabilities.includes("fs.write")) return "high";
  if (capabilities.includes("net")) return "medium";
  return "low";
}

/** 便捷构造：只给必要字段，capabilities / risk 自动推断。 */
export function defineToolSpec(
  spec: Omit<ToolSpec, "capabilities" | "risk"> & {
    capabilities?: string[];
    risk?: ToolRisk;
  },
): ToolSpec {
  const capabilities = spec.capabilities ?? inferCapabilities(spec.name);
  return { ...spec, capabilities, risk: spec.risk ?? inferRisk(capabilities) };
}

export interface ToolRegistryOptions {
  /** 初始禁用的工具名（持久化开关）。 */
  disabled?: readonly string[];
}

/**
 * 工具注册表：登记 + 查询 + 运行中开关。
 * 所有变更都是同步纯内存操作，`catalog()` 直接产出协议里的 UiTool[]。
 */
export class ToolRegistry {
  private readonly specs = new Map<string, ToolSpec>();
  private readonly enabled = new Set<string>();
  private readonly order: string[] = [];

  constructor(options: ToolRegistryOptions = {}) {
    this.disabledSeed = new Set(options.disabled ?? []);
  }

  private readonly disabledSeed: Set<string>;

  /** 登记一个工具。同名覆盖（后者优先，便于扩展覆盖内置）。 */
  register(spec: ToolSpec): void {
    if (!this.specs.has(spec.name)) this.order.push(spec.name);
    this.specs.set(spec.name, spec);
    // 默认激活，除非被显式禁用。
    if (!this.disabledSeed.has(spec.name)) this.enabled.add(spec.name);
  }

  /** 批量登记。 */
  registerAll(specs: readonly ToolSpec[]): void {
    for (const spec of specs) this.register(spec);
  }

  get(name: string): ToolSpec | undefined {
    return this.specs.get(name);
  }

  has(name: string): boolean {
    return this.specs.has(name);
  }

  /** 按登记顺序返回全部工具。 */
  list(): ToolSpec[] {
    return this.order.map((name) => this.specs.get(name)).filter((s): s is ToolSpec => Boolean(s));
  }

  /** 运行中开关。返回是否命中已登记的工具。 */
  setEnabled(name: string, enabled: boolean): boolean {
    if (!this.specs.has(name)) return false;
    if (enabled) this.enabled.add(name);
    else this.enabled.delete(name);
    return true;
  }

  isEnabled(name: string): boolean {
    return this.enabled.has(name);
  }

  /** 当前激活的工具名（按登记顺序，可直接喂给 SDK setActiveToolsByName）。 */
  enabledNames(): string[] {
    return this.order.filter((name) => this.enabled.has(name));
  }

  /** 协议快照用的工具目录。 */
  catalog(): { name: string; description: string; source: ToolSource; capabilities: string[]; enabled: boolean }[] {
    return this.list().map((spec) => ({
      name: spec.name,
      description: spec.description,
      source: spec.source,
      capabilities: spec.capabilities,
      enabled: this.enabled.has(spec.name),
    }));
  }

  /** 某个工具的能力标签，未知工具回落空数组。 */
  capabilitiesOf(name: string): string[] {
    return this.specs.get(name)?.capabilities ?? [];
  }

  /** 某工具的风险等级，未知工具按 high 处理（保守）。 */
  riskOf(name: string): ToolRisk {
    return this.specs.get(name)?.risk ?? "high";
  }
}

/** SDK 内置工具清单（用于装配时登记 builtin 条目）。 */
export const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/** 从自定义 ToolDefinition 列表构建注册表（含 builtin 占位）。 */
export function createToolRegistry(options: {
  customTools?: readonly ToolDefinition[];
  builtinTools?: readonly string[];
  disabled?: readonly string[];
} = {}): ToolRegistry {
  const registry = new ToolRegistry({ disabled: options.disabled });
  for (const name of options.builtinTools ?? []) {
    registry.register(
      defineToolSpec({ name, description: `SDK builtin tool ${name}`, source: "builtin" }),
    );
  }
  for (const tool of options.customTools ?? []) {
    registry.register(
      defineToolSpec({
        name: tool.name,
        description: tool.description,
        source: "custom",
        definition: tool,
      }),
    );
  }
  return registry;
}
