/**
 * pi-starter · 多把API 密钥的 HTTP 接口
 *
 * 四个端点，路径刻意**不含参数**（provider / name 走 body）：
 *   GET    /provider-keys            列出各 provider 的密钥（只有名字与是否激活）
 *   POST   /provider-keys            新增或覆盖一把
 *   POST   /provider-keys/activate   切换当前使用的那把
 *   POST   /provider-keys/remove     删掉一把
 *
 * 为什么不用 `/provider-keys/:provider/...`：限流器按**字面路径**查表
 * （`FixedWindowLimiter` + `DEFAULT_RATE_RULES[req.path]`），带参数的路径根本匹配不上，
 * 于是这些写盘 + 换 key 的重资源端点就会**静默地不受限流**。参数化路径要生效必须
 * 改限流器，那属于另一件事；这里选一个从根上不需要改的形状。
 *
 * 铁律：响应体里只有 `name` 与 `active`。原始密钥与它的任何派生形式都不出服务端
 * （见 provider-keys.ts 的说明）。
 */

import type { Express, Request, Response } from "express";
import { validationFailed } from "../errors.js";
import { asyncRoute } from "./routes.js";
import type { ProviderKeyStore } from "../provider-keys.js";

export interface ProviderKeyRoutesOptions {
  /** 提供后才注册——管理密钥是敏感能力，不该默认开启。 */
  store?: ProviderKeyStore;
  /**
   * 把新激活的密钥真正装进运行中的模型运行时。
   *
   * 必须与「切模型」走同一条路（`SessionHub.setModel`）：绕过去的话，REST 说激活了 B、
   * 而每个对话仍在用 A 跑，且不会有任何报错。
   */
  applyActive?: (provider: string) => Promise<void>;
}

export function registerProviderKeyRoutes(app: Express, options: ProviderKeyRoutesOptions = {}): void {
  const store = options.store;
  if (!store) return;
  const applyActive = options.applyActive ?? (async () => undefined);

  app.get("/provider-keys", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      providers: store.providers().map((provider) => ({
        provider,
        keys: store.list(provider),
        activeKeyName: store.activeName(provider),
      })),
    });
  });

  app.post(
    "/provider-keys",
    asyncRoute(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { provider?: unknown; name?: unknown; apiKey?: unknown };
      const provider = requireField(body.provider, "provider");
      const name = requireField(body.name, "name");
      const apiKey = requireField(body.apiKey, "apiKey");
      // `set` 抛出的 validationFailed 由统一错误处理器翻译；这里不重复拼响应。
      const keys = store.set(provider, name, apiKey);
      // 第一把密钥会自动成为激活项，所以新增之后必须真的把它装进运行时，
      // 否则「加完了却还是用旧 key」会表现成密钥没生效。
      if (store.activeName(provider) === name) await applyActive(provider);
      res.json({ ok: true, provider, keys });
    }),
  );

  app.post(
    "/provider-keys/activate",
    asyncRoute(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { provider?: unknown; name?: unknown };
      const provider = requireField(body.provider, "provider");
      const name = requireField(body.name, "name");
      store.activate(provider, name);
      await applyActive(provider);
      res.json({ ok: true, provider, keys: store.list(provider), activeKeyName: name });
    }),
  );

  app.post(
    "/provider-keys/remove",
    asyncRoute(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { provider?: unknown; name?: unknown };
      const provider = requireField(body.provider, "provider");
      const name = requireField(body.name, "name");
      const wasActive = store.activeName(provider) === name;
      store.remove(provider, name);
      // 删掉的正是当前激活项时，激活权自动落到剩下的第一把；那把也得立刻生效，
      // 否则会停在一个「已删除但仍被使用」的 key 上。
      if (wasActive && store.activeName(provider)) await applyActive(provider);
      res.json({
        ok: true,
        provider,
        keys: store.list(provider),
        activeKeyName: store.activeName(provider),
      });
    }),
  );
}

function requireField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw validationFailed(`${field} is required`);
  return value.trim();
}