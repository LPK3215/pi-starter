import assert from "node:assert/strict";
import { test } from "node:test";
import { listenTestServer } from "./test-server.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { BuiltAgent } from "./agent.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { openDatabase } from "./db/index.js";
import { AppError } from "./http/errors.js";
import { loadKnowledgeFromDirs, searchKnowledge } from "./knowledge/index.js";
import { loadSkillsFromDirs } from "./skills/index.js";

type Listener = (event: AgentSessionEvent) => void;

function fakeAgent(overrides: {
  prompt?: (message: string, options?: { preflightResult?: (ok: boolean) => void }) => Promise<void>;
  abort?: () => void;
  skills?: BuiltAgent["skills"];
  knowledge?: BuiltAgent["knowledge"];
  promptTemplates?: BuiltAgent["promptTemplates"];
  database?: BuiltAgent["database"];
} = {}): BuiltAgent {
  const listeners = new Set<Listener>();
  const session = {
    sessionId: "chat-test-session",
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
    promptTemplates: overrides.promptTemplates ?? [],
    database,
    listModels: async () => [model],
    switchModel: async (ref) => {
      if (ref !== "zhipu/glm-4.5-air") throw new Error(`找不到模型 ${ref}`);
      return { provider: "zhipu", id: "glm-4.5-air", name: "GLM" } as Model<any>;
    },
    knowledgeRetrieval: "keyword",
    searchKnowledge: async (query, limit) => searchKnowledge(overrides.knowledge ?? [], query, limit ?? 5),
    cycleModel: async () => ({ provider: "zhipu", id: "glm-4.5-air", name: "GLM" } as Model<any>),
    cycleThinkingLevel: () => "high",
    getThinkingLevel: () => "medium",
    waitForIdle: async () => {},
    providerStatus: async () => [
      { id: "modelscope", name: "ModelScope", authorized: true, type: "api_key", source: "PI_API_KEY" },
      { id: "anthropic", name: "Anthropic", authorized: false },
    ],
    eventBus: createEventBus(),
    dispose: () => database.close(),
  };
}

async function listen(app: ReturnType<typeof createApp>["app"]): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const s = await listenTestServer(app);
  return { url: s.url, close: () => s.close() };
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
      promptTemplates: [
        { name: "review", description: "只列未满足的约束", content: "对照上一轮结论。\n" },
      ],
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

    const ptList = await json(`${url}/prompt-templates`);
    assert.equal(ptList.status, 200);
    assert.equal(
      (ptList.body as { promptTemplates: { name: string }[] }).promptTemplates[0]?.name,
      "review",
    );

    const pt = await json(`${url}/prompt-templates/review`);
    assert.equal(pt.status, 200);
    assert.match(
      (pt.body as { promptTemplate: { body: string } }).promptTemplate.body,
      /对照上一轮/,
    );

    const missingPt = await json(`${url}/prompt-templates/nope`);
    assert.equal(missingPt.status, 404);

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

test("POST /model/cycle 走官方轮换；GET /providers 只回状态标签不回密钥", async () => {
  const { app, dispose } = createApp({ agent: fakeAgent(), staticDir: false });
  const { url, close } = await listen(app);
  try {
    const cycle = await json(`${url}/model/cycle`, { method: "POST" });
    assert.equal(cycle.status, 200);
    assert.deepEqual(cycle.body, { ok: true, model: "zhipu/glm-4.5-air" });

    const providers = await json(`${url}/providers`);
    assert.equal(providers.status, 200);
    const list = (providers.body as { providers: { id: string; authorized: boolean }[] }).providers;
    assert.equal(list.find((p) => p.id === "modelscope")?.authorized, true);
    assert.equal(list.find((p) => p.id === "anthropic")?.authorized, false);
    // /providers 只回授权布尔与标签，不得含原始 key
    assert.ok(!JSON.stringify(providers.body).includes("sk-"));

    const info = await json(`${url}/info`);
    assert.ok(Array.isArray((info.body as { providers: unknown[] }).providers), "/info 带 providers");
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

test("POST /chat?format=jsonl 走官方 NDJSON：首行会话头，无 SSE 封装", async () => {
  const { app, dispose } = createApp({
    agent: fakeAgent({ prompt: async () => undefined }),
    staticDir: false,
  });
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/chat?format=jsonl`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);
    const text = await res.text();
    assert.ok(!text.includes("data: "), "NDJSON 通道不得带 SSE 信封");
    const first = text.split("\n")[0]!;
    const header = JSON.parse(first);
    assert.equal(header.type, "session");
    assert.equal(typeof header.id, "string");
    // 默认（不带 format）仍是 SSE，并以 done 收尾。
    const sseRes = await fetch(`${url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.match(await sseRes.text(), /"type":"done"/);
  } finally {
    await close();
    dispose();
  }
});

test("POST /chat 预检拒绝（preflightResult false）时回明确 conflict，不静默", async () => {
  const { app, dispose } = createApp({
    agent: fakeAgent({
      // SDK 在被预检拒时不报错、只回调 false 后静默 resolve；这里要把它翻成可见错误。
      prompt: async (_m, opts) => {
        opts?.preflightResult?.(false);
      },
    }),
    staticDir: false,
  });
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    const text = await res.text();
    assert.match(text, /"code":"conflict"/, "预检拒绝应回 conflict 码");
    assert.match(text, /消息被拒绝/, "并给出可读原因");
    assert.match(text, /"type":"done"/, "流仍干净收尾");
  } finally {
    await close();
    dispose();
  }
});

/**
 * 流式错误路径此前**零覆盖**，而且它绕过了统一错误处理：状态码已提交，`errorHandler`
 * 再也看不到这个异常，于是 `err.message` 原样写进 SSE —— 数据库绝对路径、SQL、SDK
 * 内部信息全都会到客户端。同时它**不记日志**，失败在服务端完全不可见。
 *
 * 这里两个方向都要验：不该露的必须藏住，该露的必须放行（模型靠它自我纠正）。
 */
test("POST /chat 流式失败：internal 细节不泄漏，但面向调用方的码照常放行", async () => {
  const SECRET = String.raw`C:\Users\real\private\db.sqlite 密码 hunter2`;
  const leaky = createApp({
    agent: fakeAgent({
      prompt: async () => {
        throw new Error(`SQLITE_ERROR: unable to open ${SECRET}`);
      },
    }),
    staticDir: false,
  });
  const a = await listen(leaky.app);
  try {
    const res = await fetch(`${a.url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    const text = await res.text();
    assert.ok(!text.includes("hunter2"), `path/secret must not leak: ${text}`);
    assert.ok(!text.includes("SQLITE_ERROR"), "driver internals must not leak");
    assert.ok(!text.includes("db.sqlite"), "absolute path must not leak");
    assert.match(text, /"code":"internal"/, "the caller still needs a machine-readable category");
    assert.match(text, /服务器内部错误/, "and a generic, non-revealing message");
    // The stream contract must survive a failed turn: `done` still closes it.
    assert.match(text, /"type":"done"/, "the stream must still terminate cleanly");
  } finally {
    await a.close();
    leaky.dispose();
  }

  // A code we write *for* the caller must pass through verbatim — suppressing it would
  // leave a model retrying a query it could have corrected.
  const explicit = createApp({
    agent: fakeAgent({
      prompt: async () => {
        throw new AppError("read_only_sql", "检测到非只读关键字：DELETE", { expose: true });
      },
    }),
    staticDir: false,
  });
  const b = await listen(explicit.app);
  try {
    const res = await fetch(`${b.url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    const text = await res.text();
    assert.match(text, /"code":"read_only_sql"/);
    assert.match(text, /检测到非只读关键字/, "an intentionally exposed reason must reach the caller");
  } finally {
    await b.close();
    explicit.dispose();
  }
});
