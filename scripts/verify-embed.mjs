/**
 * 嵌入路径自检：验证 `docs/嵌入指南.md` 里的每条结论在**构建产物**上成立。
 *
 * 为什么打 `dist/` 而不是 `src/`：消费者装到的是 `dist`，源码里的行为不代表发布包的行为
 * （资源拷贝、exports 映射都只在 dist 上验证过）。
 *
 * 跑法：npm run build && npm run verify:embed
 *
 * 覆盖：
 *   1. 库入口可从 dist 解析，内置示例内容（about.md / summarize）确实存在
 *   2. builtinKnowledge:false / builtinSkills:false 真的能把它们从清单与 SDK 路径里去掉
 *   3. createApp 的返回值形状，以及内核路由确实可用
 *   4. 鉴权中间件挂在 createApp 之后 / configure 里都**无效**，挂父应用才有效
 *
 * 局限：buildAgent() 需要真实模型凭据，本脚本用结构相同的假 agent 代替，
 * 因此**不**验证模型选择、凭据读取与真实 prompt 组装。
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import {
  createApp,
  formatKnowledgeCatalog,
  loadScaffoldKnowledge,
  loadScaffoldSkills,
  resolveSkillPaths,
} from "../dist/lib.js";

const require = createRequire(import.meta.url);
const express = require("express");

let passed = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`  ok  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n        ${err && err.message ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

async function status(port, path, init) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return res.status;
}

/** 结构与 BuiltAgent 一致的假 agent：buildAgent 需要真实凭据，本脚本不验证那一段。 */
function fakeAgent() {
  const db = {
    driver: "sqlite",
    path: ":memory:",
    ping: () => ({ ok: true, driver: "sqlite", path: ":memory:" }),
    listNotes: () => [],
    getNote: () => undefined,
    searchNotes: () => [],
    insertNote: () => {
      throw new Error("unused in this check");
    },
    query: () => ({ rows: [], truncated: false, totalRows: 0 }),
    close: () => {},
  };
  return {
    session: {},
    model: { provider: "test", id: "test-model" },
    builtinTools: "off",
    skills: [],
    knowledge: [],
    database: db,
    listModels: async () => [],
    switchModel: async () => {
      throw new Error("unused in this check");
    },
    dispose: () => db.close(),
  };
}

console.log("嵌入路径自检（dist）");

await check("内置示例内容确实会进清单（说明为什么需要开关）", () => {
  const knowledge = loadScaffoldKnowledge([]);
  const skills = loadScaffoldSkills([]);
  assert.ok(
    knowledge.some((doc) => doc.name === "about"),
    "dist/knowledge/about.md 应存在",
  );
  assert.ok(
    skills.some((skill) => skill.name === "summarize"),
    "dist/skills/summarize 应存在",
  );
  assert.match(formatKnowledgeCatalog(knowledge), /关于本脚手架/, "示例文档会进系统提示词");
});

await check("includeBuiltin:false 能把示例内容从知识库与技能两侧同时摘掉", () => {
  const dir = mkdtempSync(join(tmpdir(), "embed-kb-"));
  writeFileSync(join(dir, "my-domain.md"), "---\ntitle: 我的业务\n---\n正文\n");

  assert.deepEqual(
    loadScaffoldKnowledge([dir], { includeBuiltin: false }).map((doc) => doc.name),
    ["my-domain"],
  );
  assert.deepEqual(loadScaffoldSkills([dir], { includeBuiltin: false }), []);
  assert.deepEqual(resolveSkillPaths([dir], { includeBuiltin: false }), []);

  // 默认值不变：不传就是现在的行为，避免升级即破坏。
  assert.ok(loadScaffoldKnowledge([]).length > 0, "默认仍带内置示例");
});

await check("createApp 返回 app / seal / addDisposer / isBusy / dispose", () => {
  const result = createApp({ agent: fakeAgent(), staticDir: false });
  for (const key of ["app", "seal", "addDisposer", "isBusy", "dispose"]) {
    assert.equal(typeof result[key], "function", `缺少 ${key}`);
  }
  result.dispose();
});

await check("内核路由可用", async () => {
  const { app } = createApp({ agent: fakeAgent(), staticDir: false });
  const { server, port } = await listen(app);
  try {
    for (const path of ["/health", "/skills", "/knowledge", "/db"]) {
      assert.equal(await status(port, path), 200, `${path} 应当 200`);
    }
  } finally {
    server.close();
  }
});

await check("鉴权：挂在 createApp 之后无效（README 旧版的错误建议）", async () => {
  const { app } = createApp({ agent: fakeAgent(), staticDir: false });
  app.use((_req, res) => res.status(401).end());
  const { server, port } = await listen(app);
  try {
    assert.equal(
      await status(port, "/skills"),
      200,
      "中间件排在内核路由之后，必须被绕过——若这里变成 401，说明内核改成了先注册路由，本文档需更新",
    );
  } finally {
    server.close();
  }
});

await check("鉴权：挂在 configure 里同样无效", async () => {
  const { app } = createApp({
    agent: fakeAgent(),
    staticDir: false,
    configure: (a) => a.use((_req, res) => res.status(401).end()),
  });
  const { server, port } = await listen(app);
  try {
    assert.equal(await status(port, "/skills"), 200, "configure 在内核路由之后，同样绕不过去");
  } finally {
    server.close();
  }
});

await check("鉴权：挂父应用才有效，且不会在根路径顺带暴露", async () => {
  const { app: agentApp } = createApp({ agent: fakeAgent(), staticDir: false });
  const outer = express();
  outer.use("/agent", (_req, res) => res.status(401).end(), agentApp);
  const { server, port } = await listen(outer);
  try {
    assert.equal(await status(port, "/agent/skills"), 401, "无 token 应被拦下");
    assert.equal(await status(port, "/skills"), 404, "内核路由不应在父应用根路径暴露");
  } finally {
    server.close();
  }
});

await check("带 token 时父应用能正常转发到内核", async () => {
  const { app: agentApp } = createApp({ agent: fakeAgent(), staticDir: false });
  const outer = express();
  outer.use(
    "/agent",
    (req, res, next) => (req.headers.authorization === "Bearer ok" ? next() : res.status(401).end()),
    agentApp,
  );
  const { server, port } = await listen(outer);
  try {
    assert.equal(
      await status(port, "/agent/skills", { headers: { authorization: "Bearer ok" } }),
      200,
    );
  } finally {
    server.close();
  }
});

console.log(results.join("\n"));
console.log(`\n${passed} 项通过${process.exitCode ? "，有失败项" : ""}`);