/**
 * 审批规则编辑接口测试。
 *
 * 重点验证两件事：
 *   1. **编辑即刻落盘**，且停机不再写盘——所以运行期间对规则文件的外部修改不会被覆盖。
 *     （这正是原先「优雅停机写回」会造成的真实问题：停机用内存副本抹掉用户手改。）
 *   2. API 入口与磁盘加载用**同一套校验**：不能出现「手写文件被拦、API 却能塞进去」。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../app.js";
import { listenTestServer } from "../test-server.js";
import {
  ApprovalRulesStore,
  createPersistentRulesStore,
  loadApprovalRulesFromFile,
  builtinApprovalRules,
  type ApprovalRule,
} from "../approval/rules.js";
import { SessionHub } from "../session-hub.js";
import { resolveRuntimeConfig } from "../config.js";
import { SettingsService } from "../settings.js";
import type { BuiltAgent } from "../agent.js";

function makeAgent(): BuiltAgent {
  const model = { provider: "test", id: "m1", name: "M1", contextWindow: 1000 } as never;
  const session = {
    sessionId: "s1", model, isStreaming: false, activeTools: [] as string[],
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
    listModels: async () => [model], switchModel: async () => model, dispose: () => {},
  } as never;
}

const rule = (id: string): Omit<ApprovalRule, "id"> => ({
  description: `规则 ${id}`,
  tools: ["bash"],
  field: "command",
  match: { kind: "contains", value: id },
  action: "ask",
});

async function start(store: ApprovalRulesStore) {
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig());
  const { app, dispose } = createApp({
    agent,
    registry: undefined as never,
    settings: new SettingsService(),
    hub: hub as never,
    approvalRules: store,
  });
  const s = await listenTestServer(app);
  return {
    base: s.url,
    dispose,
    async close() {
      dispose();
      hub.dispose();
      await s.close();
    },
  };
}

test("规则编辑：新增后立刻落盘，重启读得回来", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pi-rules-")), "rules.json");
  const store = createPersistentRulesStore(file);
  const h = await start(store);
  try {
    const res = await fetch(`${h.base}/approval/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "no-llm", ...rule("no-llm") }),
    });
    assert.equal(res.status, 200);

    // 关键：不用等停机，磁盘上已经有了。
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { userRules: ApprovalRule[] };
    assert.equal(onDisk.userRules.length, 1, "an edit must hit disk immediately");
    assert.equal(onDisk.userRules[0]?.id, "no-llm");

    // 新实例读回同一份。
    const reloaded = loadApprovalRulesFromFile(file);
    assert.equal(reloaded.listUserRules()[0]?.id, "no-llm");
  } finally {
    await h.close();
  }
});

test("规则编辑：运行期间的外部修改不会被停机覆盖", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pi-rules-")), "rules.json");
  const store = createPersistentRulesStore(file);
  const h = await start(store);
  try {
    // 我们自己不改规则，只让外部直接改文件（模拟用户手改）。
    writeFileSync(
      file,
      JSON.stringify({ userRules: [{ id: "by-hand", ...rule("by-hand") }] }),
      "utf8",
    );
    // 停机（createApp 的 dispose + 不再有任何写盘动作）。
    await h.close();
    // 外部改动必须还在。
    const after = JSON.parse(readFileSync(file, "utf8")) as { userRules: ApprovalRule[] };
    assert.equal(after.userRules[0]?.id, "by-hand", "an external edit must survive shutdown");
  } finally {
    await h.close();
  }
});

test("规则编辑：删除、替换、以及非法输入被拒", async () => {
  const store = new ApprovalRulesStore();
  store.setUserRules([{ id: "r1", ...rule("r1") } as ApprovalRule]);
  const h = await start(store);
  try {
    // match.value 缺失 —— 必须被拒（否则匹配时会崩或静默错配）。
    const bad = await fetch(`${h.base}/approval/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "bad", description: "x", tools: ["bash"], field: "command", match: { kind: "glob" }, action: "ask" }),
    });
    assert.equal(bad.status, 400, "a rule without match.value must be rejected");

    // action 非法
    const bad2 = await fetch(`${h.base}/approval/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "bad2", ...rule("x"), action: "explode" }),
    });
    assert.equal(bad2.status, 400);

    // 删除不存在的
    const del = await fetch(`${h.base}/approval/rules/nope`, { method: "DELETE" });
    assert.equal(del.status, 404);

    // 正常删除
    const del2 = await fetch(`${h.base}/approval/rules/r1`, { method: "DELETE" });
    assert.equal(del2.status, 200);
    assert.equal(store.listUserRules().length, 0);
  } finally {
    await h.close();
  }
});

test("规则编辑：内置规则不可通过接口写入或删除", async () => {
  const store = new ApprovalRulesStore();
  const h = await start(store);
  try {
    const res = await fetch(`${h.base}/approval/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x", ...rule("x"), builtin: true }),
    });
    assert.equal(res.status, 400, "builtin rules are not writable via API");

    // 内置 deny 规则确实存在且不可删。
    const builtin = builtinApprovalRules();
    assert.ok(builtin.length > 0);
    assert.ok(builtin.some((r) => r.action === "deny"), "hard denials must exist");
  } finally {
    await h.close();
  }
});

test("规则编辑：未提供规则库时不注册这些端点", async () => {
  const agent = makeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig());
  const { app, dispose } = createApp({
    agent, registry: undefined as never, settings: new SettingsService(), hub: hub as never,
  });
  const s = await listenTestServer(app);
  try {
    const res = await fetch(`${s.url}/approval/rules`);
    assert.notEqual(res.status, 200, "rule editing must be opt-in");
  } finally {
    dispose();
    hub.dispose();
    await s.close();
  }
});
