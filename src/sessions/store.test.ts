/**
 * 会话索引测试。重点是路径校验——sessionFile 决定 SDK 去读哪个文件，
 * 一旦可被伪造就等于让任意客户端读服务端任意 .jsonl。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  assertSessionFileAllowed,
  defaultSessionIndexFile,
  defaultSessionRoots,
  emptyIndex,
  sanitizeIndexEntries,
  scaffoldSessionDir,
  sessionCatalog,
  sessionIndexPort,
} from "./store.js";
import { AppError } from "../http/errors.js";

function expectAppError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    return err;
  }
  throw new assert.AssertionError({ message: "expected the call to throw" });
}

/** 造一个「会话目录 + 一个合法会话文件」。 */
function fixture(): { root: string; sessions: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-sess-"));
  const sessions = join(root, "sessions", "--cwd--");
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, "2026-10-08T10-30-00_abc123.jsonl");
  writeFileSync(file, '{"type":"session"}\n');
  return { root, sessions, file };
}

function entry(file: string, sessionId = "abc123") {
  return { sessionId, sessionFile: file, title: "好的", updatedAt: 1, messageCount: 2 };
}

test("会话：允许目录内的 .jsonl 被接受", () => {
  const { sessions, file } = fixture();
  assert.doesNotThrow(() => assertSessionFileAllowed(file, [sessions]));
});

test("会话：路径穿越被拒", () => {
  const { sessions, root } = fixture();
  const outside = join(root, "secret.jsonl");
  writeFileSync(outside, "{}");
  assert.equal(expectAppError(() => assertSessionFileAllowed(outside, [sessions])).httpStatus, 403);
});

test("会话：非 .jsonl 被拒（拦掉任意文件读取）", () => {
  const { sessions } = fixture();
  const other = join(sessions, "notes.txt");
  writeFileSync(other, "secret");
  const err = expectAppError(() => assertSessionFileAllowed(other, [sessions]));
  assert.equal(err.httpStatus, 400);
  assert.match(err.message, /jsonl/);
});

test("会话：相对路径被拒（免得解释歧义）", () => {
  const { sessions } = fixture();
  expectAppError(() => assertSessionFileAllowed("a/b.jsonl", [sessions]));
  expectAppError(() => assertSessionFileAllowed("", [sessions]));
});

test("会话：允许目录为空时一律拒绝（fail-closed，默认不开放恢复）", () => {
  const { file } = fixture();
  const err = expectAppError(() => assertSessionFileAllowed(file, []));
  assert.equal(err.httpStatus, 403);
  assert.match(err.message, /未启用/);
});

test("会话：不存在的文件被拒（fail-closed，不靠猜）", () => {
  const { sessions } = fixture();
  const ghost = join(sessions, "nope.jsonl");
  const err = expectAppError(() => assertSessionFileAllowed(ghost, [sessions]));
  assert.equal(err.httpStatus, 403);
});

test("会话：允许根目录不存在时拒绝，不退回字面路径", () => {
  const { root, file } = fixture();
  const missing = join(root, "no-such-root");
  const err = expectAppError(() => assertSessionFileAllowed(file, [missing]));
  assert.equal(err.httpStatus, 403);
  assert.match(err.message, /会话目录/);
});

test("会话：以 .. 开头的文件名仍在目录内时允许", () => {
  const { sessions } = fixture();
  const odd = join(sessions, "..inside.jsonl");
  writeFileSync(odd, "{}\n");
  assert.doesNotThrow(() => assertSessionFileAllowed(odd, [sessions]));
});

test("会话：符号链接指向目录外被拒（与文件服务同一个教训）", (t) => {
  const { root, sessions } = fixture();
  const outside = join(root, "secret.jsonl");
  writeFileSync(outside, "{}");
  const link = join(sessions, "link.jsonl");
  try {
    symlinkSync(outside, link, "file");
  } catch {
    t.skip("symlink not permitted");
    return;
  }
  const err = expectAppError(() => assertSessionFileAllowed(link, [sessions]));
  assert.equal(err.httpStatus, 403);
  assert.match(err.message, /不在允许的目录内/);
});

test("会话：索引条目过滤掉越界、缺 id 与畸形项", () => {
  const { root, sessions, file } = fixture();
  const outside = join(root, "evil.jsonl");
  writeFileSync(outside, "{}");

  const { kept, dropped } = sanitizeIndexEntries(
    [
      entry(file),
      { sessionFile: outside, title: "越界", updatedAt: 1, messageCount: 1 },
      { sessionFile: file, title: "缺 id", updatedAt: 1, messageCount: 1 },
      { sessionId: "x", sessionFile: file, title: 123 },
      { sessionId: "y", sessionFile: 42, title: "x" },
      "not-an-object",
      null,
    ],
    [sessions],
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.sessionId, "abc123");
  assert.equal(dropped, 6);
});

test("会话：索引落盘往返，损坏时回落为空，保存时丢掉越界路径", () => {
  const { root, sessions, file } = fixture();
  const indexFile = join(root, "index.json");
  const port = sessionIndexPort(indexFile, [sessions], { cwd: root });

  assert.deepEqual(port.load().conversations, []);
  assert.equal(port.load().cwd, root);

  const outside = join(root, "evil.jsonl");
  writeFileSync(outside, "{}");
  port.save({
    version: 1,
    cwd: "/somewhere-else",
    conversations: [
      entry(file),
      { sessionId: "evil", sessionFile: outside, title: "越界", updatedAt: 1, messageCount: 1 },
    ],
  });
  const raw = JSON.parse(readFileSync(indexFile, "utf8")) as { cwd: string; conversations: unknown[] };
  assert.equal(raw.cwd, root, "保存时写端口自己的 cwd，不接受调用方贴来的工作区");
  assert.equal(raw.conversations.length, 1);

  const reloaded = port.load();
  assert.equal(reloaded.conversations.length, 1);
  assert.equal(reloaded.conversations[0]?.title, "好的");

  writeFileSync(indexFile, "{{{ broken");
  assert.deepEqual(sessionIndexPort(indexFile, [sessions], { cwd: root }).load().conversations, []);

  writeFileSync(indexFile, "[1,2,3]");
  assert.deepEqual(sessionIndexPort(indexFile, [sessions], { cwd: root }).load().conversations, []);
});

test("会话：索引 cwd 对不上就整份忽略", () => {
  const { root, sessions, file } = fixture();
  const indexFile = join(root, "index.json");
  sessionIndexPort(indexFile, [sessions], { cwd: root }).save({
    version: 1,
    cwd: root,
    conversations: [entry(file)],
  });
  const other = sessionIndexPort(indexFile, [sessions], { cwd: join(root, "other-project") });
  assert.deepEqual(other.load().conversations, []);
});

test("会话：两个工作区的索引文件互不覆盖", () => {
  const a = fixture();
  const b = fixture();
  const catA = sessionCatalog(defaultSessionIndexFile(a.sessions), [a.sessions], a.root);
  const catB = sessionCatalog(defaultSessionIndexFile(b.sessions), [b.sessions], b.root);
  catA.upsert(entry(a.file, "aaa"));
  catB.upsert(entry(b.file, "bbb"));
  assert.equal(sessionCatalog(defaultSessionIndexFile(a.sessions), [a.sessions], a.root).get("aaa")?.title, "好的");
  assert.equal(sessionCatalog(defaultSessionIndexFile(b.sessions), [b.sessions], b.root).get("bbb")?.sessionId, "bbb");
  assert.equal(catA.get("bbb"), undefined);
});

test("会话：目录外的路径不能写进目录", () => {
  const { root, sessions, file } = fixture();
  const catalog = sessionCatalog(join(sessions, "index.json"), [sessions], root);
  catalog.upsert(entry(file));
  const outside = join(root, "secret.jsonl");
  writeFileSync(outside, "{}");
  const err = expectAppError(() =>
    catalog.upsert({ sessionId: "nope", sessionFile: outside, title: "x", updatedAt: 1, messageCount: 1 }),
  );
  assert.equal(err.httpStatus, 403);
  assert.equal(catalog.list().length, 1);
  assert.equal(catalog.get("nope"), undefined);
});

test("会话：空索引工厂", () => {
  const idx = emptyIndex("/some/cwd");
  assert.equal(idx.version, 1);
  assert.deepEqual(idx.conversations, []);
  assert.equal(idx.cwd, "/some/cwd");
});

test("会话：显式目录不询问 SDK，空 cwd 不抛", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sess-dir-"));
  const explicit = join(root, "ours");
  const roots = defaultSessionRoots("", explicit);
  assert.deepEqual(roots, [explicit]);
  assert.deepEqual(defaultSessionRoots(""), []);
});

test("会话：默认目录是 SDK 目录的兄弟，且不复现编码", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-dir-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-cwd-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const ours = scaffoldSessionDir(cwd);
    const sdk = SessionManager.create(cwd).getSessionDir();
    assert.notEqual(ours, sdk);
    assert.equal(dirname(ours), dirname(sdk));
    assert.equal(basename(ours), `${basename(sdk)}.pi-starter`);
    assert.equal(ours.startsWith(agentDir), true, "测试不得写到用户真实的会话目录");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
