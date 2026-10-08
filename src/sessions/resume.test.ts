/**
 * 恢复链路：打开文件前必须校验；客户端只拿会话 id；重启后能从索引接回来。
 * 不启真模型——会话文件用 SDK 的 SessionManager 读写，对话外壳用替身。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { resolveSessionManager } from "../agent.js";
import { resolveRuntimeConfig } from "../config.js";
import { AppError } from "../http/errors.js";
import { SessionHub } from "../session-hub.js";
import type { BuiltAgent } from "../agent.js";
import { defaultSessionIndexFile, sessionCatalog, type SessionCatalog } from "./store.js";

function expectAppError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    return err;
  }
  throw new assert.AssertionError({ message: "expected the call to throw" });
}

function writeSession(dir: string, id: string, cwd: string): string {
  const file = join(dir, `2026-10-08T00-00-00_${id}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id,
    timestamp: "2026-10-08T00:00:00.000Z",
    cwd,
  };
  writeFileSync(file, `${JSON.stringify(header)}\n`);
  return file;
}

test("恢复：允许目录内的文件能被打开，且 id 来自文件头", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-resume-"));
  const dir = join(cwd, "sessions");
  mkdirSync(dir);
  const file = writeSession(dir, "abc12345", cwd);
  const manager = resolveSessionManager(false, dir, file, [dir]);
  assert.equal(manager.getSessionId(), "abc12345");
  assert.equal(manager.getSessionFile(), file);
});

test("恢复：目录外、空允许根、内存会话都不能打开", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-resume-"));
  const dir = join(cwd, "sessions");
  mkdirSync(dir);
  const file = writeSession(dir, "abc12345", cwd);
  const outside = writeSession(cwd, "out12345", cwd);

  assert.equal(expectAppError(() => resolveSessionManager(false, dir, outside, [dir])).httpStatus, 403);
  assert.equal(expectAppError(() => resolveSessionManager(false, dir, file, [])).httpStatus, 403);
  assert.equal(expectAppError(() => resolveSessionManager(true, dir, file, [dir])).httpStatus, 400);
  assert.match(
    expectAppError(() => resolveSessionManager(true, dir, file, [dir])).message,
    /内存会话/,
  );
});

class FakeSession {
  readonly sessionId: string;
  readonly sessionFile: string;
  messages: Array<{ role: string; content: string; timestamp: number }> = [];
  model: Model<any>;
  thinkingLevel = "default";
  isStreaming = false;
  private listeners = new Set<(event: { type: string; messages?: unknown[]; willRetry?: boolean }) => void>();

  constructor(sessionId: string, sessionFile: string, model: Model<any>) {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
    this.model = model;
  }

  subscribe(listener: (event: { type: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: { type: string; messages?: unknown[]; willRetry?: boolean }): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  getSessionStats() {
    return {
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: this.messages.length,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    };
  }

  getActiveToolNames(): string[] {
    return ["read"];
  }
  setActiveToolsByName(): void {}
  getSteeringMessages(): readonly string[] {
    return [];
  }
  getFollowUpMessages(): readonly string[] {
    return [];
  }
  setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
  }
  async setModel(model: Model<any>): Promise<void> {
    this.model = model;
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  dispose(): void {}
}

function makeAgent(dir: string, cwd: string): {
  agent: BuiltAgent;
  created: FakeSession[];
} {
  const model = { provider: "test", id: "m1", name: "M1", contextWindow: 1000 } as Model<any>;
  const created: FakeSession[] = [];
  let n = Math.floor(Math.random() * 1_000_000);
  const agent = {
    session: new FakeSession("shared0001", join(dir, "unused.jsonl"), model),
    get model() {
      return model;
    },
    builtinTools: "off" as const,
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
    createSession: async (opts?: { resumeFrom?: string }) => {
      if (opts?.resumeFrom) {
        const manager = SessionManager.open(opts.resumeFrom, dir);
        const file = manager.getSessionFile();
        if (!file) throw new Error("opened session has no file");
        const session = new FakeSession(manager.getSessionId(), file, model);
        created.push(session);
        return session as never;
      }
      n += 1;
      const id = `new${n}abcde`;
      const file = writeSession(dir, id, cwd);
      const session = new FakeSession(id, file, model);
      created.push(session);
      return session as never;
    },
    dispose: () => {},
  };
  return { agent: agent as never, created };
}

function workspace(): { cwd: string; dir: string; catalog: SessionCatalog } {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ws-"));
  const dir = join(cwd, "ours");
  mkdirSync(dir);
  const catalog = sessionCatalog(defaultSessionIndexFile(dir), [dir], cwd);
  return { cwd, dir, catalog };
}

test("恢复：重启后按 id 接回，路径不经过调用方", async () => {
  const { cwd, dir, catalog } = workspace();
  const { agent, created } = makeAgent(dir, cwd);
  const hub = new SessionHub(agent, resolveRuntimeConfig(), cwd, () => 6, 8, () => 0, [dir], catalog);
  const client = await hub.attach("c1", () => {});
  const live = client.active!;
  const savedId = live.id;
  const fake = created.find((session) => session.sessionId === savedId);
  assert.ok(fake);
  fake.messages.push({ role: "user", content: "记得这句话", timestamp: 1 });
  fake.emit({ type: "message_end" });
  fake.emit({ type: "agent_end", messages: [], willRetry: false });
  assert.equal(catalog.get(savedId)?.title, "记得这句话");
  hub.dispose();

  const reloaded = sessionCatalog(defaultSessionIndexFile(dir), [dir], cwd);
  assert.equal(reloaded.get(savedId)?.title, "记得这句话");
  const { agent: agent2 } = makeAgent(dir, cwd);
  const hub2 = new SessionHub(agent2, resolveRuntimeConfig(), cwd, () => 6, 8, () => 0, [dir], reloaded);
  const again = await hub2.attach("c2", () => {});
  const listed = again.listConversations().find((item) => item.id === savedId);
  assert.equal(listed?.dormant, true);
  assert.equal(again.switchConversation(savedId), false, "未加载的历史不能靠 switch 切过去");

  const opened = await hub2.openConversation("c2", savedId);
  assert.equal(opened.id, savedId);
  assert.equal(opened.title, "记得这句话");
  assert.equal(again.listConversations().find((item) => item.id === savedId)?.dormant, undefined);
  hub2.dispose();
});

test("恢复：另一个连接不能抢走已经打开的对话，索引外的文件打不开", async () => {
  const { cwd, dir, catalog } = workspace();
  const file = writeSession(dir, "kept12345", cwd);
  catalog.upsert({
    sessionId: "kept12345",
    sessionFile: file,
    title: "留下",
    updatedAt: 5,
    messageCount: 1,
  });
  const stray = writeSession(dir, "stray1234", cwd);
  const { agent } = makeAgent(dir, cwd);
  const hub = new SessionHub(agent, resolveRuntimeConfig(), cwd, () => 6, 8, () => 0, [dir], catalog);
  await hub.attach("a", () => {});
  await hub.attach("b", () => {});
  const opened = await hub.openConversation("a", "kept12345");
  assert.equal(opened.title, "留下");
  const err = await hub.openConversation("b", "kept12345").then(
    () => {
      throw new Error("expected conflict");
    },
    (caught: unknown) => caught,
  );
  assert.ok(err instanceof AppError);
  assert.equal(err.code, "conflict");
  assert.equal(hub.get("a")?.get("kept12345")?.id, "kept12345");

  const missing = await hub.openConversation("b", "stray1234").then(
    () => {
      throw new Error("expected not found");
    },
    (caught: unknown) => caught,
  );
  assert.ok(missing instanceof AppError);
  assert.equal(missing.code, "not_found");
  assert.ok(stray);
  hub.dispose();
});

test("恢复：没有会话工厂时不会静默退回共享会话", async () => {
  const { cwd, dir, catalog } = workspace();
  const file = writeSession(dir, "solo12345", cwd);
  catalog.upsert({
    sessionId: "solo12345",
    sessionFile: file,
    title: "旧的",
    updatedAt: 1,
    messageCount: 1,
  });
  const { agent } = makeAgent(dir, cwd);
  const stripped: BuiltAgent = { ...agent, createSession: undefined };
  const hub = new SessionHub(stripped, resolveRuntimeConfig(), cwd, () => 6, 8, () => 0, [dir], catalog);
  await hub.attach("c", () => {});
  const err = await hub.openConversation("c", "solo12345").then(
    () => {
      throw new Error("expected failure");
    },
    (caught: unknown) => caught,
  );
  assert.ok(err instanceof AppError);
  assert.equal(err.httpStatus, 400);
  hub.dispose();
});

test("恢复：打开结果的 id 和索引不一致时丢掉这次会话", async () => {
  const { cwd, dir, catalog } = workspace();
  const file = writeSession(dir, "real12345", cwd);
  catalog.upsert({
    sessionId: "real12345",
    sessionFile: file,
    title: "真的",
    updatedAt: 1,
    messageCount: 1,
  });
  const { agent } = makeAgent(dir, cwd);
  let lie = 0;
  const lying: BuiltAgent = {
    ...agent,
    createSession: async () => {
      lie += 1;
      return new FakeSession(`other${lie}123`, file, agent.model) as never;
    },
  };
  const hub = new SessionHub(lying, resolveRuntimeConfig(), cwd, () => 6, 8, () => 0, [dir], catalog);
  const client = await hub.attach("c", () => {});
  const before = client.conversationCount();
  const err = await hub.openConversation("c", "real12345").then(
    () => {
      throw new Error("expected mismatch");
    },
    (caught: unknown) => caught,
  );
  assert.ok(err instanceof AppError);
  assert.match(err.message, /不一致/);
  assert.equal(client.get("other2123"), undefined);
  assert.equal(client.get("real12345"), undefined);
  assert.equal(client.conversationCount(), before);
  assert.ok(catalog.get("real12345"), "id 对不上不是文件坏了，索引要留着");
  hub.dispose();
});
