import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReadKnowledgeTool, createSearchKnowledgeTool } from "./knowledge.js";
import { createDbQueryTool, createDbStatusTool } from "./database.js";
import { loadKnowledgeFromDirs, searchKnowledge } from "../knowledge/index.js";
import { loadSkillsFromDirs } from "../skills/index.js";
import { openDatabase } from "../db/index.js";

test("知识库 / 数据库工具登记正确的 name，加载结果可被检索", () => {
  const skillRoot = mkdtempSync(join(tmpdir(), "pi-skill-"));
  const knowledgeRoot = mkdtempSync(join(tmpdir(), "pi-kb-"));
  mkdirSync(join(skillRoot, "summarize"));
  writeFileSync(
    join(skillRoot, "summarize", "SKILL.md"),
    "---\nname: summarize\ndescription: 归纳长文本\n---\n# 正文\n",
  );
  writeFileSync(
    join(knowledgeRoot, "faq.md"),
    "---\ntitle: 常见问题\ndescription: 怎么切换模型\n---\nPOST /model\n",
  );

  const skills = loadSkillsFromDirs([skillRoot]);
  const docs = loadKnowledgeFromDirs([knowledgeRoot]);
  const db = openDatabase({ seed: true });
  try {
    assert.equal(skills[0]?.name, "summarize");
    assert.equal(createSearchKnowledgeTool(docs).name, "search_knowledge");
    assert.equal(createReadKnowledgeTool(docs).name, "read_knowledge");
    assert.equal(createDbStatusTool(db).name, "db_status");
    assert.equal(createDbQueryTool(db).name, "db_query");
    assert.equal(searchKnowledge(docs, "切换模型")[0]?.name, "faq");
    assert.equal(db.ping().ok, true);
  } finally {
    db.close();
  }
});
