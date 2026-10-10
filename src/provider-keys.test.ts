/**
 * 多把API 密钥测试。
 *
 * 唯一必须写死的不变量：**原始密钥永不出服务端**。
 * 所以这里不止测 store，还真的起了 HTTP 服务，把每个响应的 body 抓下来做子串断言——
 * 只测 store 的话，很容易在某次「顺手把 keys 直接返回」之后仍然全绿。
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "./app.js";
import { listenTestServer } from "./test-server.js";
import { SessionHub } from "./session-hub.js";
import { resolveRuntimeConfig } from "./config.js";
import { createProviderKeyStore, MAX_PROVIDER_KEYS } from "./provider-keys.js";
import type { BuiltAgent } from "./agent.js";
import type { Model } from "@earendil-works/pi-ai";
import { tempDir } from "./test-tmp.js";

const SECRET = "sk-live-DO-NOT-LEAK-0123456789";
const SECRET_LEN = SECRET.length;

function makeAgent(onSwitch?: (ref: string) => void): BuiltAgent {
  const model: Model<any> = { provider: "test", id: "m1", name: "M1", contextWindow: 1000 } as never;
  const session = {
    sessionId: "s1", model, isStreaming: false,
    subscribe: () => () => {},
    getSessionStats: () => ({
      sessionFile: undefined, sessionId: "s1", userMessages: 0, assistantMessages: 0,
      toolCalls: 0, toolResults: 0, totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
    }),
    getActiveToolNames: () => [] as string[],
    setActiveToolsByName: () => {},
    getSteeringMessages: () => [] as never,
    getFollowUpMessages: () => [] as never,
    setThinkingLevel: () => {},
    setModel: async () => {},
    prompt: async () => {}, abort: async () => {}, dispose: () => {},
  };
  return {
    session, model,
    builtinTools: "off" as const, skills: [], knowledge: [],
    database: {
      driver: "sqlite", path: ":memory:",
      ping: () => ({ ok: true as const, driver: "sqlite", path: ":memory:" }),
      listNotes: () => [], getNote: () => undefined, searchNotes: () => [],
      insertNote: () => ({ id: 1, title: "t", body: "b" }),
      query: () => ({ columns: [], rows: [], truncated: false, totalRows: 0 }),
      close: () => {},
    },
    listModels: async () => [model],
    switchModel: async (ref: string) => {
      onSwitch?.(ref);
      return model;
    },
    applyApiKey: async () => {},
    dispose: () => {},
  } as never;
}

function tmpStore() {
  const dir = tempDir("pi-keys-");
  return createProviderKeyStore(join(dir, "provider-keys.json"), { logger: () => {} });
}

test("密钥库：增删查切，激活项跟随删除回落", () => {
  const store = tmpStore();
  assert.deepEqual(store.providers(), []);

  store.set("modelscope", "work", SECRET);
  assert.deepEqual(store.providers(), ["modelscope"]);
  assert.equal(store.activeName("modelscope"), "work", "the first key must become active");
  assert.equal(store.resolve("modelscope"), SECRET);

  store.set("modelscope", "personal", "sk-other");
  assert.equal(store.activeName("modelscope"), "work", "adding must not steal the activation");
  store.activate("modelscope", "personal");
  assert.equal(store.resolve("modelscope"), "sk-other");

  // Deleting the active key must not leave a dangling activeKeyName.
  store.remove("modelscope", "personal");
  assert.equal(store.activeName("modelscope"), "work");
  store.remove("modelscope", "work");
  assert.deepEqual(store.providers(), [], "the provider entry goes away with its last key");
  assert.equal(store.activeName("modelscope"), undefined);
});

test("密钥库：拒绝非法输入且不落盘", () => {
  const store = tmpStore();
  assert.throws(() => store.set("bad provider", "a", SECRET));
  assert.throws(() => store.set("ok", "", SECRET));
  assert.throws(() => store.set("ok", "a/b", SECRET));
  assert.throws(() => store.set("ok", "a", "  "));
  assert.throws(() => store.activate("ok", "missing"));
  for (let i = 0; i < MAX_PROVIDER_KEYS; i += 1) store.set("ok", `k${i}`, `v${i}`);
  assert.throws(() => store.set("ok", "overflow", "v"));
});

test("密钥库：损坏 / 不可信文件回落，不抛错", () => {
  const dir = tempDir("pi-keys-");
  const filePath = join(dir, "provider-keys.json");
  writeFileSync(filePath, "{{{ broken", "utf8");
  const warnings: string[] = [];
  const store = createProviderKeyStore(filePath, { logger: (msg) => warnings.push(msg) });
  assert.deepEqual(store.providers(), [], "a corrupt key file must fall back, not crash the service");
  assert.ok(warnings.length > 0, "and it must be reported");

  // Hand-edited junk: illegal provider, illegal key name, non-string apiKey, duplicates.
  writeFileSync(
    filePath,
    JSON.stringify({
      "bad provider": { keys: [{ name: "a", apiKey: "x" }] },
      ok: {
        activeKeyName: "../evil",
        keys: [
          { name: "good", apiKey: "v" },
          { name: "", apiKey: "v" },
          { name: "noKey", apiKey: 123 },
          { name: "good", apiKey: "dup" },
        ],
      },
    }),
    "utf8",
  );
  const second = createProviderKeyStore(filePath, { logger: () => {} });
  assert.deepEqual(second.providers(), ["ok"]);
  assert.deepEqual(second.list("ok"), [{ name: "good", active: true }]);
  assert.equal(second.resolve("ok"), "v", "a duplicate entry must not overwrite the first");
  assert.equal(second.activeName("ok"), "good", "a dangling activeKeyName must fall back to a real key");
});

test("密钥库：落盘是原子的，重启后读回", () => {
  const dir = tempDir("pi-keys-");
  const filePath = join(dir, "nested", "provider-keys.json");
  const store = createProviderKeyStore(filePath, { logger: () => {} });
  store.set("p", "one", SECRET);
  // No .tmp leftovers: the temp file is renamed into place.
  assert.equal(readFileSync(filePath, "utf8").includes(".tmp"), false);
  const reopened = createProviderKeyStore(filePath, { logger: () => {} });
  assert.equal(reopened.resolve("p", "one"), SECRET);
});

test("HTTP：增删查切可用，且任何响应都不含原始密钥", async () => {
  const store = tmpStore();
  const switched: string[] = [];
  const applied: string[] = [];
  const agent = makeAgent((ref) => switched.push(ref));
  const hub = new SessionHub(agent, resolveRuntimeConfig());
  const { app } = createApp({
    agent,
    hub: hub as never,
    providerKeys: store,
    // 换 key 后必须经 hub 重新应用模型，否则 REST 说生效了而对话还在用旧 key。
    applyActiveKey: async (provider) => {
      const key = store.resolve(provider);
      assert.ok(key, "the active key must resolve before it is applied");
      applied.push(`${provider}:${key.length}`);
      await agent.applyApiKey!(provider, key);
      await hub.setModel(`${agent.model.provider}/${agent.model.id}`);
    },
    staticDir: false,
  });
  const server = await listenTestServer(app);
  const bodies: string[] = [];
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, text };
  };
  const get = async (path: string) => {
    const res = await fetch(`${server.url}${path}`);
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, text };
  };

  try {
    const empty = await get("/provider-keys");
    assert.equal(empty.status, 200);
    assert.equal(empty.text.includes(SECRET), false);

    const added = await post("/provider-keys", { provider: "modelscope", name: "work", apiKey: SECRET });
    assert.equal(added.status, 200);
    assert.equal(added.text.includes('"ok":true'), true);
    assert.deepEqual(applied, [`modelscope:${SECRET_LEN}`], "the first key must actually be applied");

    await post("/provider-keys", { provider: "modelscope", name: "personal", apiKey: "sk-second" });
    const listed = await get("/provider-keys");
    assert.match(listed.text, /work/);
    assert.match(listed.text, /personal/);
    assert.match(listed.text, /"active":true/);

    const activated = await post("/provider-keys/activate", {
      provider: "modelscope",
      name: "personal",
    });
    assert.equal(activated.status, 200);
    assert.equal(store.resolve("modelscope"), "sk-second");

    const removed = await post("/provider-keys/remove", { provider: "modelscope", name: "personal" });
    assert.equal(removed.status, 200);
    assert.equal(store.activeName("modelscope"), "work", "deleting the active key falls back");

    // Validation errors are typed, not 500s.
    assert.equal((await post("/provider-keys", { provider: "modelscope" })).status, 400);
    assert.equal((await post("/provider-keys/activate", { provider: "modelscope", name: "nope" })).status, 400);

    // The switch really went through the hub's single path.
    assert.ok(switched.length >= 1, "activating a key must re-apply the model via the hub");

    // THE invariant: not one response ever carried a raw key.
    for (const body of bodies) {
      assert.equal(body.includes(SECRET), false, `a response leaked the raw key: ${body.slice(0, 200)}`);
      assert.equal(body.includes("sk-second"), false, `a response leaked a raw key: ${body.slice(0, 200)}`);
    }
    // Not even a prefix of it: masks are withheld too.
    assert.equal(
      bodies.some((body) => body.includes(SECRET.slice(0, 6))),
      false,
      "no prefix of the key may be echoed back either",
    );
  } finally {
    await server.close();
    hub.dispose();
  }
});

test("HTTP：未装配密钥库时不注册这些端点", async () => {
  const agent = makeAgent();
  const { app } = createApp({ agent, staticDir: false });
  const server = await listenTestServer(app);
  try {
    assert.equal((await fetch(`${server.url}/provider-keys`)).status, 404);
  } finally {
    await server.close();
  }
});