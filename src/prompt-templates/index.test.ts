import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadScaffoldPromptTemplates,
  resolvePromptTemplatePaths,
  resolvePromptTemplatesDir,
} from "./index.js";

function templateFile(dir: string, name: string, description: string, body = "# hello\n"): string {
  const file = join(dir, `${name}.md`);
  writeFileSync(file, `---\ndescription: ${description}\n---\n${body}`);
  return file;
}

test("默认带上内置的 review 模板", () => {
  const paths = resolvePromptTemplatePaths([]);
  const builtinDir = resolvePromptTemplatesDir();
  assert.ok(builtinDir, "内置目录应被找到");
  assert.ok(
    paths.some((p) => p.endsWith(`${"review"}.md`)),
    `默认应包含 review.md，实际：${paths.join(", ")}`,
  );
});

test("includeBuiltin: false 时内置 review 不进交给 SDK 的路径", () => {
  const extra = mkdtempSync(join(tmpdir(), "pi-prompt-only-"));
  templateFile(extra, "deploy", "部署流程");
  const paths = resolvePromptTemplatePaths([extra], { includeBuiltin: false });
  assert.ok(paths.some((p) => p.endsWith("deploy.md")), "业务模板保留");
  assert.ok(!paths.some((p) => p.endsWith("review.md")), "内置模板被关掉");
});

test("超大模板与超出数量上限的模板被跳过，不进 SDK 路径", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-prompt-cap-"));
  templateFile(root, "small", "ok");
  const big = join(root, "big.md");
  writeFileSync(big, `---\ndescription: huge\n---\n${"x".repeat(70 * 1024)}`);

  const skipped: Array<{ file: string; reason: string }> = [];
  const paths = resolvePromptTemplatePaths([root], {
    includeBuiltin: false,
    maxBytes: 64 * 1024,
    onSkip: (file, reason) => skipped.push({ file, reason }),
  });
  assert.ok(paths.includes(join(root, "small.md")), "正常模板通过");
  assert.ok(!paths.includes(big), "超大模板不得交给 SDK");
  assert.ok(skipped.some((s) => s.file === big && /超过/.test(s.reason)), "跳过被上报");

  // 数量上限：再多写几个，限制为 1 时其余被跳过。
  templateFile(root, "another", "second");
  const many = resolvePromptTemplatePaths([root], {
    includeBuiltin: false,
    maxTemplates: 1,
    onSkip: (file, reason) => skipped.push({ file, reason }),
  });
  assert.equal(many.length, 1, "受 maxTemplates 截断");
});

test("loadScaffoldPromptTemplates 读到真实 review 的名称、说明与正文", () => {
  const builtinDir = resolvePromptTemplatesDir();
  assert.ok(builtinDir);
  const loaded = loadScaffoldPromptTemplates([join(builtinDir, "review.md")]);
  const review = loaded.find((t) => t.name === "review");
  assert.ok(review, "review 模板应被加载");
  assert.ok(review!.description.trim().length > 0, "说明非空");
  assert.ok(review!.content.trim().length > 0, "正文非空");
});
