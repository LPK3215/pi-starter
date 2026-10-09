/**
 * pi-starter · 示例扩展：输入拦截 + 运行期资源发现（官方 `input` / `resources_discover`）
 *
 * 演示官方 SDK 的两个扩展钩子，**默认不接线**，经 `buildAgent({ extraExtensions: [...] })` 启用。
 * 类型全部对齐官方事件定义，`npm run typecheck` 即证明接口用对。
 *
 * 官方语义（读 core/extensions/types.d.ts 核实）：
 *   - `input`：用户输入进 skill/prompt-template 展开**之前**触发（拿到的是原始文本，`/skill:x` 尚未展开）。
 *     返回 `{ action: "transform", text, images? }` 改写输入；`{ action: "handled" }` 短路吞掉（不再进入 Agent）；
 *     返回 undefined 原样继续。
 *   - `resources_discover`：会话启动/重载时触发，扩展可**动态贡献**资源路径
 *     （返回 `{ skillPaths?, promptPaths?, themePaths? }`）——官方包/pi packages 自注册资源就走这条。
 *     与静态的 `additionalSkillPaths`/`additionalPromptTemplatePaths` 互补：那个是装配时给定，这个是运行期按需产出。
 */

import type {
  ExtensionAPI,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";

export interface InputResourcesOptions {
  /** 可选：改写用户输入（返回 undefined = 不改）。 */
  transformInput?: (event: InputEvent) => string | undefined;
  /** 可选：拦截并吞掉某些输入（返回 true = handled，不再进入 Agent）。 */
  swallow?: (event: InputEvent) => boolean;
  /** 运行期为该会话贡献的技能目录路径。 */
  skillPaths?: string[];
  /** 运行期贡献的提示词模板路径。 */
  promptPaths?: string[];
}

export function inputResourcesExtension(options: InputResourcesOptions = {}) {
  return (pi: ExtensionAPI): void => {
    pi.on("input", (event: InputEvent): InputEventResult | undefined => {
      if (options.swallow?.(event)) return { action: "handled" };
      const next = options.transformInput?.(event);
      if (next === undefined || next === event.text) return undefined;
      return { action: "transform", text: next };
    });

    pi.on("resources_discover", (_event) => {
      // 参数/返回类型由 pi.on 重载按上下文推断（官方 ResourcesDiscover* 类型未从主入口导出）。
      const result: { skillPaths?: string[]; promptPaths?: string[] } = {
        ...(options.skillPaths?.length ? { skillPaths: options.skillPaths } : {}),
        ...(options.promptPaths?.length ? { promptPaths: options.promptPaths } : {}),
      };
      return Object.keys(result).length > 0 ? result : undefined;
    });
  };
}
