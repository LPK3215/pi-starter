/**
 * 自定义 provider 扩展示例（官方 `pi.registerProvider`）
 *
 * 这是**示例**，默认不登记进 `allExtensions`——脚手架只内置 guard / audit。
 * 要用它，把它传给 `buildAgent({ extraExtensions: [customProviderExample] })`，
 * 或参考它写一个你自己的 provider 扩展。官方文档：`custom-provider.md`。
 *
 * 覆盖范围与边界：
 *   - 本例只演示 **api-key 型** provider（OpenAI 兼容方言），后端可直接用。
 *   - `ProviderConfig.oauth`（交互式 /login 同意、设备码）依赖 `ctx.ui`（TUI），
 *     无头后端不适用——脚手架不实现、也不假装支持。
 *
 * 与 `setup.ts` 的关系：`setup` 把 provider 写进 `~/.pi/agent/models.json`，是官方
 * custom-models 路径，够用于 OpenAI/Anthropic 兼容厂商；`registerProvider` 更进一步，
 * 允许自定义鉴权解析、自定义流式实现、代理网关等。二者可并存。
 *
 * baseUrl 只到 /v1，别再拼 /chat/completions。apiKey 走 SDK 的配置值语法：`$ENV_VAR`
 * 插值环境变量、`!command` 执行命令取值、`$$`/`$!` 输出字面量。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 用 MY_LLM_* 环境变量把一整家自建 / 代理网关的 provider 注册进来。 */
export function customProviderExample(pi: ExtensionAPI): void {
  const baseUrl = process.env.MY_LLM_BASE_URL?.trim();
  const apiKey = process.env.MY_LLM_API_KEY?.trim();
  const modelId = process.env.MY_LLM_MODEL?.trim();
  // 三个都配齐才注册，否则安静跳过——半成品 provider 进目录只会让切换时报错。
  if (!baseUrl || !apiKey || !modelId) return;

  pi.registerProvider("my-llm", {
    name: "My LLM",
    baseUrl,
    // 交给 SDK 解析环境变量，不把明文 key 写死在这份会被读进内存的扩展里。
    apiKey: "$MY_LLM_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    ],
  });
}
