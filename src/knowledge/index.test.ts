import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatKnowledgeCatalog, loadKnowledgeFromDirs, loadScaffoldKnowledge, searchKnowledge } from "./index.js";

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

test("includeBuiltin: false 才能把内置示例文档从系统提示词里去掉", () => {
  const extra = mkdtempSync(join(tmpdir(), "pi-kb-only-"));
  writeFileSync(join(extra, "my-domain.md"), "---\ntitle: 我的业务\n---\n只有我自己的内容。\n");

  // 默认：内置示例与业务文档并存——这正是嵌入别人服务时 undesired 的形态。
  const withBuiltin = loadScaffoldKnowledge([extra]);
  const builtinNames = withBuiltin.map((doc) => doc.name);
  assert.ok(builtinNames.includes("my-domain"), "业务文档一定在");
  assert.ok(builtinNames.includes("about"), "默认带内置示例（改动前的形态）");

  // 关掉内置：只剩业务文档，且系统提示词里再也搜不到「关于本脚手架」。
  const only = loadScaffoldKnowledge([extra], { includeBuiltin: false });
  assert.deepEqual(only.map((doc) => doc.name), ["my-domain"]);
  assert.doesNotMatch(formatKnowledgeCatalog(only), /关于本脚手架/);

  // 没有额外目录时，关掉内置就是空库（而不是退回内置）。
  assert.deepEqual(loadScaffoldKnowledge([], { includeBuiltin: false }), []);
});

test("includeBuiltin 只影响 *Scaffold* 加载器，loadKnowledgeFromDirs 不受牵连", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kb-plain-"));
  writeFileSync(join(dir, "plain.md"), "---\ntitle: 普通\n---\n正文\n");
  const docs = loadKnowledgeFromDirs([dir], { includeBuiltin: false });
  assert.deepEqual(docs.map((doc) => doc.name), ["plain"]);
});
