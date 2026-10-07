import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliFlags } from "./cli-args.js";
import {
  parseBuiltinToolMode,
  requireConfiguredModel,
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
