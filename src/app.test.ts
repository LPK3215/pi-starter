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
import { AppError } from "./errors.js";
import { loadKnowledgeFromDirs, searchKnowledge } from "./knowledge/index.js";
import { MemoryStore } from "./memory/store.js";
import { loadSkillsFromDirs } from "./skills/index.js";

type Listener = (event: AgentSessionEvent) => void;

function fakeAgent(overrides: {
  prompt?: (message: string, options?: { preflightResult?: (ok: boolean) => void }) => Promise<void>;
  abort?: () => void;
  skills?: BuiltAgent["skills"];
  knowledge?: BuiltAgent["knowledge"];
  promptTemplates?: BuiltAgent["promptTemplates"];
  database?: BuiltAgent["database"];
  memory?: BuiltAgent["memory"];
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
    web: { enabled: false, toolNames: [] },
    memory: overrides.memory ?? { enabled: false, toolNames: [] },
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

test("静态前端：staticDir 指向构建产物时，SPA 首页挂在 /", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-static-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>pi-starter web</title>");
  const { app, dispose } = createApp({ agent: fakeAgent(), staticDir: dir });
  const { url, close } = await listen(app);
  try {
    const res = await json(`${url}/`);
    assert.equal(res.status, 200);
    assert.match(res.text, /pi-starter web/);
  } finally {
    await close();
    dispose();
  }
});

test("静态前端：前端未构建（目录不存在）时 API 照常，不能把进程带倒", async () => {
  // express.static 对不存在的目录不抛错、直接穿透；默认值就指向可能不存在的 web/dist，
  // 所以这条契约必须有测试兜着，否则“先跑后端再构建前端”的开箱姿势会碎。
  const missing = join(mkdtempSync(join(tmpdir(), "pi-nostatic-")), "dist");
  const { app, dispose } = createApp({ agent: fakeAgent(), staticDir: missing });
  const { url, close } = await listen(app);
  try {
    assert.equal((await json(`${url}/health`)).status, 200);
    assert.equal((await json(`${url}/`)).status, 404);
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

/* ────────────────────── 资源目录与探针降级 ────────────────────── */
// routes.ts 里的资源路由（/skills/:name、/knowledge*、/prompt-templates*）此前没有测试 ——
// 它们决定「人和模型看到的技能/知识/模板目录对不对」，而详情路由还要读磁盘。

test("资源路由：/skills 列表与详情；列表不带正文，详情读磁盘，找不到即 404", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-skills-"));
  mkdirSync(join(root, "summarize"));
  writeFileSync(
    join(root, "summarize", "SKILL.md"),
    "---\nname: summarize\ndescription: 归纳长文本\n---\n# 正文\n三步走。\n",
  );
  const skills = loadSkillsFromDirs([root]);
  const { app, dispose } = createApp({ agent: fakeAgent({ skills }), staticDir: false });
  const { url, close } = await listen(app);
  try {
    const list = await json(`${url}/skills`);
    assert.equal(list.status, 200);
    const items = (list.body as { skills: Array<Record<string, unknown>> }).skills;
    assert.equal(items[0]?.name, "summarize");
    assert.equal(items[0]?.description, "归纳长文本");
    assert.match(String(items[0]?.location), /SKILL\.md$/);
    assert.ok(!("body" in (items[0] ?? {})), "列表不该带正文（正文只走详情路由）");

    const detail = await json(`${url}/skills/summarize`);
    assert.equal(detail.status, 200);
    assert.match(String((detail.body as { skill: { body: string } }).skill.body), /三步走/);

    assert.equal((await json(`${url}/skills/nope`)).status, 404);
  } finally {
    await close();
    dispose();
  }
});

test("资源路由：SKILL.md 读不出来时**不能把绝对路径泄漏给客户端**", async () => {
  // 注释里写明这条取舍：读不到 SKILL.md 是内部文件系统问题、不是客户端错误，
  // 所以让它走统一错误处理（详情只进日志，响应给通用文案）。
  const missingDir = join(tmpdir(), "pi-skills-missing-dir");
  const skill = { name: "broken", description: "d", filePath: join(missingDir, "SKILL.md") };
  const { app, dispose } = createApp({ agent: fakeAgent({ skills: [skill as never] }), staticDir: false });
  const { url, close } = await listen(app);
  try {
    const res = await json(`${url}/skills/broken`);
    assert.equal(res.status, 500);
    assert.ok(!res.text.includes("pi-skills-missing-dir"), `响应里不能出现绝对路径：${res.text}`);
  } finally {
    await close();
    dispose();
  }
});

test("资源路由：/knowledge 列表、搜索、详情，且 /knowledge/search 不会被 :name 抢走", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-kb-"));
  writeFileSync(join(root, "faq.md"), "---\ntitle: 常见问题\ndescription: 怎么切换模型\n---\nPOST /model\n");
  const knowledge = loadKnowledgeFromDirs([root]);
  const { app, dispose } = createApp({ agent: fakeAgent({ knowledge }), staticDir: false });
  const { url, close } = await listen(app);
  try {
    const list = await json(`${url}/knowledge`);
    assert.equal((list.body as { knowledge: Array<{ name: string; title: string }> }).knowledge[0]?.name, "faq");
    assert.equal((list.body as { knowledge: Array<Record<string, unknown>> }).knowledge[0]?.body, undefined);

    assert.equal((await json(`${url}/knowledge/search`)).status, 400, "缺 q 必须 400");
    // 路由顺序回归：`/knowledge/search` 注册在 `/knowledge/:name` 之前，否则这里会 404。
    const search = await json(`${url}/knowledge/search?q=切换模型`);
    assert.equal(search.status, 200);
    assert.equal((search.body as { hits: unknown[] }).hits.length, 1);

    const doc = await json(`${url}/knowledge/faq`);
    assert.match(String((doc.body as { doc: { body: string } }).doc.body), /POST \/model/);
    assert.equal((await json(`${url}/knowledge/nope`)).status, 404);
  } finally {
    await close();
    dispose();
  }
});

test("记忆路由：未装配存储时 /memory 完全不注册", async () => {
  const { app, dispose } = createApp({ agent: fakeAgent(), staticDir: false });
  const { url, close } = await listen(app);
  try {
    // 404 而不是「存在但报错」——不注册比注册一个永远失败的端点诚实。
    assert.equal((await json(`${url}/memory`)).status, 404);
  } finally {
    await close();
    dispose();
  }
});

test("记忆路由：GET 列表/检索、POST 写入、DELETE 删除，且与工具同一份 store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-route-"));
  const store = new MemoryStore({ filePath: join(dir, "memory.jsonl") });
  const { app, dispose } = createApp({
    agent: fakeAgent({ memory: { enabled: true, toolNames: ["remember", "recall"], store } }),
    staticDir: false,
  });
  const { url, close } = await listen(app);
  try {
    const wrote = await json(`${url}/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "用户偏好中文", tags: ["preference"] }),
    });
    assert.equal(wrote.status, 200);
    const id = (wrote.body as { id: string }).id;
    assert.ok(id);
    assert.equal(store.size, 1, "路由写入必须进同一份 store");

    const list = (await json(`${url}/memory`)).body as { hits: Array<{ text: string }>; total: number };
    assert.equal(list.total, 1);
    assert.equal(list.hits[0]?.text, "用户偏好中文");

    const searched = (await json(`${url}/memory?q=中文`)).body as { hits: unknown[] };
    assert.equal(searched.hits.length, 1);

    // 正文缺失 = 客户端错误；超限 = 校验失败，两者都必须可读地拒绝。
    assert.equal((await json(`${url}/memory`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
    const tooLong = await json(`${url}/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(5000) }),
    });
    assert.equal(tooLong.status, 400);
    assert.equal(store.size, 1, "被拒的写入不该落库");

    const removed = await json(`${url}/memory/${id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal(store.size, 0);
    assert.equal((await json(`${url}/memory/${id}`, { method: "DELETE" })).status, 404);
  } finally {
    await close();
    dispose();
  }
});

test("资源路由：/prompt-templates 列表与详情，argumentHint 只在有值时才出现", async () => {
  const templates = [
    { name: "review", description: "走查", content: "请走查这段代码", argumentHint: "<path>" },
    { name: "plain", description: "无提示", content: "正文" },
  ];
  const { app, dispose } = createApp({ agent: fakeAgent({ promptTemplates: templates as never }), staticDir: false });
  const { url, close } = await listen(app);
  try {
    const list = (await json(`${url}/prompt-templates`)).body as {
      promptTemplates: Array<Record<string, unknown>>;
    };
    assert.equal(list.promptTemplates.length, 2);
    assert.equal(list.promptTemplates[0]?.argumentHint, "<path>");
    assert.ok(!("argumentHint" in (list.promptTemplates[1] ?? {})), "没提示时不该塞一个空字段");
    assert.ok(!("body" in (list.promptTemplates[0] ?? {})), "列表不带正文");

    const detail = (await json(`${url}/prompt-templates/review`)).body as {
      promptTemplate: { body: string; argumentHint?: string };
    };
    assert.equal(detail.promptTemplate.body, "请走查这段代码");
    assert.equal(detail.promptTemplate.argumentHint, "<path>");
    assert.equal((await json(`${url}/prompt-templates/nope`)).status, 404);
  } finally {
    await close();
    dispose();
  }
});

test("探针：依赖全挂时 liveness 仍 200、readiness 变 503 并逐项给原因", async () => {
  const agent = fakeAgent();
  // 模拟「模型没选出来」+「数据库连不上」：两个硬依赖都不可用。
  (agent as unknown as { model: unknown }).model = undefined;
  (agent.database as unknown as { ping: () => never }).ping = () => {
    throw new Error("database is down");
  };
  const { app, dispose } = createApp({ agent, staticDir: false });
  const { url, close } = await listen(app);
  try {
    // liveness 刻意不碰模型运行时：provider 挂了也不该让编排器重启一个健康的进程。
    const live = await json(`${url}/health`);
    assert.equal(live.status, 200);

    const ready = await json(`${url}/health/ready`);
    assert.equal(ready.status, 503);
    const body = ready.body as {
      ok: boolean;
      checks: Record<string, { ok: boolean; detail?: string }>;
    };
    assert.equal(body.ok, false);
    assert.equal(body.checks.model?.ok, false);
    assert.match(String(body.checks.model?.detail), /no model selected/);
    assert.equal(body.checks.database?.ok, false);
    assert.match(String(body.checks.database?.detail), /database is down/);
    // 探针不公开内部路径/连接串是既有约定，这里顺带确认错误文案就是原样 message。
    assert.ok(body.checks.knowledge?.ok === true, "知识库是本地数组，仍然可用");
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
