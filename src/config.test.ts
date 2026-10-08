import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliFlags } from "./cli-args.js";
import {
  parseBuiltinToolMode,
  parseScopedModelRefs,
  requireConfiguredModel,
  resolveRetrievalConfig,
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
  // sqlite 向量库后端
  assert.deepEqual(
    resolveRetrievalConfig({ PI_KNOWLEDGE_RETRIEVAL: "vector", PI_KNOWLEDGE_VECTOR_STORE: "sqlite", PI_KNOWLEDGE_VECTOR_DB_PATH: "./v.db" }),
    { mode: "vector", vectorStore: { backend: "sqlite", path: "./v.db" } },
  );
});
