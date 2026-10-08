import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_API,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  mergeAuthJson,
  mergeModelsJson,
  setupPiAgentDir,
} from "./setup.js";
import type { ModelCatalog } from "./models.js";

const modelscopeCatalog: ModelCatalog = {
  [DEFAULT_PROVIDER]: {
    baseUrl: DEFAULT_BASE_URL,
    api: DEFAULT_API,
    models: [{ id: DEFAULT_MODEL_ID, name: "Qwen3-Next-80B" }],
  },
};

test("mergeModelsJson 写入 modelscope 且不碰其他 provider", () => {
  const merged = mergeModelsJson(
    { providers: { zhipu: { baseUrl: "https://example.test" } } },
    modelscopeCatalog,
  );
  assert.equal(merged.providers?.zhipu?.baseUrl, "https://example.test");
  assert.equal(merged.providers?.modelscope?.baseUrl, DEFAULT_BASE_URL);
  assert.equal(merged.providers?.modelscope?.api, DEFAULT_API);
  assert.deepEqual(merged.providers?.modelscope?.models, [
    { id: DEFAULT_MODEL_ID, name: "Qwen3-Next-80B" },
  ]);
});

test("mergeModelsJson 已有同 id 模型不重复，已有 baseUrl 不覆盖", () => {
  const merged = mergeModelsJson(
    {
      providers: {
        modelscope: {
          baseUrl: "https://custom.example/v1",
          api: "openai-completions",
          models: [{ id: DEFAULT_MODEL_ID, name: "old" }],
        },
      },
    },
    modelscopeCatalog,
  );
  assert.equal(merged.providers?.modelscope?.baseUrl, "https://custom.example/v1");
  assert.equal(merged.providers?.modelscope?.models?.length, 1);
  assert.equal(merged.providers?.modelscope?.models?.[0]?.name, "old");
});

test("mergeModelsJson 一次写入多个 provider，同 provider 追加不覆盖", () => {
  const merged = mergeModelsJson(undefined, {
    modelscope: {
      baseUrl: DEFAULT_BASE_URL,
      api: DEFAULT_API,
      models: [
        { id: DEFAULT_MODEL_ID },
        { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen2.5-72B" },
      ],
    },
    zhipu: {
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      api: "openai-completions",
      models: [{ id: "glm-4.5-air" }],
    },
  });
  // 无 name 的条目由 modelDisplayName 取名（斜杠后最后一段）；从常量推导，不写死默认模型名。
  assert.equal(
    merged.providers?.modelscope?.models?.[0]?.name,
    DEFAULT_MODEL_ID.slice(DEFAULT_MODEL_ID.lastIndexOf("/") + 1),
  );
  assert.equal(merged.providers?.modelscope?.models?.[1]?.name, "Qwen2.5-72B");
  assert.equal(merged.providers?.zhipu?.models?.[0]?.id, "glm-4.5-air");
});

test("mergeAuthJson 缺 key 且没有已有凭据时 fail-fast", () => {
  assert.throws(() => mergeAuthJson({}, "modelscope", "  "), /API Key/);
  assert.throws(() => mergeAuthJson(undefined, "modelscope", undefined), /API Key/);
});

test("mergeAuthJson 已有 key 默认保留，--force 才覆盖", () => {
  const existing = { modelscope: { type: "api_key", key: "ms-old" } };
  const kept = mergeAuthJson(existing, "modelscope", "ms-new");
  assert.equal(kept.wroteKey, false);
  assert.equal(kept.keptExisting, true);
  assert.equal((kept.next.modelscope as { key: string }).key, "ms-old");

  const forced = mergeAuthJson(existing, "modelscope", "ms-new", { force: true });
  assert.equal(forced.wroteKey, true);
  assert.equal((forced.next.modelscope as { key: string }).key, "ms-new");
});

test("setupPiAgentDir 写入临时目录，缺 key 不落盘", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-starter-setup-"));
  assert.throws(
    () =>
      setupPiAgentDir({
        agentDir,
        env: {
          PI_PROVIDER: DEFAULT_PROVIDER,
          PI_MODEL: DEFAULT_MODEL_ID,
          PI_BASE_URL: DEFAULT_BASE_URL,
          PI_API_KEY: "",
        },
      }),
    /API Key/,
  );
  assert.throws(() => readFileSync(join(agentDir, "auth.json"), "utf-8"), /ENOENT/);
});

test("setupPiAgentDir 在临时目录 merge 模型并写入 key，第二次不覆盖", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-starter-setup-"));
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({ providers: { zhipu: { baseUrl: "https://keep.example" } } }),
    "utf-8",
  );

  const first = setupPiAgentDir({
    agentDir,
    env: {
      PI_PROVIDER: DEFAULT_PROVIDER,
      PI_MODEL: DEFAULT_MODEL_ID,
      PI_API_KEY: "ms-test-key",
    },
  });
  assert.equal(first.authKeyWritten.includes(DEFAULT_PROVIDER), true);
  const auth1 = JSON.parse(readFileSync(first.authPath, "utf-8")) as {
    modelscope: { key: string };
  };
  assert.equal(auth1.modelscope.key, "ms-test-key");

  const second = setupPiAgentDir({
    agentDir,
    env: {
      PI_PROVIDER: DEFAULT_PROVIDER,
      PI_MODEL: DEFAULT_MODEL_ID,
      PI_API_KEY: "ms-should-not-write",
    },
  });
  assert.equal(second.authKeyKept.includes(DEFAULT_PROVIDER), true);
  const auth2 = JSON.parse(readFileSync(second.authPath, "utf-8")) as {
    modelscope: { key: string };
  };
  assert.equal(auth2.modelscope.key, "ms-test-key");

  const models = JSON.parse(readFileSync(second.modelsPath, "utf-8")) as {
    providers: { zhipu: { baseUrl: string }; modelscope: { models: { id: string }[] } };
  };
  assert.equal(models.providers.zhipu.baseUrl, "https://keep.example");
  assert.equal(models.providers.modelscope.models[0]?.id, DEFAULT_MODEL_ID);
});
