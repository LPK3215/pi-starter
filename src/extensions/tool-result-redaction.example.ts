/**
 * pi-starter · 示例扩展：工具结果脱敏（官方 `tool_result` 钩子，五步管道第 5 步）
 *
 * 官方 `tool_result` 在工具结果**回传给模型之前**触发，handler 返回 `{ content }` 即可替换。
 * 用途：`exec` / `read` / `db_query` 的输出里可能带密钥、绝对路径、token 回显——这些会原样进入
 * 模型上下文（`http/errors.ts` 的脱敏只保护面向 HTTP 客户端的响应，管不到发给模型的 tool 结果）。
 *
 * 默认**不接线**（改写模型可见内容有决策风险，且会改变现有行为）；经
 * `buildAgent({ extraExtensions: [toolResultRedactionExtension({...})] })` 显式启用。
 * 类型对齐官方 `ToolResultEvent` / `ToolResultEventResult`，`npm run typecheck` 即证明接口用对。
 */

import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

export interface RedactionRule {
  /** 必须是带 `g` 标志的正则（否则只替换首个匹配）。 */
  pattern: RegExp;
  /** 命中后替换成的文本。 */
  replacement: string;
}

export interface ToolResultRedactionOptions {
  /** 脱敏规则；逐条对每个 text 段执行 `text.replace(pattern, replacement)`。 */
  rules: readonly RedactionRule[];
  /**
   * 可选：限定只处理这些工具的结果（如 ["exec","read","db_query"]）；
   * 省略或空数组 = 处理所有工具。
   */
  tools?: readonly string[];
}

export function toolResultRedactionExtension(options: ToolResultRedactionOptions) {
  const scope = options.tools && options.tools.length > 0 ? new Set(options.tools) : undefined;
  return (pi: ExtensionAPI): void => {
    pi.on("tool_result", (event: ToolResultEvent) => {
      if (scope && !scope.has(event.toolName)) return undefined;
      let changed = false;
      const content = event.content.map((item) => {
        if (item.type !== "text") return item;
        let text = item.text;
        for (const rule of options.rules) {
          const next = text.replace(rule.pattern, rule.replacement);
          if (next !== text) {
            text = next;
            changed = true;
          }
        }
        return changed || text !== item.text ? { ...item, text } : item;
      });
      // 返回官方 ToolResultEventResult 形状（类型未从主入口导出，由 pi.on 重载按上下文推断）。
      return changed ? { content } : undefined;
    });
  };
}
