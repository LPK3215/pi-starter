/**
 * 文件服务 HTTP 路由测试。
 *
 * 这一层此前完全没有测试（`file-routes.ts` 覆盖率 43%，是全项目最低的几个文件之一），
 * 而它恰好是**把工作目录暴露成 HTTP 服务**的那一层 —— 敏感文件拦截、路径必填、
 * Range 语义、二进制上传的完整性都在这里落地。服务层的 `FileService` 有测试，
 * 但「路由把参数翻译对了吗」是另一个问题：例如 `recursive` 传字符串 `"true"` 时
 * 会不会被 `=== true` 挡住、缺 `path` 时会不会悄悄退回根目录。
 *
 * 覆盖重点：
 *   1. 不提供 service 时 `/files/*` 完全不注册（不是注册了再报 403）；
 *   2. `requirePath` 的 fail-closed（缺 path = 400，而不是读根目录）；
 *   3. 敏感文件名在 read / raw / **列表预览** 三个出口都被拦住；
 *   4. `/files/raw` 的 Range 语义（206 / 后缀区间 / 416 / 无 Range 超限 413 / download）；
 *   5. `/files/upload` 的**字节级往返**（历史上 `write` + `toString("utf8")` 会损坏二进制）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../app.js";
import { listenTestServer } from "../test-server.js";
import { FileService } from "../files/service.js";
import { SessionHub } from "../session-hub.js";
import { resolveRuntimeConfig } from "../config.js";
import { SettingsService } from "../settings.js";
import type { BuiltAgent } from "../agent.js";

/** 与 approval-routes.test.ts 同一套最小替身。 */
function fakeAgent(): BuiltAgent {
  const model = { provider: "test", id: "m1", name: "M1", contextWindow: 1000 } as never;
  const session = {
    sessionId: "s1",
    model,
    isStreaming: false,
    activeTools: [] as string[],
    subscribe: () => () => {},
    getSessionStats: () => ({
      sessionFile: undefined,
      sessionId: "s1",
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    }),
    getActiveToolNames: () => [] as string[],
    setActiveToolsByName: () => {},
    getSteeringMessages: () => [] as never,
    getFollowUpMessages: () => [] as never,
    setThinkingLevel: () => {},
    setModel: async () => {},
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  };
  return {
    session,
    model,
    builtinTools: "off" as const,
    web: { enabled: false, toolNames: [] },
    skills: [],
    knowledge: [],
    database: {
      driver: "sqlite",
      path: ":memory:",
      ping: () => ({ ok: true as const, driver: "sqlite", path: ":memory:" }),
      listNotes: () => [],
      getNote: () => undefined,
      searchNotes: () => [],
      insertNote: () => ({ id: 1, title: "t", body: "b" }),
      query: () => ({ columns: [], rows: [], truncated: false, totalRows: 0 }),
      close: () => {},
    },
    listModels: async () => [model],
    switchModel: async () => model,
    dispose: () => {},
  } as never;
}

/** 起一个带（或不带）文件服务的 app，以及一个干净的临时 root。 */
async function start(options: { files?: FileService; bodyLimit?: string | number } = {}) {
  const agent = fakeAgent();
  const hub = new SessionHub(agent, resolveRuntimeConfig());
  const { app, dispose } = createApp({
    agent,
    registry: undefined as never,
    settings: new SettingsService(),
    hub: hub as never,
    ...(options.files ? { files: options.files } : {}),
    ...(options.bodyLimit !== undefined ? { bodyLimit: options.bodyLimit } : {}),
  });
  const s = await listenTestServer(app);
  return {
    base: s.url,
    async close() {
      dispose();
      hub.dispose();
      await s.close();
    },
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-files-"));
}

/** 带 JSON body 的 POST。 */
function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

/* ────────────────────────── 注册开关 ────────────────────────── */

test("未提供 FileService 时 /files/* 完全不注册", async () => {
  const h = await start();
  try {
    for (const path of ["/files/list", "/files/read?path=a.txt", "/files/raw?path=a.txt"]) {
      const res = await fetch(`${h.base}${path}`);
      assert.notEqual(res.status, 200, `${path} 不该可用`);
    }
    assert.notEqual((await post(h.base, "/files/write", { path: "a.txt", content: "x" })).status, 200);
  } finally {
    await h.close();
  }
});

/* ────────────────────────── 必填参数 fail-closed ────────────────────────── */

test("缺 path / 空白 path 一律 400，绝不悄悄退回根目录", async () => {
  const root = tempRoot();
  const h = await start({ files: new FileService({ root }) });
  try {
    for (const query of ["", `?${q({ path: "" })}`, `?${q({ path: "   " })}`]) {
      const res = await fetch(`${h.base}/files/read${query}`);
      assert.equal(res.status, 400, `read${query} 应 400`);
    }
    // rename / copy 的两个字段分别校验：只给一个也必须 400。
    assert.equal((await post(h.base, "/files/rename", { from: "a", to: "" })).status, 400);
    assert.equal((await post(h.base, "/files/rename", { to: "b" })).status, 400);
    assert.equal((await post(h.base, "/files/delete", {})).status, 400);
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ────────────────────────── 敏感文件 ────────────────────────── */

test("敏感文件在 read / raw / 列表预览三个出口都被拦住（且不回显内容）", async () => {
  const root = tempRoot();
  writeFileSync(join(root, ".env"), "PI_API_KEY=sk-super-secret\n", "utf8");
  writeFileSync(join(root, "notes.txt"), "普通文本\n", "utf8");
  const h = await start({ files: new FileService({ root }) });
  try {
    const read = await fetch(`${h.base}/files/read?${q({ path: ".env" })}`);
    assert.ok(read.status >= 400, "read 必须拒绝 .env");
    assert.ok(!(await read.text()).includes("sk-super-secret"), "拒绝时也绝不能回显内容");

    const raw = await fetch(`${h.base}/files/raw?${q({ path: ".env" })}`);
    assert.ok(raw.status >= 400, "raw 必须拒绝 .env");
    assert.ok(!(await raw.text()).includes("sk-super-secret"));

    // 列表预览是历史上被漏掉的第二个出口（绝对路径直读、不经 resolvePath）。
    const list = await fetch(`${h.base}/files/list`);
    const body = await list.text();
    assert.ok(!body.includes("sk-super-secret"), "目录列表绝不能带出敏感文件内容");
    const entries = JSON.parse(body) as { entries?: Array<{ name: string }> } | Array<{ name: string }>;
    const names = (Array.isArray(entries) ? entries : (entries.entries ?? [])).map((e) => e.name);
    assert.ok(!names.includes(".env"), "敏感文件连列都不该列出来");
    assert.ok(names.includes("notes.txt"), "普通文件要正常列出");
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ────────────────────────── 读写 ────────────────────────── */

test("write / create：content 类型与「已存在」语义正确", async () => {
  const root = tempRoot();
  const h = await start({ files: new FileService({ root }) });
  try {
    assert.equal((await post(h.base, "/files/write", { path: "a.txt", content: 42 })).status, 400);
    assert.equal((await post(h.base, "/files/write", { content: "x" })).status, 400);

    const written = await post(h.base, "/files/write", { path: "a.txt", content: "hello" });
    assert.equal(written.status, 200);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "hello");

    // create 要求目标不存在；省略 content 等于空文件。
    const created = await post(h.base, "/files/create", { path: "b.txt" });
    assert.equal(created.status, 200);
    assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "");

    assert.ok((await post(h.base, "/files/create", { path: "a.txt", content: "覆写" })).status >= 400);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "hello", "create 不该覆盖已有文件");
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rename / copy / delete：recursive 必须是布尔 true，字符串 \"true\" 不算数", async () => {
  const root = tempRoot();
  mkdirSync(join(root, "dir"));
  writeFileSync(join(root, "dir", "f.txt"), "x", "utf8");
  const h = await start({ files: new FileService({ root }) });
  try {
    // 字符串 "true" 落到 `recursive === true` 上为假 → 目录必须被拒（不是被当成递归删）。
    const del = await post(h.base, "/files/delete", { path: "dir", recursive: "true" });
    assert.ok(del.status >= 400, "字符串 recursive 不该被当成 true");
    assert.ok(existsSync(join(root, "dir")), "被拒的删除不能动到磁盘");

    const copy = await post(h.base, "/files/copy", { from: "dir", to: "dir2", recursive: "TRUE" });
    assert.ok(copy.status >= 400);

    // 显式布尔 true 才生效。
    assert.equal((await post(h.base, "/files/copy", { from: "dir", to: "dir2", recursive: true })).status, 200);
    assert.ok(existsSync(join(root, "dir2", "f.txt")));

    assert.equal((await post(h.base, "/files/rename", { from: "dir2", to: "dir3" })).status, 200);
    assert.equal((await post(h.base, "/files/delete", { path: "dir3", recursive: true })).status, 200);
    assert.ok(!existsSync(join(root, "dir3")));
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ────────────────────────── /files/raw 的 Range 语义 ────────────────────────── */

test("/files/raw：Range 的 206 / 后缀区间 / 416 / 无 Range 超限 413", async () => {
  const root = tempRoot();
  writeFileSync(join(root, "data.txt"), "0123456789", "utf8");
  // 预览上限调到 4 字节，免得为了触发 413 去造一个 512KB 的文件。
  const h = await start({ files: new FileService({ root, maxPreviewBytes: 4 }) });
  try {
    const missing = await fetch(`${h.base}/files/raw?${q({ path: "nope.txt" })}`);
    assert.equal(missing.status, 400, "不存在的文件是 400");

    const dir = await fetch(`${h.base}/files/raw?${q({ path: "." })}`);
    assert.equal(dir.status, 400, "目录不是文件");

    // bytes=2-5 → 2345
    const part = await fetch(`${h.base}/files/raw?${q({ path: "data.txt" })}`, {
      headers: { range: "bytes=2-5" },
    });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(part.headers.get("accept-ranges"), "bytes");
    assert.equal(await part.text(), "2345");

    // bytes=-3 → 最后 3 字节
    const suffix = await fetch(`${h.base}/files/raw?${q({ path: "data.txt" })}`, {
      headers: { range: "bytes=-3" },
    });
    assert.equal(suffix.status, 206);
    assert.equal(await suffix.text(), "789");

    // 起点越界 → 416 且给出真实长度，客户端才能续传
    const bad = await fetch(`${h.base}/files/raw?${q({ path: "data.txt" })}`, {
      headers: { range: "bytes=99-200" },
    });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get("content-range"), "bytes */10");

    // 无 Range 且超过预览上限 → 413 并指路 Range（而不是把大文件整个塞进响应）
    const tooBig = await fetch(`${h.base}/files/raw?${q({ path: "data.txt" })}`);
    assert.equal(tooBig.status, 413);
    const payload = (await tooBig.json()) as { error?: string; size?: number };
    assert.equal(payload.size, 10);

    // 有 Range 时即使文件超过预览上限也照常给
    const rangedBig = await fetch(`${h.base}/files/raw?${q({ path: "data.txt" })}`, {
      headers: { range: "bytes=0-1" },
    });
    assert.equal(rangedBig.status, 206);
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("/files/raw：download=true 带附件头；二进制扩展名给 octet-stream", async () => {
  const root = tempRoot();
  writeFileSync(join(root, "数据.txt"), "中文正文", "utf8");
  writeFileSync(join(root, "blob.bin"), Buffer.from([1, 2, 3]));
  const h = await start({ files: new FileService({ root }) });
  try {
    const download = await fetch(`${h.base}/files/raw?${q({ path: "数据.txt", download: "true" })}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /^attachment; filename="/);
    assert.match(download.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(await download.text(), "中文正文");

    const binary = await fetch(`${h.base}/files/raw?${q({ path: "blob.bin" })}`);
    assert.equal(binary.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual([...new Uint8Array(await binary.arrayBuffer())], [1, 2, 3]);
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ────────────────────────── /files/upload ────────────────────────── */

test("upload：dataBase64 类型校验、已存在需 overwrite、二进制字节完整往返", async () => {
  const root = tempRoot();
  const h = await start({ files: new FileService({ root }) });
  try {
    assert.equal((await post(h.base, "/files/upload", { path: "x.bin", dataBase64: 123 })).status, 400);

    // 非法 UTF-8 字节：`write` + `toString("utf8")` 会把它们换成 U+FFFD。
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f]);
    const first = await post(h.base, "/files/upload", { path: "x.bin", dataBase64: bytes.toString("base64") });
    assert.equal(first.status, 200);
    assert.deepEqual([...readFileSync(join(root, "x.bin"))], [...bytes], "磁盘字节必须与上传字节逐字节一致");

    // 已存在且未声明 overwrite → 409（避免误覆盖）
    const again = await post(h.base, "/files/upload", {
      path: "x.bin",
      dataBase64: Buffer.from([9]).toString("base64"),
    });
    assert.equal(again.status, 409);
    assert.deepEqual([...readFileSync(join(root, "x.bin"))], [...bytes], "409 时不能改动已有文件");

    const overwrite = await post(h.base, "/files/upload", {
      path: "x.bin",
      dataBase64: Buffer.from([9]).toString("base64"),
      overwrite: true,
    });
    assert.equal(overwrite.status, 200);
    assert.deepEqual([...readFileSync(join(root, "x.bin"))], [9]);
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("upload 的上限是「两层叠加」的：默认 1mb body 先挡，放开 bodyLimit 后才是路由的 5MB 上限", async () => {
  const root = tempRoot();
  const files = new FileService({ root });

  // 第一层：默认 bodyLimit 是 1mb，而 base64 会放大约 4/3 ——
  // 所以原始字节刚过 1MB 就已经被 body 解析器挡下了，路由里的 5MB 检查此时**不可达**。
  const strict = await start({ files });
  try {
    const over = Buffer.alloc(1024 * 1024 + 1024);
    const res = await post(strict.base, "/files/upload", { path: "big.bin", dataBase64: over.toString("base64") });
    assert.equal(res.status, 413, "超过 1mb 的 body 必须 413");
    assert.ok(!existsSync(join(root, "big.bin")), "被挡住的上传不能落盘");
  } finally {
    await strict.close();
  }

  // 第二层：把 bodyLimit 放开后，才轮到路由自己的 5MB 原始字节上限。
  const loose = await start({ files, bodyLimit: "16mb" });
  try {
    const justRight = Buffer.alloc(1024 * 1024 + 1024);
    assert.equal(
      (await post(loose.base, "/files/upload", { path: "ok.bin", dataBase64: justRight.toString("base64") })).status,
      200,
      "放开 bodyLimit 后 1MB 出头的上传应当成功",
    );

    const tooBig = Buffer.alloc(5 * 1024 * 1024 + 1);
    const res = await post(loose.base, "/files/upload", { path: "huge.bin", dataBase64: tooBig.toString("base64") });
    assert.equal(res.status, 413, "超过 5MB 原始字节必须由路由拦下");
    assert.match((await res.json()).error ?? "", /5?24288|5242880/);
    assert.ok(!existsSync(join(root, "huge.bin")));
  } finally {
    await loose.close();
    rmSync(root, { recursive: true, force: true });
  }
});
