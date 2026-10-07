import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatKnowledgeCatalog, loadKnowledgeFromDirs, searchKnowledge } from "./index.js";

test("扫描 md，同名时先登记的赢，检索按关键词打分", () => {
  const first = mkdtempSync(join(tmpdir(), "pi-kb-a-"));
  const second = mkdtempSync(join(tmpdir(), "pi-kb-b-"));
  writeFileSync(
    join(first, "about.md"),
    "---\ntitle: 关于\ndescription: 脚手架说明\n---\n默认关 bash。\n",
  );
  writeFileSync(
    join(second, "about.md"),
    "---\ntitle: 覆盖\ndescription: 不该出现\n---\n第二份\n",
  );
  writeFileSync(join(second, "faq.md"), "---\ntitle: 常见问题\ndescription: 怎么切换模型\n---\nPOST /model\n");

  const docs = loadKnowledgeFromDirs([first, second]);
  assert.equal(docs.find((doc) => doc.name === "about")?.title, "关于");
  assert.ok(docs.some((doc) => doc.name === "faq"));

  const hits = searchKnowledge(docs, "切换模型");
  assert.equal(hits[0]?.name, "faq");
  assert.equal(searchKnowledge(docs, "不存在的词").length, 0);
});

test("目录格式化成 XML，空库返回空串", () => {
  assert.equal(formatKnowledgeCatalog([]), "");
  const text = formatKnowledgeCatalog([
    {
      name: "about",
      title: "关于",
      description: "说明",
      filePath: "/x.md",
      body: "正文",
    },
  ]);
  assert.match(text, /<name>about<\/name>/);
  assert.match(text, /<title>关于<\/title>/);
  assert.match(text, /search_knowledge/);
});
