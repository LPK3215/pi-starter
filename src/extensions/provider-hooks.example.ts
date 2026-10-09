/**
 * pi-starter · 示例扩展：provider 出站拦截钩子（官方 `before_provider_*`）
 *
 * 演示官方 SDK 提供的两个「请求发出前」钩子——它们不是脚手架默认行为，**默认不接线**，
 * 需要经 `buildAgent({ extraExtensions: [providerHooksExtension(...)] })` 显式启用。
 * 本文件的价值在于：类型全部对齐官方事件定义，`npm run typecheck` 就是"接口用得对"的证据。
 *
 * 官方语义（读 core/extensions/types.d.ts 核实）：
 *   - `before_provider_headers`：请求头组装完、HTTP 调用前触发。**原地 mutate `event.headers`**
 *     即可注入追踪/会话头；返回值被忽略；把某个头设为 `null` 即删除它。
 *   - `before_provider_request`：请求体发出前触发，handler 返回 `unknown` = 用返回值**替换出站 payload**；
 *     返回 `undefined` 则原样透传。适合统一注入字段、脱敏、埋点。
 */

import type {
  BeforeProviderHeadersEvent,
  BeforeProviderRequestEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export interface ProviderHooksOptions {
  /** 返回要注入的追踪/会话头集合；返回 null 值的头会被删除。 */
  headers?: () => Record<string, string | null>;
  /** 可选：改写出站请求 payload（返回 undefined = 不改）。 */
  rewritePayload?: (payload: unknown) => unknown;
}

export function providerHooksExtension(options: ProviderHooksOptions = {}) {
  return (pi: ExtensionAPI): void => {
    pi.on("before_provider_headers", (event: BeforeProviderHeadersEvent) => {
      const injected = options.headers?.();
      if (!injected) return;
      // 契约：原地 mutate，不返回新对象。
      for (const [key, value] of Object.entries(injected)) {
        event.headers[key] = value;
      }
    });

    pi.on("before_provider_request", (event: BeforeProviderRequestEvent) => {
      if (!options.rewritePayload) return undefined; // 原样透传
      return options.rewritePayload(event.payload);
    });
  };
}
