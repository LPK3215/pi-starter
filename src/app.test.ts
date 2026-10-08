import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import type { BuiltAgent } from "./agent.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { openDatabase } from "./db/index.js";
import { loadKnowledgeFromDirs } from "./knowledge/index.js";
import { loadSkillsFromDirs } from "./skills/index.js";

type Listener = (event: AgentSessionEvent) => void;

function fakeAgent(overrides: {
  prompt?: () => Promise<void>;
  abort?: () => void;
  skills?: BuiltAgent["skills"];
  knowledge?: BuiltAgent["knowledge"];
  database?: BuiltAgent["database"];
} = {}): BuiltAgent {
  const listeners = new Set<Listener>();
  const session = {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: overrides.prompt ?? (async () => undefined),
    abort: overrides.abort ?? (() => undefined),
    dispose() {},
  };
  const model = { provider: "modelscope", id: "Qwen/demo", name: "demo" } as Model<any>;
  const database = overrides.database ?? openDatabase({ seed: true });
  return {
    session: session as unknown as BuiltAgent["session"],
    model,
    builtinTools: "off",
    skills: overrides.skills ?? [],
    knowledge: overrides.knowledge ?? [],
    database,
    listModels: async () => [model],
    switchModel: async (ref) => {
      if (ref !== "zhipu/glm-4.5-air") throw new Error(`找不到模型 ${ref}`);
      return { provider: "zhipu", id: "glm-4.5-air", name: "GLM" } as Model<any>;
    },
    dispose: () => database.close(),
  };
}

async function listen(app: ReturnType<typeof createApp>["app"]): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: unknown; text: string }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, body, text };
}

test("GET /health 是轻量存活探针，不依赖模型与数据库", async () => {
  const { app, dispose } = createApp({ agent: fakeAgent(), staticDir: false });
  const { url, close } = await listen(app);
  try {
    const res = await json(`${url}/health`);
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; uptimeSeconds: number; nodeVersion: string };
    // Liveness must answer even when a dependency is down — otherwise an orchestrator
    // would restart-loop a healthy process during a transient provider outage.
    assert.equal(body.ok, true);
    assert.equal(typeof body.uptimeSeconds, "number");
    assert.equal(body.nodeVersion, process.version);
  } finally {
    await close();
    dispose();
  }
});

test("GET /health/ready 做依赖深度探针", async () => {
  const { app, dispose } = createApp({ agent: fakeAgent(), staticDir: false });
  const { url, close } = await listen(app);
  try {
    const res = await json(`${url}/health/ready`);
    assert.equal(res.status, 200);
    const body = res.body as {
      ok: boolean;
      checks: { model: { ok: boolean; detail?: string }; database: { ok: boolean } };
    };
    assert.equal(body.ok, true);
    assert.equal(body.checks.model.ok, true);
    assert.equal(body.checks.model.detail, "modelscope/Qwen/demo");
    assert.equal(body.checks.database.ok, true);
  } finally {
    await close();
    dispose();
  }
});

test("GET /metrics 暴露运行时指标，支持 Prometheus 文本格式", async () => {
  const { app, dispose } = createApp({ agent: fakeAgent(), staticDir: false });
  const { url, close } = await listen(app);
  try {
    const res = await json(`${url}/metrics`);
    assert.equal(res.status, 200);
    const body = res.body as {
      ok: boolean;
      metrics: Record<string, number>;
      runtime: { uptimeSeconds: number };
    };
    assert.equal(body.ok, true);
    assert.equal(typeof body.metrics.pi_ws_connections, "number");
    assert.equal(typeof body.runtime.uptimeSeconds, "number");

    const prom = await fetch(`${url}/metrics?format=prometheus`);
    const text = await prom.text();
    assert.match(text, /# TYPE pi_ws_connections gauge/);
    assert.match(text, /pi_uptime_seconds \d+/);
  } finally {
    await close();
    dispose();
  }
});

test("GET /info 列出当前模型和可用目录（原 /health 的完整清单）", async () => {
  const { app, dispose } = createApp({ agent: fakeAgent(), staticDir: false });
  const { url, close } = await listen(app);
  try {
    const res = await json(`${url}/info`);
    assert.equal(res.status, 200);
    const body = res.body as {
      model: string;
      models: { current: boolean }[];
      busy: boolean;
      skills: unknown[];
      knowledge: unknown[];
      db: { ok: boolean; driver: string };
    };
    assert.equal(body.model, "modelscope/Qwen/demo");
    assert.equal(body.models.length, 1);
    assert.equal(body.models[0]?.current, true);
    assert.equal(body.busy, false);
    assert.deepEqual(body.skills, []);
    assert.deepEqual(body.knowledge, []);
    assert.equal(body.db.ok, true);
    assert.equal(body.db.driver, "sqlite");
  } finally {
    await close();
    dispose();
  }
});

test("HTTP 层已加固：安全响应头 + body 超限返回 413", async () => {
  const { app, dispose } = createApp({ agent: fakeAgent(), staticDir: false, bodyLimit: 64 });
  const { url, close } = await listen(app);
  try {
    const head = await fetch(`${url}/health`);
    assert.equal(head.headers.get("x-content-type-options"), "nosniff");
    assert.equal(head.headers.get("x-frame-options"), "DENY");
    assert.equal(head.headers.get("referrer-policy"), "no-referrer");
    assert.equal(head.headers.get("x-powered-by"), null, "must not advertise the framework");

    const huge = await fetch(`${url}/db/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1", pad: "x".repeat(4096) }),
    });
    assert.equal(huge.status, 413, "oversized body must be rejected, not buffered");
  } finally {
    await close();
    dispose();
  }
});

test("GET /skills /knowledge /db 用虚拟数据测连接，不调模型", async () => {
  const skillRoot = mkdtempSync(join(tmpdir(), "pi-http-skill-"));
  const knowledgeRoot = mkdtempSync(join(tmpdir(), "pi-http-kb-"));
  mkdirSync(join(skillRoot, "summarize"));
  writeFileSync(
    join(skillRoot, "summarize", "SKILL.md"),
    "---\nname: summarize\ndescription: 归纳长文本\n---\n# 技能正文\n",
  );
  writeFileSync(
    join(knowledgeRoot, "faq.md"),
    "---\ntitle: 常见问题\ndescription: 怎么切换模型\n---\nPOST /model\n",
  );
  const database = openDatabase({ seed: true });
  const { app, dispose } = createApp({
    agent: fakeAgent({
      skills: loadSkillsFromDirs([skillRoot]),
      knowledge: loadKnowledgeFromDirs([knowledgeRoot]),
      database,
    }),
    staticDir: false,
  });
  const { url, close } = await listen(app);
  try {
    const skills = await json(`${url}/skills`);
    assert.equal(skills.status, 200);
    const skillList = (skills.body as { skills: { name: string }[] }).skills;
    assert.equal(skillList[0]?.name, "summarize");

    const skill = await json(`${url}/skills/summarize`);
    assert.equal(skill.status, 200);
    assert.match((skill.body as { skill: { body: string } }).skill.body, /技能正文/);

    const missingSkill = await json(`${url}/skills/nope`);
    assert.equal(missingSkill.status, 404);

    const search = await json(`${url}/knowledge/search?q=${encodeURIComponent("切换模型")}`);
    assert.equal(search.status, 200);
    assert.equal((search.body as { hits: { name: string }[] }).hits[0]?.name, "faq");

    const doc = await json(`${url}/knowledge/faq`);
    assert.equal(doc.status, 200);
    assert.match((doc.body as { doc: { body: string } }).doc.body, /POST \/model/);

    const ping = await json(`${url}/db`);
    assert.equal(ping.status, 200);
    assert.equal((ping.body as { ok: boolean }).ok, true);

    const notes = await json(`${url}/db/notes`);
    assert.equal(notes.status, 200);
    assert.ok(((notes.body as { notes: unknown[] }).notes.length ?? 0) >= 2);

    const query = await json(`${url}/db/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT title FROM notes WHERE title = 'welcome'" }),
    });
    assert.equal(query.status, 200);
    assert.deepEqual((query.body as { rows: { title: string }[] }).rows, [{ title: "welcome" }]);

    const write = await json(`${url}/db/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "DELETE FROM notes" }),
    });
    assert.equal(write.status, 400);
  } finally {
    await close();
    dispose();
  }
});

test("POST /model 缺字段 400，未知模型 400，成功返回新引用", async () => {
  const { app, dispose } = createApp({ agent: fakeAgent(), staticDir: false });
  const { url, close } = await listen(app);
  try {
    const missing = await json(`${url}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    const unknown = await json(`${url}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nope" }),
    });
    assert.equal(unknown.status, 400);

    const ok = await json(`${url}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "zhipu/glm-4.5-air" }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { ok: true, model: "zhipu/glm-4.5-air" });
  } finally {
    await close();
    dispose();
  }
});

test("POST /chat 缺 message 400，忙时 429", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app, dispose } = createApp({
    agent: fakeAgent({ prompt: () => held }),
    staticDir: false,
  });
  const { url, close } = await listen(app);
  try {
    const missing = await json(`${url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    const first = fetch(`${url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = await json(`${url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "again" }),
    });
    assert.equal(second.status, 429);
    release();
    const done = await first;
    assert.equal(done.status, 200);
    assert.match(await done.text(), /"type":"done"/);
  } finally {
    await close();
    dispose();
  }
});
