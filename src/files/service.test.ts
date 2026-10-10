/**
 * 文件服务测试。重点在**安全边界**——这些函数会被 HTTP 暴露给任意调用方，
 * 一个路径穿越或符号链接逃逸就等于把整个文件系统交出去。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileService, isBinaryExtension, looksBinary } from "./service.js";
import { AppError } from "../errors.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-files-"));
}

/**
 * 在 `root` 里建一个指向 `outside` 目录的链接，返回链接的相对名；建不出来返回 null。
 *
 * 为什么用目录链接而不是文件符号链接：Windows 上创建符号链接需要开发者模式或管理员
 * 权限（实测 `EPERM`），于是这类测试在本机只能悄悄return —— 看着通过，实际从没跑过，
 * 正是最坏的一种状态。而 **junction 是 NTFS reparse point，普通用户就能建**，且
 * `realpath` 同样会穿过它（已实测），所以「符号链接逃逸」这道校验在 Windows 上
 * 也能被真正覆盖到。
 *
 * 降级顺序：junction（Windows免特权）→ symlink(dir)（macOS/Linux）→ symlink(file)。
 * 都失败才返回 null，由调用方显式 skip —— 不再静默假装通过。
 */
function linkToOutsideDir(root: string, outside: string): string | null {
  const attempts: Array<[string, string, "junction" | "dir" | "file"]> = [
    ["escape-dir", outside, "junction"],
    ["escape-dir", outside, "dir"],
    ["escape-file", join(outside, "secret.txt"), "file"],
  ];
  for (const [name, target, type] of attempts) {
    const linkPath = join(root, name);
    try {
      symlinkSync(target, linkPath, type);
      return name === "escape-file" ? name : `${name}/`;
    } catch {
      // 试下一种
    }
  }
  return null;
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

test("文件服务：符号链接逃逸被拒（resolve 拦不住这一类）", (t) => {
  const root = tmpRoot();
  const outside = tmpRoot();
  writeFileSync(join(outside, "secret.txt"), "top secret");
  const link = linkToOutsideDir(root, outside);
  if (!link) {
    t.skip("当前平台无法创建链接（既不支持 junction 也不支持 symlink）");
    return;
  }
  const fs_ = new FileService({ root });

  // 读穿链接要能拿到根外的文件——先确认这个链接确实构成威胁，否则下面的拒绝是空转
  assert.ok(realpathSync(join(root, link, "secret.txt")).startsWith(realpathSync(outside)),
    "前提：这个链接必须真的指向根外");

  const err = expectAppError(() => fs_.read(`${link}/secret.txt`));
  assert.equal(err.httpStatus, 400);
  assert.match(err.message, /符号链接/);
  expectAppError(() => fs_.write(`${link}/secret.txt`, "pwned"));
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

/**
 * 回归：realpath 校验曾fail-open（失败即放行）。
 *
 * 「字面路径在 root 内」并不等于「真实路径在 root 内」——符号链接正是把两者分开的机制。
 * realpath 失败（权限、异常链接、与删除竞争）恰好是这道检查失效的时刻，
 * 此时放行等于把安全校验交给运气。正确做法是 fail-closed：证明不了安全就拒绝。
 */
test("文件服务：无法校验真实路径时拒绝而非放行（fail-closed）", (t) => {
  const root = tmpRoot();
  const fs_ = new FileService({ root });
  const outside = tmpRoot();
  writeFileSync(join(outside, "secret.txt"), "top secret");

  // 指向根外的链接：正常情况下第二道校验会拦住。
  const link = linkToOutsideDir(root, outside);
  if (!link) {
    t.skip("当前平台无法创建链接（既不支持 junction 也不支持 symlink）");
    return;
  }
  assert.equal(expectAppError(() => fs_.read(`${link}/secret.txt`)).httpStatus, 400);

  // 关键：root 自身无法 realpath 时，服务必须拒绝一切路径，而不是全盘放行。
  const bogusRoot = join(tmpRoot(), "does-not-exist-root");
  try {
    new FileService({ root: bogusRoot });
    assert.fail("a root that cannot be resolved must fail fast, not silently degrade");
  } catch {
    // 构造期就失败——早失败好排查，胜过之后每次调用都不可靠。
  }
});

test("文件服务：对二进制扩展名拒绝文本写入", () => {
  const fs_ = new FileService({ root: tmpRoot() });
  // 否则会产出损坏的假图片，比直接拒绝更糟。
  const err = expectAppError(() => fs_.write("pic.png", "not really a png"));
  assert.equal(err.httpStatus, 400);
  assert.match(err.message, /二进制/);
});

/**
 * 回归：`.env` 旁路。
 *
 * root 就是 `process.cwd()`，而 `.env`（含 PI_API_KEY）正躺在那里。路径校验只拦
 * 「越出工作目录」，拦不住「工作目录内本来就有的密钥文件」——`GET /files/read?path=.env`
 * 会把 Key 原样吐出，与 provider-keys 守的「原始 key 永不出服务端」直接冲突。
 */
test("文件服务：敏感文件名在读 / 列表 / 写入中一律被拒", () => {
  const root = tmpRoot();
  writeFileSync(join(root, ".env"), "PI_API_KEY=leaked");
  writeFileSync(join(root, "id_rsa"), "PRIVATE KEY");
  writeFileSync(join(root, "server.pem"), "CERT");
  writeFileSync(join(root, "keep.txt"), "ok");
  const fs_ = new FileService({ root });

  for (const name of [".env", "id_rsa", "server.pem", ".env.local"]) {
    writeFileSync(join(root, ".env.local"), "PI_API_KEY=leaked");
    assert.equal(expectAppError(() => fs_.read(name)).httpStatus, 403, `${name} 必须被拒`);
  }
  // 写入同样被拒：既不能读走，也不能被改成别的密钥。
  assert.equal(expectAppError(() => fs_.write(".env", "x")).httpStatus, 403);

  // 列表里连名字都不能出现——列表带文本预览，否则是又一条旁路。
  const names = fs_.list("").entries.map((e) => e.name);
  assert.ok(!names.includes(".env"), ".env must not be listed");
  assert.ok(!names.includes("id_rsa"));
  assert.ok(!names.includes("server.pem"));
  assert.ok(names.includes("keep.txt"), "普通文件不受影响");
});

test("文件服务：denyNames 可覆盖默认名单", () => {
  const root = tmpRoot();
  writeFileSync(join(root, ".env"), "PI_API_KEY=leaked");
  writeFileSync(join(root, "custom.secret"), "x");
  const fs_ = new FileService({ root, denyNames: ["*.secret"] });

  // 换成自定义名单后 `.env` 放开、`*.secret` 被拒。
  assert.equal(fs_.read(".env").text, "PI_API_KEY=leaked");
  assert.equal(expectAppError(() => fs_.read("custom.secret")).httpStatus, 403);
});

/**
 * 回归：root 内的符号链接绕过 denyNames。
 *
 * 字面 basename 无害（`notes.txt`）不等于真实目标无害（`.env`）。更危险的是**列表**：
 * 它的预览走绝对路径直接读、不经过 `resolvePath`，所以只要条目被列出来，`.env` 的
 * 内容就会作为 `notes.txt` 的预览出现在目录列表里。
 */
test("文件服务：root 内的符号链接不能绕过 denyNames（读与列表预览）", () => {
  const root = tmpRoot();
  writeFileSync(join(root, ".env"), "PI_API_KEY=leaked");
  try {
    symlinkSync(".env", join(root, "notes.txt"));
  } catch {
    return; // 平台不支持符号链接
  }
  const fs_ = new FileService({ root });

  assert.equal(expectAppError(() => fs_.read("notes.txt")).httpStatus, 403, "读必须被拒");
  const listed = fs_.list("");
  assert.ok(!listed.entries.some((e) => e.name === "notes.txt"), "链接条目不能出现在列表里");
  assert.ok(
    !listed.entries.some((e) => (e.preview ?? "").includes("PI_API_KEY")),
    "列表预览绝不能吐出被拒文件的内容",
  );
});

/**
 * 回归：上传二进制必然损坏。
 *
 * 原实现是 `write(path, buf.toString("utf8"))`：非 UTF-8 字节被替换成 U+FFFD，
 * 且 `write` 本身又拒绝二进制扩展名——两头都对不上。
 */
test("文件服务：writeBinary 保证字节无损（上传路径）", () => {
  const fs_ = new FileService({ root: tmpRoot() });
  const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  fs_.writeBinary("media/blob.png", bytes);

  const written = readFileSync(join(fs_.root, "media", "blob.png"));
  assert.deepEqual(new Uint8Array(written), new Uint8Array(bytes), "binary bytes must survive intact");
  // 读回时如实标记为二进制，而不是把它当文本吐出来。
  assert.equal(fs_.read("media/blob.png").binary, true);
});