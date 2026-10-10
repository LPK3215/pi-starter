import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `setupPiAgentDir` 在没传 `env` 时会 `loadEnvFile()`，也就是**写 process.env**。
 * 跑完必须整体还原，否则会污染同进程里其它用例（例如那些读 PI_API_KEY 的）。
 */
function withEnvSnapshot<T>(fn: () => T): T {
  const before = { ...process.env };
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in before)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(before)) process.env[key] = value;
  }
}
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

test("没有 .env 时从 .env.example 复制一份，且复制出来的 .env **不能是世界可读**", () => {
  // 回归：`copyFileSync` 会沿用源文件权限位，而 `.env.example` 是 0644 ——
  // 于是 `npm run setup` 造出来的 `.env`（用户马上要在里面填 API Key）是 644 世界可读。
  const cwd = mkdtempSync(join(tmpdir(), "pi-setup-cwd-"));
  const agentDir = join(cwd, "agent");
  writeFileSync(
    join(cwd, ".env.example"),
    `PI_PROVIDER=${DEFAULT_PROVIDER}\nPI_MODEL=${DEFAULT_MODEL_ID}\nPI_API_KEY=sk-from-example\n`,
    "utf-8",
  );
  chmodSync(join(cwd, ".env.example"), 0o644); // 仓库里的真实权限

  const result = withEnvSnapshot(() => {
    // 清掉可能存在的同名外层变量，确保读到的是刚复制出来的 .env。
    for (const key of ["PI_PROVIDER", "PI_MODEL", "PI_MODELS", "PI_API_KEY", "PI_BASE_URL"]) {
      delete process.env[key];
    }
    return setupPiAgentDir({ cwd, agentDir });
  });

  assert.equal(result.copiedEnvExample, true);
  assert.equal(statSync(join(cwd, ".env")).mode & 0o777, 0o600, ".env 必须 0600，它要装 API Key");
  assert.equal(
    JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"))[DEFAULT_PROVIDER].key,
    "sk-from-example",
    "复制出来的 .env 要被真的读进去",
  );
});

test("已有 .env 时不覆盖，copiedEnvExample 为 false", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-setup-cwd-"));
  writeFileSync(join(cwd, ".env"), "PI_API_KEY=sk-already-there\n", "utf-8");
  writeFileSync(join(cwd, ".env.example"), "PI_API_KEY=sk-from-example\n", "utf-8");
  const result = withEnvSnapshot(() =>
    setupPiAgentDir({ cwd, agentDir: join(cwd, "agent"), env: { PI_API_KEY: "sk-x" } }),
  );
  assert.equal(result.copiedEnvExample, false, "已有 .env 绝不能被 .env.example 覆盖掉");
  assert.equal(readFileSync(join(cwd, ".env"), "utf-8"), "PI_API_KEY=sk-already-there\n");
});

test("既没有 .env 也没有 .env.example 时明确报错", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-setup-cwd-"));
  assert.throws(() => setupPiAgentDir({ cwd, agentDir: join(cwd, "agent") }), /也没有 \.env\.example 可复制/);
});

test("多 provider：没找到密钥的只进 authKeyMissing 且不落盘；默认 provider 缺密钥才致命", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-starter-setup-"));
  const catalog =
    `prov-a|https://a.example/v1|openai-completions|model-a:Model A;` +
    `prov-b|https://b.example/v1|openai-completions|model-b:Model B`;

  const result = setupPiAgentDir({
    agentDir,
    env: {
      PI_MODELS: catalog,
      PI_PROVIDER: "prov-a",
      PI_MODEL: "model-a",
      PI_API_KEY: "sk-a",
    },
  });
  assert.deepEqual(result.authKeyWritten, ["prov-a"]);
  assert.deepEqual(result.authKeyMissing, ["prov-b"], "没密钥的 provider 要被记下来而不是抛错");
  const auth = JSON.parse(readFileSync(result.authPath, "utf-8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(auth), ["prov-a"], "没密钥的 provider 不该出现在 auth.json 里");

  // 默认 provider 一个密钥都没有 → 这次 setup 没意义，必须直接失败，而不是写出一个跑不起来的目录。
  // 注意默认 provider 会回落到 `PI_API_KEY`，所以这里连它也不给才触发得到这条分支。
  const another = mkdtempSync(join(tmpdir(), "pi-starter-setup-"));
  assert.throws(
    () =>
      setupPiAgentDir({
        agentDir: another,
        env: { PI_MODELS: catalog, PI_PROVIDER: "prov-b", PI_MODEL: "model-b" },
      }),
    /缺少 prov-b 的 API Key/,
  );
  assert.throws(() => readFileSync(join(another, "auth.json"), "utf-8"), /ENOENT/, "失败时不该落盘");
});

test("provider 专属密钥优先，且名字里的 `-` 会换算成 `_`", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-starter-setup-"));
  const result = setupPiAgentDir({
    agentDir,
    env: {
      PI_MODELS: "my-prov|https://x.example/v1|openai-completions|model-x:Model X",
      PI_PROVIDER: "my-prov",
      PI_MODEL: "model-x",
      PI_API_KEY: "sk-default",
      PI_API_KEY_MY_PROV: "sk-specific",
    },
  });
  const auth = JSON.parse(readFileSync(result.authPath, "utf-8")) as Record<string, { key: string }>;
  assert.equal(auth["my-prov"]?.key, "sk-specific", "PI_API_KEY_<PROVIDER> 必须优先于 PI_API_KEY");
});

test("权限：auth.json 是 0600、agent 目录是 0700（与 provider-keys / 向量库同一口径）", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-starter-setup-"));
  const result = setupPiAgentDir({
    agentDir,
    env: { PI_PROVIDER: DEFAULT_PROVIDER, PI_MODEL: DEFAULT_MODEL_ID, PI_API_KEY: "sk-perm" },
  });
  assert.equal(statSync(result.authPath).mode & 0o777, 0o600, "auth.json 里有明文密钥");
  // agentDir 由 mkdtempSync 预建（0700），这里确认 setup 不会把它放宽。
  assert.equal(statSync(agentDir).mode & 0o777, 0o700);
  // models.json 里没有密钥，不强制 0600（不做无意义的断言，只记录它不是机密）。
  assert.ok(statSync(result.modelsPath).isFile());
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
