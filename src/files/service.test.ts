/**
 * 文件服务测试。重点在**安全边界**——这些函数会被 HTTP 暴露给任意调用方，
 * 一个路径穿越或符号链接逃逸就等于把整个文件系统交出去。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileService, isBinaryExtension, looksBinary } from "./service.js";
import { AppError } from "../http/errors.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-files-"));
}

/** 断言某个操作抛出 AppError，并返回它以便检查状态码。 */
function expectAppError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    return err;
  }
  throw new assert.AssertionError({ message: "expected the call to throw" });
}

test("文件服务：读写往返，且父目录自动创建", () => {
  const fs_ = new FileService({ root: tmpRoot() });
  const written = fs_.write("a/b/c.txt", "你好，世界");
  assert.equal(written.text, "你好，世界");
  assert.equal(written.path, "a/b/c.txt");
  assert.equal(written.kind, "file");
  assert.ok(!written.truncated);
  assert.equal(fs_.read("a/b/c.txt").text, "你好，世界");
});

test("文件服务：目录浏览给出条目与预览，截断如实标记", () => {
  const root = tmpRoot();
  writeFileSync(join(root, "one.txt"), "first file");
  writeFileSync(join(root, "two.md"), "# heading");
  mkdirSync(join(root, "sub"));
  const listed = new FileService({ root }).list("");

  const names = listed.entries.map((e) => e.name).sort();
  assert.deepEqual(names, ["one.txt", "sub", "two.md"]);
  assert.equal(listed.entries.find((e) => e.name === "one.txt")?.preview, "first file");
  assert.equal(listed.entries.find((e) => e.name === "sub")?.kind, "directory");
  assert.equal(listed.truncated, false);

  const capped = new FileService({ root, maxEntries: 1 }).list("");
  assert.equal(capped.entries.length, 1);
  assert.equal(capped.truncated, true, "an entry-capped listing must say so, not lie");
});

test("文件服务：路径穿越被拒（最关键的一条）", () => {
  const root = tmpRoot();
  writeFileSync(join(tmpRoot(), "secret.txt"), "top secret");
  const fs_ = new FileService({ root });

  for (const attempt of ["../", "../secret.txt", "a/../../x", "./../outside/secret.txt"]) {
    assert.equal(expectAppError(() => fs_.read(attempt)).httpStatus, 400, `must reject: ${attempt}`);
  }
  expectAppError(() => fs_.write("../escaped.txt", "x"));
  expectAppError(() => fs_.remove("../x"));
});

test("文件服务：绝对路径被拒（避免绕过 root 语义）", () => {
  const root = tmpRoot();
  const fs_ = new FileService({ root });
  expectAppError(() => fs_.read(root));
  expectAppError(() => fs_.read(join(root, "x.txt")));
  expectAppError(() => fs_.write(join(root, "x.txt"), "x"));
});

test("文件服务：符号链接逃逸被拒（resolve 拦不住这一类）", () => {
  const root = tmpRoot();
  const outside = tmpRoot();
  writeFileSync(join(outside, "secret.txt"), "top secret");
  try {
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"), "file");
  } catch {
    return; // 环境不支持创建符号链接（Windows 未开开发者模式）——跳过而非误报通过
  }
  const fs_ = new FileService({ root });

  const err = expectAppError(() => fs_.read("escape.txt"));
  assert.equal(err.httpStatus, 400);
  assert.match(err.message, /符号链接/);
  expectAppError(() => fs_.write("escape.txt", "pwned"));
});

test("文件服务：读大文件按预览上限截断并标记", () => {
  const root = tmpRoot();
  writeFileSync(join(root, "big.txt"), "x".repeat(5000));
  const read = new FileService({ root, maxPreviewBytes: 100 }).read("big.txt");
  assert.equal(read.text?.length, 100);
  assert.equal(read.truncated, true, "a truncated read must say so");
  assert.equal(read.size, 5000, "the real size is still reported");
});

test("文件服务：写入超上限被拒（413）", () => {
  const fs_ = new FileService({ root: tmpRoot(), maxWriteBytes: 10 });
  assert.equal(expectAppError(() => fs_.write("x.txt", "y".repeat(11))).httpStatus, 413);
});

test("文件服务：二进制不进文本预览", () => {
  const root = tmpRoot();
  writeFileSync(join(root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  writeFileSync(join(root, "blob"), Buffer.from([1, 0, 2, 3]));
  const fs_ = new FileService({ root });

  // 已知二进制扩展名：直接判定，不读内容。
  const byExt = fs_.read("img.png");
  assert.equal(byExt.binary, true);
  assert.equal(byExt.text, undefined, "binary content must never be returned as text");

  // 无扩展名但含 NUL：内容嗅探同样判为二进制。
  const bySniff = fs_.read("blob");
  assert.equal(bySniff.binary, true);
  assert.equal(bySniff.text, undefined);

  assert.equal(isBinaryExtension("a/b/c.PNG"), true);
  assert.equal(isBinaryExtension("a/b/c.ts"), false);
  assert.equal(looksBinary(Buffer.from("abc")), false);
  assert.equal(looksBinary(Buffer.from([0])), true);
});

test("文件服务：新建 / 覆盖 / 重命名 / 复制 / 删除的语义与冲突", () => {
  const fs_ = new FileService({ root: tmpRoot() });

  fs_.create("f.txt", "v1");
  // 已存在时 create 必须报冲突，而不是静默覆盖。
  assert.equal(expectAppError(() => fs_.create("f.txt", "v2")).httpStatus, 409);

  fs_.rename("f.txt", "g.txt");
  assert.ok(!existsSync(join(fs_.root, "f.txt")));
  assert.equal(fs_.read("g.txt").text, "v1");

  fs_.copy("g.txt", "h.txt");
  assert.equal(fs_.read("h.txt").text, "v1");
  assert.equal(expectAppError(() => fs_.copy("g.txt", "h.txt")).httpStatus, 409);

  assert.deepEqual(fs_.remove("h.txt"), { removed: "h.txt" });
  assert.equal(expectAppError(() => fs_.remove("h.txt")).httpStatus, 404);
});

test("文件服务：目录删除必须显式 recursive", () => {
  const root = tmpRoot();
  mkdirSync(join(root, "dir", "inner"), { recursive: true });
  writeFileSync(join(root, "dir", "inner", "f.txt"), "x");
  const fs_ = new FileService({ root });

  // 非递归删除非空目录会失败——必须由调用方明确表态。
  expectAppError(() => fs_.remove("dir"));
  fs_.remove("dir", true);
  assert.ok(!existsSync(join(root, "dir")));

  // 工作目录本身永远不可删。
  assert.equal(expectAppError(() => fs_.remove("", true)).httpStatus, 400);
});

test("文件服务：不存在与类型不符的路径给出可操作原因", () => {
  const root = tmpRoot();
  writeFileSync(join(root, "f.txt"), "x");
  const fs_ = new FileService({ root });

  const missing = expectAppError(() => fs_.read("missing.txt"));
  assert.equal(missing.httpStatus, 404);
  assert.match(missing.message, /missing\.txt/);
  // 对文件用 list：说清类型不符，而不是含糊的「失败」。
  assert.equal(expectAppError(() => fs_.list("f.txt")).httpStatus, 400);
});

test("文件服务：对二进制扩展名拒绝文本写入", () => {
  const fs_ = new FileService({ root: tmpRoot() });
  // 否则会产出损坏的假图片，比直接拒绝更糟。
  const err = expectAppError(() => fs_.write("pic.png", "not really a png"));
  assert.equal(err.httpStatus, 400);
  assert.match(err.message, /二进制/);
});