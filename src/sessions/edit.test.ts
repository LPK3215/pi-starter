/**
 * 会话编辑：调用 SDK 的会话树，不另写一套存储。
 *
 * 回退如果只 branch()、不追加标记，重新打开文件会回到最后一条。
 * 这条测试重新打开文件，所以那个缺陷会变红。不连模型。
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { resolveRuntimeConfig } from "../config.js";
import { AppError } from "../errors.js";
import type { ServerMessage } from "../protocol.js";
import { Conversation, SessionHub } from "../session-hub.js";
import type { BuiltAgent } from "../agent.js";
import {
  TREE_MARKER_TYPE,
  editUserMessage,
  forkSessionFile,
  normalizeConversationTitle,
  rollbackSession,
} from "./edit.js";
import { defaultSessionIndexFile, sessionCatalog, type SessionCatalog } from "./store.js";
import { tempDir } from "../test-tmp.js";

function texts(manager: SessionManager): string[] {
  return manager.buildSessionContext().messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text"
        ? String((part as { text?: string }).text ?? "")
        : ""))
      .join("");
  });
}

function user(text: string) {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistant(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function transcript(dir: string, cwd: string): { manager: SessionManager; ids: Record<string, string> } {
  const manager = SessionManager.create(cwd, dir);
  const ids = {
    u1: manager.appendMessage(user("第一句") as never),
    a1: manager.appendMessage(assistant("第一答") as never),
    u2: manager.appendMessage(user("第二句") as never),
    a2: manager.appendMessage(assistant("第二答") as never),
  };
  return { manager, ids };
}

test("回退丢掉后半段，重新打开文件也不会回来", () => {
  const cwd = tempDir("pi-edit-");
  const dir = join(cwd, "sessions");
  mkdirSync(dir);
  const { manager, ids } = transcript(dir, cwd);
  const file = manager.getSessionFile();
  assert.ok(file);
  rollbackSession(manager, ids.a1);
  assert.deepEqual(texts(manager), ["第一句", "第一答"]);
  const leaf = manager.getLeafEntry();
  assert.equal(leaf?.type, "custom");
  if (leaf?.type === "custom") assert.equal(leaf.customType, TREE_MARKER_TYPE);

  const again = SessionManager.open(file);
  assert.deepEqual(texts(again), ["第一句", "第一答"]);
  assert.equal(again.getSessionId(), manager.getSessionId());
  const againLeaf = again.getLeafEntry();
  assert.equal(againLeaf?.type, "custom");
});

test("编辑用户消息会把它和后面的内容移出路径，并交还原文；助手消息不能编辑", () => {
  const cwd = tempDir("pi-edit-");
  const dir = join(cwd, "sessions");
  mkdirSync(dir);
  const { manager, ids } = transcript(dir, cwd);
  const file = manager.getSessionFile();
  assert.ok(file);
  const before = manager.getLeafId();

  assert.throws(() => editUserMessage(manager, ids.a1), (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.match(err.message, /只能编辑用户消息/);
    return true;
  });
  assert.equal(manager.getLeafId(), before);
  assert.deepEqual(texts(manager), ["第一句", "第一答", "第二句", "第二答"]);

  const edited = editUserMessage(manager, ids.u2);
  assert.equal(edited.text, "第二句");
  assert.deepEqual(texts(manager), ["第一句", "第一答"]);
  assert.deepEqual(texts(SessionManager.open(file)), ["第一句", "第一答"]);
});

test("编辑第一条用户消息后，当前路径是空的，重启也还是空的", () => {
  const cwd = tempDir("pi-edit-");
  const dir = join(cwd, "sessions");
  mkdirSync(dir);
  const { manager, ids } = transcript(dir, cwd);
  const file = manager.getSessionFile();
  assert.ok(file);
  const edited = editUserMessage(manager, ids.u1);
  assert.equal(edited.text, "第一句");
  assert.deepEqual(texts(manager), []);
  assert.deepEqual(texts(SessionManager.open(file)), []);
});

test("分叉写出另一个文件，源会话的 id 和文件不变；没有助手回复的路径不会落盘", () => {
  const cwd = tempDir("pi-edit-");
  const dir = join(cwd, "sessions");
  mkdirSync(dir);
  const { manager, ids } = transcript(dir, cwd);
  const file = manager.getSessionFile();
  const sourceId = manager.getSessionId();
  assert.ok(file);

  const forked = forkSessionFile(file, ids.a1, [dir]);
  assert.notEqual(forked.sessionId, sourceId);
  assert.notEqual(forked.sessionFile, file);
  assert.equal(manager.getSessionId(), sourceId);
  assert.equal(manager.getSessionFile(), file);
  assert.deepEqual(texts(SessionManager.open(forked.sessionFile)), ["第一句", "第一答"]);
  assert.equal(SessionManager.open(file).getSessionId(), sourceId);

  assert.throws(() => forkSessionFile(file, ids.u1, [dir]), (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.match(err.message, /助手回复/);
    return true;
  });
  assert.equal(manager.getSessionId(), sourceId);
});

test("空标题和超长标题被拒绝", () => {
  assert.throws(() => normalizeConversationTitle("  \n\t"), /不能为空/);
  assert.equal(normalizeConversationTitle("你好\r\n世界"), "你好 世界");
  assert.throws(() => normalizeConversationTitle("名".repeat(81)), /80/);
  assert.equal(normalizeConversationTitle("名".repeat(80)).length, 80);
});

test("组装层调用的是分叉函数，不是正在使用的那个 manager", () => {
  const hubSrc = readFileSync(fileURLToPath(new URL("../session-hub.ts", import.meta.url)), "utf8");
  const wsSrc = readFileSync(fileURLToPath(new URL("../transport/ws.ts", import.meta.url)), "utf8");
  assert.match(hubSrc, /forkSessionFile\(/);
  assert.doesNotMatch(hubSrc, /createBranchedSession/);
  assert.match(wsSrc, /rename_conversation/);
  assert.match(wsSrc, /rollback_conversation/);
  assert.match(wsSrc, /edit_message/);
  assert.match(wsSrc, /fork_conversation/);
});

class TreeSession {
  readonly sessionManager: SessionManager;
  readonly agent = { state: { messages: [] as AgentMessage[] } };
  isStreaming = false;
  model: Model<any>;
  thinkingLevel = "off";
  private listeners = new Set<(event: { type: string }) => void>();

  constructor(manager: SessionManager, model: Model<any>) {
    this.sessionManager = manager;
    this.model = model;
    this.agent.state.messages = manager.buildSessionContext().messages;
  }

  get sessionId(): string {
    return this.sessionManager.getSessionId();
  }

  get sessionFile(): string | undefined {
    return this.sessionManager.getSessionFile();
  }

  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  subscribe(listener: (event: { type: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: { type: string }): void {
    for (const listener of this.listeners) listener(event);
  }

  setSessionName(name: string): void {
    this.sessionManager.appendSessionInfo(name);
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
    return [];
  }
  getSteeringMessages(): readonly string[] {
    return [];
  }
  getFollowUpMessages(): readonly string[] {
    return [];
  }

  /** 官方 prompt 的测试替身：把用户消息追加进会话树（叶子随之移动）。 */
  async prompt(text: string): Promise<void> {
    this.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() } as never);
    this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
  }

  /** 官方 navigateTree 的测试替身：记下调用、挪叶子、刷新模型看到的消息。 */
  readonly navigateTreeCalls: Array<{ id: string; options?: unknown }> = [];
  navigateTree(
    id: string,
    options?: { summarize?: boolean; customInstructions?: string },
  ): Promise<{ cancelled: boolean }> {
    this.navigateTreeCalls.push({ id, options });
    this.sessionManager.branch(id);
    this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
    return Promise.resolve({ cancelled: false });
  }
}

function conversation(manager: SessionManager): { conv: Conversation; frames: ServerMessage[] } {
  const frames: ServerMessage[] = [];
  const model = { provider: "test", id: "m", name: "M", contextWindow: 1000 } as Model<any>;
  const session = new TreeSession(manager, model);
  const conv = new Conversation({
    clientId: "c",
    session: session as never,
    fallbackModel: model,
    cwd: manager.getCwd(),
    cfg: resolveRuntimeConfig(),
    push: (msg) => frames.push(msg),
    listConversations: () => [],
  });
  return { conv, frames };
}

/**
 * 原子"替换并重发"——官方 `onEdit` / `onReload` 的落点。
 *
 * 这条测试锁的是**原子性**：如果实现改成让客户端发 `edit_message` + `prompt` 两条命令，
 * 两次之间任何一次失败都会留下重复的用户消息；这里要求"移除 + 重发"是一次调用完成。
 */
test("原子替换并重发：replaceEntryId 先把该用户消息移出路径，再用新文本重发", async () => {
  const cwd = tempDir("pi-edit-");
  const dir = join(cwd, "sessions");
  mkdirSync(dir);
  const { manager, ids } = transcript(dir, cwd); // u1 → a1 → u2 → a2
  const { conv } = conversation(manager);

  await conv.prompt("改过的第二句", undefined, ids.u2);

  // u2 与它之后的 a2 离开当前路径，新内容接在原来的位置。
  assert.deepEqual(texts(manager), ["第一句", "第一答", "改过的第二句"]);
  const leaf = manager.getLeafEntry();
  assert.equal(leaf?.type, "message", "重发之后叶子应是新追加的用户消息");
  if (leaf?.type === "message") assert.equal(leaf.message.role, "user");
  // 旧路径没被删掉，只是不在当前路径上（可回退）。
  assert.ok(manager.getEntry(ids.a2), "被移出路径的记录仍在文件里");
});

test("原子替换并重发：正在生成时拒绝，且会话树原样不动", async () => {
  const cwd = tempDir("pi-edit-");
  const dir = join(cwd, "sessions");
  mkdirSync(dir);
  const { manager, ids } = transcript(dir, cwd);
  const { conv } = conversation(manager);
  (conv as unknown as { session: TreeSession }).session.isStreaming = true;

  await assert.rejects(
    () => conv.prompt("改过的第二句", undefined, ids.u2),
    (err: unknown) => err instanceof AppError && err.code === "conflict",
  );
  assert.deepEqual(texts(manager), ["第一句", "第一答", "第二句", "第二答"], "拒绝时不能动会话树");
});

test("原子替换并重发：只接受用户消息（助手消息走回退，不是编辑）", async () => {
  const cwd = tempDir("pi-edit-");
  const dir = join(cwd, "sessions");
  mkdirSync(dir);
  const { manager, ids } = transcript(dir, cwd);
  const { conv } = conversation(manager);

  await assert.rejects(() => conv.prompt("x", undefined, ids.a2), /只能编辑用户消息/);
  assert.deepEqual(texts(manager), ["第一句", "第一答", "第二句", "第二答"]);
});

test("对话上的回退会换掉模型看到的消息，正在生成时拒绝且不写标记", async () => {
  const cwd = tempDir("pi-edit-");
  const dir = join(cwd, "sessions");
  mkdirSync(dir);
  const { manager, ids } = transcript(dir, cwd);
  const { conv, frames } = conversation(manager);
  const session = (conv as unknown as { session: TreeSession }).session;
  // Conversation 把 session 存成私有字段，测试用同一引用来翻转流式状态。
  const live = session;
  live.isStreaming = true;
  const leaf = manager.getLeafId();
  // 回退现在是 async：流式闸门在 await 之前抛，会变成 rejected Promise 而非同步 throw。
  await assert.rejects(() => conv.rollbackTo(ids.a1), (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, "conflict");
    return true;
  });
  assert.equal(manager.getLeafId(), leaf);

  live.isStreaming = false;
  await conv.rollbackTo(ids.a1);
  assert.deepEqual(texts(manager), ["第一句", "第一答"]);
  const snapshots = frames.filter((frame) => frame.type === "snapshot");
  const last = snapshots[snapshots.length - 1];
  assert.ok(last && last.type === "snapshot");
  assert.deepEqual(last.state.messages.map((message) => message.text), ["第一句", "第一答"]);
  assert.ok(last.state.messages.every((message) => Boolean(message.entryId)));
});

test("回退 summarize:true 且 SDK 提供 navigateTree 时走官方树导航、不把指令吞掉", async () => {
  const cwd = tempDir("pi-edit-");
  const dir = join(cwd, "sessions");
  mkdirSync(dir);
  const { manager, ids } = transcript(dir, cwd);
  const { conv } = conversation(manager);
  const session = (conv as unknown as { session: TreeSession }).session;

  await conv.rollbackTo(ids.a1, { summarize: true, instructions: "保留结论" });

  assert.equal(session.navigateTreeCalls.length, 1, "应走 navigateTree 而不是 branch 回落");
  assert.equal(session.navigateTreeCalls[0]!.id, ids.a1);
  assert.deepEqual(session.navigateTreeCalls[0]!.options, {
    summarize: true,
    customInstructions: "保留结论",
  });
  assert.deepEqual(texts(manager), ["第一句", "第一答"]);
});

test("回退不带 summarize 时走 branch + 标记路径（不碰 navigateTree）", async () => {
  const cwd = tempDir("pi-edit-");
  const dir = join(cwd, "sessions");
  mkdirSync(dir);
  const { manager, ids } = transcript(dir, cwd);
  const { conv } = conversation(manager);
  const session = (conv as unknown as { session: TreeSession }).session;

  await conv.rollbackTo(ids.a1);

  assert.equal(session.navigateTreeCalls.length, 0, "没请求摘要就不应走 navigateTree");
  assert.deepEqual(texts(manager), ["第一句", "第一答"]);
});

test("官方标签：setLabel 写入会话文件、labels() 读回、空串即清除", () => {
  const cwd = tempDir("pi-edit-");
  const dir = join(cwd, "sessions");
  mkdirSync(dir);
  const { manager, ids } = transcript(dir, cwd);
  const { conv } = conversation(manager);

  conv.setLabel(ids.a1, "checkpoint");
  assert.deepEqual(conv.labels(), [{ entryId: ids.a1, label: "checkpoint" }]);
  // 标签落在会话文件里，重启后仍在。
  const file = manager.getSessionFile();
  assert.ok(file);
  assert.equal(SessionManager.open(file).getLabel(ids.a1), "checkpoint");

  conv.setLabel(ids.a1, ""); // 空串 = 清除
  assert.deepEqual(conv.labels(), []);
});

test("改名写进会话文件，占位标题不会在下一条消息时被盖掉", () => {
  const cwd = tempDir("pi-edit-");
  const dir = join(cwd, "sessions");
  mkdirSync(dir);
  const { manager } = transcript(dir, cwd);
  const file = manager.getSessionFile();
  assert.ok(file);
  const { conv } = conversation(manager);
  const session = (conv as unknown as { session: TreeSession }).session;
  assert.equal(conv.rename("New conversation"), "New conversation");
  session.emit({ type: "message_end" });
  assert.equal(conv.title, "New conversation");
  assert.equal(SessionManager.open(file).getSessionName(), "New conversation");
});

function workspace(): { cwd: string; dir: string; catalog: SessionCatalog } {
  const cwd = tempDir("pi-edit-hub-");
  const dir = join(cwd, "ours");
  mkdirSync(dir);
  return { cwd, dir, catalog: sessionCatalog(defaultSessionIndexFile(dir), [dir], cwd) };
}

test("没打开的对话可以改名，不能回退；分叉会打开新文件且源 id 还在", async () => {
  const { cwd, dir, catalog } = workspace();
  const { manager, ids } = transcript(dir, cwd);
  const file = manager.getSessionFile();
  const sourceId = manager.getSessionId();
  assert.ok(file);
  catalog.upsert({
    sessionId: sourceId,
    sessionFile: file,
    title: "原标题",
    updatedAt: 1,
    messageCount: 4,
  });
  const model = { provider: "test", id: "m", name: "M", contextWindow: 1000 } as Model<any>;
  const agent = {
    session: new TreeSession(SessionManager.create(cwd, dir), model),
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
        const opened = SessionManager.open(opts.resumeFrom, dir);
        const openedFile = opened.getSessionFile();
        if (!openedFile) throw new Error("no file");
        return new TreeSession(opened, model) as never;
      }
      return new TreeSession(SessionManager.create(cwd, dir), model) as never;
    },
    dispose: () => {},
  };
  const hub = new SessionHub(agent as never as BuiltAgent, resolveRuntimeConfig(), cwd, () => 6, 8, () => 0, [dir], catalog);
  await hub.attach("c1", () => {});

  await assert.rejects(() => hub.rollbackConversation("c1", sourceId, ids.a1), (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.match(err.message, /open_conversation/);
    return true;
  });

  assert.equal(hub.renameConversation("c1", sourceId, "改过的名字"), "改过的名字");
  assert.equal(catalog.get(sourceId)?.title, "改过的名字");
  const opened = await hub.openConversation("c1", sourceId);
  assert.equal(opened.title, "改过的名字");

  const forked = await hub.forkConversation("c1", sourceId, ids.a1);
  assert.notEqual(forked.id, sourceId);
  assert.equal(catalog.get(sourceId)?.sessionFile, file);
  assert.equal(SessionManager.open(file).getSessionId(), sourceId);
  assert.equal(catalog.get(forked.id)?.sessionId, forked.id);
  assert.match(forked.title, /分叉/);
  hub.dispose();
});
