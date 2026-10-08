import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelCatalog, resolveCatalog, resolveDefaultModel } from "./config.js";
import { modelDisplayName, resolveModelRef, resolveScopedModels } from "./models.js";
import type { Model } from "@earendil-works/pi-ai";

function model(provider: string, id: string): Model<any> {
  return { provider, id } as Model<any>;
}

const available = [
  model("modelscope", "Qwen/Qwen3-Next-80B-A3B-Instruct"),
  model("modelscope", "Qwen/Qwen2.5-72B-Instruct"),
  model("zhipu", "glm-4.5-air"),
];

test("provider/modelId 精确命中，模型 id 里的斜杠原样保留", () => {
  const hit = resolveModelRef(
    { model: "modelscope/Qwen/Qwen3-Next-80B-A3B-Instruct" },
    available,
  );
  assert.equal(hit?.provider, "modelscope");
  assert.equal(hit?.modelId, "Qwen/Qwen3-Next-80B-A3B-Instruct");
});

test("provider 和 model 分开传时，model 不再被当成引用拆开", () => {
  const hit = resolveModelRef(
    { provider: "modelscope", model: "Qwen/Qwen2.5-72B-Instruct" },
    available,
  );
  assert.equal(hit?.modelId, "Qwen/Qwen2.5-72B-Instruct");
});

test("裸 modelId 只在唯一时命中，重名或未知返回空", () => {
  assert.equal(resolveModelRef({ model: "glm-4.5-air" }, available)?.provider, "zhipu");
  assert.equal(resolveModelRef({ model: "nope" }, available), undefined);
});

test("没有可用列表时只做语法拆分，供 setup 使用", () => {
  const ref = resolveModelRef({ model: "modelscope/Qwen/Qwen3-Next-80B-A3B-Instruct" });
  assert.deepEqual(ref, {
    provider: "modelscope",
    modelId: "Qwen/Qwen3-Next-80B-A3B-Instruct",
  });
  assert.equal(resolveModelRef({}), undefined);
});

test("显示名：显式 name 优先，否则取 id 最后一段", () => {
  assert.equal(modelDisplayName({ id: "Qwen/Qwen3-Next-80B-A3B-Instruct" }), "Qwen3-Next-80B-A3B-Instruct");
  assert.equal(modelDisplayName({ id: "glm-4.5-air", name: "GLM Air" }), "GLM Air");
});

test("PI_MODELS 解析多个 provider，显示名可选", () => {
  const catalog = parseModelCatalog(
    "modelscope|https://api-inference.modelscope.cn/v1|openai-completions|Qwen/Qwen3-Next-80B-A3B-Instruct:Qwen3-Next-80B,Qwen/Qwen2.5-72B-Instruct;" +
      "zhipu|https://open.bigmodel.cn/api/paas/v4|openai-completions|glm-4.5-air",
  );
  assert.equal(catalog.modelscope?.models.length, 2);
  assert.equal(catalog.modelscope?.models[0]?.name, "Qwen3-Next-80B");
  assert.equal(catalog.modelscope?.models[1]?.name, undefined);
  assert.equal(catalog.zhipu?.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
});

test("PI_MODELS 格式不对直接抛", () => {
  assert.throws(() => parseModelCatalog("modelscope|only-two"), /provider\|baseUrl\|api\|/);
});

test("没写 PI_MODELS 时，PI_MODEL 写成 provider/modelId 就以它的 provider 为准", () => {
  const catalog = resolveCatalog(
    { model: "zhipu/glm-4.5-air", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
    { baseUrl: "https://fallback.example/v1", api: "openai-completions" },
  );
  assert.deepEqual(Object.keys(catalog), ["zhipu"]);
  assert.equal(catalog.zhipu?.models[0]?.id, "glm-4.5-air");
  assert.equal(catalog.zhipu?.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
});

test("PI_PROVIDER 与 PI_MODEL 同时给时，模型 id 里的斜杠原样保留", () => {
  const catalog = resolveCatalog(
    { provider: "modelscope", model: "Qwen/Qwen3-Next-80B-A3B-Instruct" },
    { baseUrl: "https://fallback.example/v1", api: "openai-completions" },
  );
  assert.deepEqual(Object.keys(catalog), ["modelscope"]);
  assert.equal(catalog.modelscope?.models[0]?.id, "Qwen/Qwen3-Next-80B-A3B-Instruct");
});

test("默认模型：命令行整段引用优先于 .env 的 provider + model", () => {
  const selected = resolveDefaultModel(
    { model: "zhipu/glm-4.5-air" },
    { provider: "modelscope", model: "Qwen/Qwen3-Next-80B-A3B-Instruct" },
  );
  assert.deepEqual(selected, { provider: "zhipu", modelId: "glm-4.5-air" });
});

test("resolveScopedModels：解析轮换列表，带斜杠 id / 思考档 / 去重 / 跳过未配 Key", () => {
  const resolved = resolveScopedModels(
    [
      { ref: "modelscope/Qwen/Qwen3-Next-80B-A3B-Instruct", thinkingLevel: "high" },
      { ref: "zhipu/glm-4.5-air" },
      { ref: "zhipu/glm-4.5-air" }, // 重复 → 去重
      { ref: "openai/gpt-5" }, // 不在 available（未配 Key）→ 跳过
    ],
    available,
  );
  assert.equal(resolved.length, 2, "去重 + 跳过未知项后剩两条");
  assert.equal(resolved[0]?.model.id, "Qwen/Qwen3-Next-80B-A3B-Instruct");
  assert.equal(resolved[0]?.thinkingLevel, "high");
  assert.equal(resolved[1]?.model.provider, "zhipu");
  assert.equal(resolved[1]?.thinkingLevel, undefined, "无思考档时不带该字段");
});
