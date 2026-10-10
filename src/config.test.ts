import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliFlags } from "./cli-args.js";
import {
  parseBuiltinToolMode,
  parseScopedModelRefs,
  requireConfiguredModel,
  resolveMemoryConfig,
  resolveRetrievalConfig,
  resolveSdkSettings,
  resolveExtensionPaths,
  sessionToolPolicy,
} from "./config.js";

test("off 档打开 read，好让 SDK 把技能目录写进系统提示词", () => {
  assert.deepEqual(sessionToolPolicy("off", ["current_time"]), {
    tools: ["read", "current_time"],
  });
});

test("readonly / coding 把自定义工具名并进 allowlist", () => {
  assert.deepEqual(sessionToolPolicy("readonly", ["current_time"]), {
    tools: ["read", "grep", "find", "ls", "current_time"],
  });
  assert.deepEqual(sessionToolPolicy("coding", ["current_time", "current_time"]), {
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "current_time"],
  });
});

test("非法内置工具档位直接抛，不静默回落 SDK 默认", () => {
  assert.equal(parseBuiltinToolMode(undefined), undefined);
  assert.equal(parseBuiltinToolMode("CODING"), "coding");
  assert.throws(() => parseBuiltinToolMode("all"), /off \| readonly \| coding/);
});

test("命令行 flag 解析跳过缺值的 --name", () => {
  assert.deepEqual(
    parseCliFlags(["--provider", "zhipu", "--model", "glm-4.5-air", "--builtin-tools", "coding", "--port", "8080"]),
    { provider: "zhipu", model: "glm-4.5-air", builtinTools: "coding", port: 8080 },
  );
  assert.deepEqual(parseCliFlags(["--port", "nope"]), {
    provider: undefined,
    model: undefined,
    builtinTools: undefined,
    port: undefined,
  });
  assert.deepEqual(parseCliFlags(["--provider"]), {
    provider: undefined,
    model: undefined,
    builtinTools: undefined,
    port: undefined,
  });
});

test("未指定 provider 或 model 直接抛，不落到 SDK 默认模型", () => {
  assert.throws(() => requireConfiguredModel({ provider: undefined, modelId: undefined }), /未指定模型/);
  assert.throws(
    () => requireConfiguredModel({ provider: "modelscope", modelId: undefined }),
    /未指定模型/,
  );
  assert.doesNotThrow(() => {
    requireConfiguredModel({
      provider: "modelscope",
      modelId: "Qwen/Qwen3-Next-80B-A3B-Instruct",
    });
  });
});

test("parseScopedModelRefs：逗号分隔的 provider/model[:thinkingLevel]，斜杠不受影响", () => {
  const refs = parseScopedModelRefs(
    "modelscope/Qwen/Qwen3-Next-80B-A3B-Instruct:high,zhipu/glm-4.5-air",
  );
  assert.deepEqual(refs, [
    { ref: "modelscope/Qwen/Qwen3-Next-80B-A3B-Instruct", thinkingLevel: "high" },
    { ref: "zhipu/glm-4.5-air" },
  ]);
  assert.deepEqual(parseScopedModelRefs(undefined), []);
  assert.deepEqual(parseScopedModelRefs("  "), []);
});

test("parseCliFlags：--mode 仅在传了时出现，缺省不改变旧形状", () => {
  assert.deepEqual(parseCliFlags(["--mode", "rpc"]), {
    provider: undefined,
    model: undefined,
    builtinTools: undefined,
    mode: "rpc",
    port: undefined,
  });
  assert.equal("mode" in parseCliFlags([]), false);
});

test("resolveRetrievalConfig：默认 keyword；vector 需配 base+model 才给 embeddings", () => {
  assert.deepEqual(resolveRetrievalConfig({}), { mode: "keyword" });
  assert.deepEqual(resolveRetrievalConfig({ PI_KNOWLEDGE_RETRIEVAL: "keyword" }), { mode: "keyword" });
  // vector 但缺 base/model（openai）→ mode=vector、无 embeddings（agent 会据此报错）
  assert.deepEqual(resolveRetrievalConfig({ PI_KNOWLEDGE_RETRIEVAL: "vector" }), { mode: "vector" });
  assert.deepEqual(
    resolveRetrievalConfig({
      PI_KNOWLEDGE_RETRIEVAL: "VECTOR",
      PI_EMBEDDINGS_BASE_URL: "https://x/v1",
      PI_EMBEDDINGS_MODEL: "m",
      PI_EMBEDDINGS_KEY: "k",
    }),
    { mode: "vector", embeddings: { provider: "openai", baseUrl: "https://x/v1", model: "m", apiKey: "k" } },
  );
  // transformers：进程内推理，不要求 base/model
  assert.deepEqual(
    resolveRetrievalConfig({ PI_KNOWLEDGE_RETRIEVAL: "vector", PI_EMBEDDINGS_PROVIDER: "transformers", PI_EMBEDDINGS_MODEL: "Xenova/x", PI_EMBEDDINGS_CACHE_DIR: "C:/hf" }),
    { mode: "vector", embeddings: { provider: "transformers", model: "Xenova/x", cacheDir: "C:/hf" } },
  );
  // transformers + HF 镜像端点
  assert.deepEqual(
    resolveRetrievalConfig({ PI_KNOWLEDGE_RETRIEVAL: "vector", PI_EMBEDDINGS_PROVIDER: "transformers", PI_EMBEDDINGS_HF_ENDPOINT: "hf-mirror.com" }),
    { mode: "vector", embeddings: { provider: "transformers", model: "", remoteHost: "hf-mirror.com" } },
  );
  // sqlite 向量库后端
  assert.deepEqual(
    resolveRetrievalConfig({ PI_KNOWLEDGE_RETRIEVAL: "vector", PI_KNOWLEDGE_VECTOR_STORE: "sqlite", PI_KNOWLEDGE_VECTOR_DB_PATH: "./v.db" }),
    { mode: "vector", vectorStore: { backend: "sqlite", path: "./v.db" } },
  );
});

test("resolveSdkSettings：无任何 env → 空对象（不建 SettingsManager，行为不变）", () => {
  assert.deepEqual(resolveSdkSettings({}), {});
});

test("resolveSdkSettings：compaction/retry/images/enabledModels 逐组解析", () => {
  assert.deepEqual(
    resolveSdkSettings({
      PI_COMPACTION_ENABLED: "true",
      PI_COMPACTION_RESERVE_TOKENS: "8000",
      PI_RETRY_BASE_DELAY_MS: "500",
      PI_IMAGES_BLOCK: "on",
      PI_ENABLED_MODELS: "openai/gpt-4o, anthropic/claude",
    }),
    {
      compaction: { enabled: true, reserveTokens: 8000 },
      retry: { baseDelayMs: 500 },
      images: { blockImages: true },
      enabledModels: ["openai/gpt-4o", "anthropic/claude"],
    },
  );
});

test("resolveSdkSettings：非法整数值被丢弃（不静默传 NaN）", () => {
  assert.deepEqual(resolveSdkSettings({ PI_COMPACTION_RESERVE_TOKENS: "abc" }), {});
});

test("resolveExtensionPaths：逗号拆分 + 去空；未设→空数组", () => {
  assert.deepEqual(resolveExtensionPaths({ PI_EXTENSION_PATHS: "a.ts, b.ts ,, c.js" }), ["a.ts", "b.ts", "c.js"]);
  assert.deepEqual(resolveExtensionPaths({}), []);
});

test("resolveSdkSettings：新增的出站超时/队列模式/思考预算/分支摘要透传", () => {
  assert.deepEqual(
    resolveSdkSettings({
      PI_HTTP_IDLE_TIMEOUT_MS: "300000",
      PI_STEERING_MODE: "one-at-a-time",
      PI_THINKING_BUDGET_HIGH: "2048",
      PI_BRANCH_SUMMARY_SKIP: "true",
    }),
    {
      httpIdleTimeoutMs: 300000,
      steeringMode: "one-at-a-time",
      thinkingBudgets: { high: 2048 },
      branchSummary: { skipPrompt: true },
    },
  );
});

test("resolveSdkSettings：非法枚举值被丢弃（不静默传给 SDK）", () => {
  // 两个都是非法值 → 全丢。
  assert.deepEqual(resolveSdkSettings({ PI_STEERING_MODE: "bogus", PI_FOLLOW_UP_MODE: "nope" }), {});
  // ALL 大写 → 小写化后 = all，合法。
  assert.deepEqual(resolveSdkSettings({ PI_FOLLOW_UP_MODE: "ALL" }), { followUpMode: "all" });
});

test("PI_MEMORY：默认开，只有明确的 off/false/0 才算关（与 PI_WEB 的取值风格一致）", () => {
  assert.deepEqual(resolveMemoryConfig({}), { enabled: true });
  assert.deepEqual(resolveMemoryConfig({ PI_MEMORY: "on" }), { enabled: true });
  assert.deepEqual(resolveMemoryConfig({ PI_MEMORY: "yes" }), { enabled: true }, "拼错不等于关，也不等于开——默认就是开");
  assert.deepEqual(resolveMemoryConfig({ PI_MEMORY: "off" }), { enabled: false });
  assert.deepEqual(resolveMemoryConfig({ PI_MEMORY: "FALSE" }), { enabled: false });
  assert.deepEqual(resolveMemoryConfig({ PI_MEMORY: "0" }), { enabled: false });
});

test("PI_MEMORY_PATH：给了就带上，未设则不带（交给 store 的默认路径）", () => {
  assert.deepEqual(resolveMemoryConfig({ PI_MEMORY_PATH: "/tmp/m.jsonl" }), {
    enabled: true,
    path: "/tmp/m.jsonl",
  });
  assert.deepEqual(resolveMemoryConfig({ PI_MEMORY_PATH: "  " }).path, undefined, "纯空白视为未设");
});
