/**
 * pi-starter · 模型目录与选择
 *
 * 一个 provider 可以挂多个模型。配置只声明「有哪些」，
 * 具体用哪个由命令行 / .env / 运行时切换决定，三处共用同一套解析。
 *
 * 模型 id 本身可以带斜杠（Qwen/Qwen3-...），所以不能按第一个 / 切开。
 * 只接受两种精确写法：
 *   provider/modelId   —— modelId 里的 / 原样保留
 *   modelId            —— 仅当可用列表里这个 id 唯一时成立
 */

import type { Model } from "@earendil-works/pi-ai";

/** 目录里的一条模型。name 不填就用 id 的最后一段。 */
export interface ModelCatalogEntry {
  id: string;
  name?: string;
}

/** 一个 provider 的接入信息 + 它提供的模型 */
export interface ProviderCatalogEntry {
  baseUrl: string;
  api: string;
  models: ModelCatalogEntry[];
}

export type ModelCatalog = Record<string, ProviderCatalogEntry>;

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface ResolvedModelRef extends ModelRef {
  /** 在可用列表里命中的那条；没传列表时为空 */
  model?: Model<any>;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** 显示名：显式 name > id 最后一段 > id */
export function modelDisplayName(entry: Pick<ModelCatalogEntry, "id" | "name">): string {
  const named = clean(entry.name);
  if (named) return named;
  const slash = entry.id.lastIndexOf("/");
  return slash >= 0 ? entry.id.slice(slash + 1) : entry.id;
}

/**
 * 解析模型引用。
 * available 传入时，结果必须是其中一条（已配 Key 的模型）；
 * 不传时只做语法拆分，给 setup 这种还没加载运行时的场景用。
 */
export function resolveModelRef(
  input: { provider?: string; model?: string },
  available?: readonly Model<any>[],
): ResolvedModelRef | undefined {
  const provider = clean(input.provider);
  const model = clean(input.model);
  if (!provider && !model) return undefined;

  if (available) {
    return matchAvailable(provider, model, available);
  }

  if (provider && model) return { provider, modelId: model };
  if (provider || !model) return undefined;

  const slash = model!.indexOf("/");
  if (slash <= 0 || slash === model!.length - 1) return undefined;
  return { provider: model!.slice(0, slash), modelId: model!.slice(slash + 1) };
}

function matchAvailable(
  provider: string | undefined,
  model: string | undefined,
  available: readonly Model<any>[],
): ResolvedModelRef | undefined {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  if (provider && model) {
    const hit = available.find((m) => same(m.provider, provider) && same(m.id, model));
    return hit ? { provider: hit.provider, modelId: hit.id, model: hit } : undefined;
  }

  if (provider) return undefined;

  const text = model!;
  const canonical = available.filter((m) => same(`${m.provider}/${m.id}`, text));
  if (canonical.length === 1) {
    const hit = canonical[0]!;
    return { provider: hit.provider, modelId: hit.id, model: hit };
  }

  // 前缀正好是某个已注册 provider 时，剩下的整段都是模型 id（id 里可以有 /）
  const providers = new Map<string, string>();
  for (const m of available) providers.set(m.provider.toLowerCase(), m.provider);
  const slash = text.indexOf("/");
  if (slash > 0) {
    const canonicalProvider = providers.get(text.slice(0, slash).toLowerCase());
    if (canonicalProvider) {
      const modelId = text.slice(slash + 1);
      const hit = available.find((m) => m.provider === canonicalProvider && same(m.id, modelId));
      if (hit) return { provider: hit.provider, modelId: hit.id, model: hit };
    }
  }

  const byId = available.filter((m) => same(m.id, text));
  if (byId.length === 1) {
    const hit = byId[0]!;
    return { provider: hit.provider, modelId: hit.id, model: hit };
  }
  return undefined;
}

/** 一条轮换列表项的原始写法（provider/modelId + 可选思考档）。 */
export interface ScopedModelRef {
  ref: string;
  thinkingLevel?: string;
}

/** 解析后的 SDK ScopedModel（thinkingLevel 先以字符串承载，交给 createAgentSession 时再收窄）。 */
export interface ResolvedScopedModel {
  model: Model<any>;
  thinkingLevel?: string;
}

/**
 * 把轮换列表（`[{ ref, thinkingLevel? }]`）解析成官方 `createAgentSession({ scopedModels })`
 * 需要的 `[{ model, thinkingLevel? }]`。复用 `resolveModelRef`，因此带斜杠 id、
 * provider/model、裸唯一 id 的写法与单模型一致；只保留已配 Key（在 available 里）的条目。
 * 解析不出来的条目跳过（不因一条写错就废掉整个轮换列表）。
 */
export function resolveScopedModels(
  refs: readonly ScopedModelRef[],
  available: readonly Model<any>[],
): ResolvedScopedModel[] {
  const out: ResolvedScopedModel[] = [];
  const seen = new Set<string>();
  for (const item of refs) {
    const resolved = resolveModelRef({ model: item.ref }, available);
    if (!resolved?.model) continue;
    const key = `${resolved.provider}/${resolved.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      model: resolved.model,
      ...(item.thinkingLevel ? { thinkingLevel: item.thinkingLevel } : {}),
    });
  }
  return out;
}

/** 解析失败时的报错：列出当前真正能用的模型，而不是让人去猜 */
export function formatModelChoices(available: readonly Model<any>[]): string {
  if (available.length === 0) return "（当前没有已配置 Key 的模型）";
  return available.map((m) => `  ${m.provider}/${m.id}`).join("\n");
}

export function unknownModelError(
  input: { provider?: string; model?: string },
  available: readonly Model<any>[],
): Error {
  const asked = [input.provider, input.model].filter(Boolean).join("/");
  return new Error(
    `找不到模型 ${asked}。可用的是：\n${formatModelChoices(available)}\n` +
      "写法：--model <provider>/<modelId>，或 --provider <provider> --model <modelId>",
  );
}
