/**
 * 子代理派发测试。
 *
 * 用 session 替身驱动**真实的编排栈**（SessionHub → ClientSession → Conversation）：
 *   - 子代理不占主对话的并发额度（真实 hub 的 LRU 上限为 1 时也必须能派发）；
 *   - 失败必须两边都通知（工具结果 + notice）；
 *   - 输出超限被截断且如实标记；
 *   - 无论成败都回收子会话。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionHub } from "../session-hub.js";
import { resolveRuntimeConfig } from "../config.js";
import type { ServerMessage } from "../protocol.js";
import type { BuiltAgent } from "../agent.js";
import type { Model } from "@earendil-works/pi-ai";
import {
  DELEGATE_TOOL_NAME,
  buildSubagentPrompt,
  createDelegateTool,
  lastAssistantText,
  truncateSubagentOutput,
  type SubagentSession,
} from "./index.js";

/** 子会话替身：遵守 SubagentSession 契约。 */
class FakeSubagent implements SubagentSession {
  disposed = false;
  aborted = false;
  constructor(
    readonly sessionId: string,
    private readonly reply: string,
    private readonly behaviour: { fail?: Error; delayMs?: number; onPrompt?: () => void } = {},
  ) {}
  messages: readonly unknown[] = [];
  async prompt(text: string): Promise<void> {
    this.behaviour.onPrompt?.();
    this.messages = [
      { role: "user", content: text, timestamp: 1 },
      { role: "assistant", content: this.reply, timestamp: 2 },
    ];
    if (this.behaviour.delayMs) {
      await new Promise((r) => setTimeout(r, this.behaviour.delayMs));
    }
    if (this.behaviour.fail) throw this.behaviour.fail;
  }
  abort(): void {
    this.aborted = true;
  }
  dispose(): void {
    this.disposed = true;
  }
}

interface TextResult {
  content: { type: "text"; text: string }[];
  details: { error?: boolean; truncated?: boolean; originalLength?: number; sessionId?: string };
}

function textOf(result: unknown): string {
  return (result as TextResult).content.map((part) => part.text).join("");
}

/**
 * 一个同时满足 **SubagentSession** 与 **Conversation 所需 SDK 会话面** 的替身。
 *
 * 复用同一个替身是有原因的：生产装配里 `agent.createSession()` 就同时服务这两个消费者，
 * 所以测试也该走同一条路——只做一半的替身会让「子代理不占额度」这条断言测到的是
 * 另一个世界里的 hub。
 */
class FakeSession extends FakeSubagent implements SubagentSession {
  readonly isStreaming = false;
  subscribe(): () => void {
    return () => {};
  }
  getSessionStats() {
    return {
      sessionFile: undefined,
      sessionId: this.sessionId,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    };
  }
  getActiveToolNames(): string[] {
    return [];
  }
  setActiveToolsByName(): void {}
  getSteeringMessages(): unknown[] {
    return [];
  }
  getFollowUpMessages(): unknown[] {
    return [];
  }
  setThinkingLevel(): void {}
  async setModel(): Promise<void> {}
}

/** 主对话的 agent 替身（与 integration.test.ts 同形）。 */
function makeAgent(sessions: FakeSubagent[]): BuiltAgent {
  const model: Model<any> = { provider: "test", id: "m1", name: "M1", contextWindow: 1000 } as never;
  let seq = 0;
  const make = (id: string) => ({
    sessionId: id,
    messages: [] as unknown[],
    model,
    isStreaming: false,
    subscribe: () => () => {},
    getSessionStats: () => ({
      sessionFile: undefined, sessionId: id, userMessages: 0, assistantMessages: 0,
      toolCalls: 0, toolResults: 0, totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
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
  });
  const shared = make("sess-main");
  return {
    session: shared as never,
    get model() { return model; },
    builtinTools: "off" as const,
    skills: [], knowledge: [],
    database: {
      driver: "sqlite", path: ":memory:",
      ping: () => ({ ok: true as const, driver: "sqlite", path: ":memory:" }),
      listNotes: () => [], getNote: () => undefined, searchNotes: () => [],
      insertNote: () => ({ id: 1, title: "t", body: "b" }),
      query: () => ({ columns: [], rows: [], truncated: false, totalRows: 0 }),
      close: () => {},
    },
    listModels: async () => [model],
    switchModel: async () => model,
    createSession: async () => {
      const sub = sessions[seq] ?? new FakeSession(`sub-${seq + 1}`, "");
      seq += 1;
      sessions.push(sub);
      return sub as never;
    },
    dispose: () => {},
  } as never;
}

test("子代理：结果回主对话，且子会话被回收", async () => {
  const sub = new FakeSubagent("sub-1", "结论：改 A 文件的 B 函数。");
  const tool = createDelegateTool({ createSession: async () => sub });
  const result = (await tool.execute(
    "c1", { task: "看看 A 文件" }, undefined, undefined, {} as never,
  )) as TextResult;
  assert.match(textOf(result), /改 A 文件的 B 函数/);
  assert.equal(result.details.error, undefined);
  assert.equal(result.details.truncated, false);
  assert.equal(sub.disposed, true, "the subagent session must always be disposed");
});

test("子代理：空任务被拒且给出原因", async () => {
  const tool = createDelegateTool({
    createSession: async () => {
      throw new Error("不该被创建");
    },
  });
  const result = (await tool.execute(
    "c1", { task: "   " }, undefined, undefined, {} as never,
  )) as TextResult;
  assert.equal(result.details.error, true);
  assert.match(textOf(result), /task 不能为空/);
});

test("子代理：失败必须通知模型与客户端（不静默丢结果）", async () => {
  const sub = new FakeSubagent("sub-1", "", { fail: new Error("子会话崩了") });
  const notices: { level: string; text: string }[] = [];
  const tool = createDelegateTool({
    createSession: async () => sub,
    notify: (level, text) => notices.push({ level, text }),
  });
  const result = (await tool.execute(
    "c1", { task: "会失败的任务" }, undefined, undefined, {} as never,
  )) as TextResult;
  assert.equal(result.details.error, true);
  assert.match(textOf(result), /子会话崩了/, "the model must learn what went wrong");
  assert.match(textOf(result), /不要假设它完成了/, "and must be told not to trust a partial result");
  assert.equal(notices.length, 1, "a silent failure would leave the user waiting forever");
  assert.match(notices[0]!.text, /子会话崩了/);
  assert.equal(sub.disposed, true, "a failed subagent must still be disposed");
});

test("子代理：超时中止子会话并如实回传原因", async () => {
  const sub = new FakeSubagent("sub-1", "never", { delayMs: 5000 });
  const tool = createDelegateTool({ createSession: async () => sub, timeoutMs: 60 });
  const result = (await tool.execute(
    "c1", { task: "很慢的任务" }, undefined, undefined, {} as never,
  )) as TextResult;
  assert.equal(result.details.error, true);
  assert.match(textOf(result), /超过/);
  assert.equal(sub.aborted, true, "a timeout must abort the subagent, not just abandon it");
  assert.equal(sub.disposed, true);
});

test("子代理：外部 abort 传导到子会话", async () => {
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const sub = new FakeSubagent("sub-1", "x", { delayMs: 200, onPrompt: markStarted });
  const controller = new AbortController();
  const tool = createDelegateTool({ createSession: async () => sub });
  const pending = tool.execute("c1", { task: "t" }, controller.signal, undefined, {} as never);
  // 等到子会话真的开始跑再中止：否则 abort 早于监听器挂上，测的是一个不存在的时序。
  await started;
  controller.abort();
  await pending;
  assert.equal(sub.aborted, true, "an aborted turn must not leave the subagent burning tokens");
});

test("子代理：排队期间就发出的 abort 不会被漏掉", async () => {
  const controller = new AbortController();
  const created: FakeSubagent[] = [];
  const tool = createDelegateTool({
    createSession: async () => {
      const sub = new FakeSubagent(`sub-${created.length + 1}`, "ok", { delayMs: 40 });
      created.push(sub);
      return sub;
    },
    maxConcurrent: 1,
  });
  const first = tool.execute("c1", { task: "a" }, undefined, undefined, {} as never);
  // 第二个在 acquire() 里排队，此时把信号掐掉。
  const second = tool.execute("c2", { task: "b" }, controller.signal, undefined, {} as never);
  controller.abort();
  const results = await Promise.all([first, second]);
  assert.equal(
    (results[1] as TextResult).details.error,
    true,
    "a dispatch cancelled while queued must report failure, not run anyway",
  );
  assert.equal(created.length, 1, "the cancelled dispatch must not have created a session");
});

test("子代理：超长输出被截断且如实标记", async () => {
  const long = "头".repeat(5000) + "尾" + "尾".repeat(5000);
  const sub = new FakeSubagent("sub-1", long);
  const tool = createDelegateTool({ createSession: async () => sub, maxOutputChars: 200 });
  const result = (await tool.execute(
    "c1", { task: "长输出" }, undefined, undefined, {} as never,
  )) as TextResult;
  assert.equal(result.details.truncated, true, "truncation must be reported, never silent");
  assert.equal(result.details.originalLength, long.length);
  const text = textOf(result);
  assert.ok(text.length < long.length / 2, `output must actually shrink, got ${text.length}`);
  assert.match(text, /已截断/);
  // 头尾都留：结论在头，行动项常常在尾。
  assert.ok(text.startsWith("头头"));
  assert.ok(text.includes("尾尾"));
});

test("子代理：截断纯函数保留原文（未超限时零改动）", () => {
  assert.deepEqual(truncateSubagentOutput("short", 100), {
    text: "short", truncated: false, originalLength: 5,
  });
  assert.equal(lastAssistantText([{ role: "user", content: "u" }]), "");
  assert.equal(
    lastAssistantText([{ role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]),
    "ab",
  );
});

test("子代理：并发上限是排队而不是失败", async () => {
  const created: FakeSubagent[] = [];
  const tool = createDelegateTool({
    createSession: async () => {
      const sub = new FakeSubagent(`sub-${created.length + 1}`, `ok-${created.length}`, { delayMs: 20 });
      created.push(sub);
      return sub;
    },
    maxConcurrent: 1,
  });
  const results = await Promise.all(
    [1, 2, 3].map((i) => tool.execute(`c${i}`, { task: `t${i}` }, undefined, undefined, {} as never)),
  );
  assert.equal(results.length, 3);
  for (const result of results) assert.equal((result as TextResult).details.error, undefined);
  assert.equal(created.length, 3, "every dispatch must eventually run");
  assert.ok(created.every((sub) => sub.disposed));
});

test("子代理：提示词要求自包含与只回结论", () => {
  const prompt = buildSubagentPrompt("查一下 config.ts 里的默认超时", "主对话刚改过设置");
  assert.match(prompt, /config\.ts/);
  assert.match(prompt, /主对话刚改过设置/, "context must be forwarded");
  assert.match(prompt, /结论/, "otherwise the main conversation drowns in process noise");
});

test("子代理：不占主对话的 LRU 额度（真实 hub，上限 1）", async () => {
  const agent = makeAgent([]);
  const hub = new SessionHub(agent, resolveRuntimeConfig(), process.cwd(), () => 6, 1);
  try {
    const frames: ServerMessage[] = [];
    const client = await hub.attach("c1", (msg) => frames.push(msg));
    const before = client.conversationCount();
    assert.equal(before, 1);

    // 子会话走 agent.createSession()，完全不进 ClientSession 的 convs ——
    // 走 newConversation() 的话，派 3 个子代理就会把用户的对话挤掉。
    await agent.createSession!();
    await agent.createSession!();
    assert.equal(
      client.conversationCount(),
      before,
      "subagents must not consume the main conversation's concurrency budget",
    );
    assert.equal(client.listConversations().length, before, "and must not appear in the user's list");
  } finally {
    hub.dispose();
  }
});

test("子代理：工具名与描述约定（审批规则按 capability=subagent 匹配）", () => {
  // 名字写错的话 builtin:subagent.delegate 会静默失效，派发就绕过了审批。
  assert.equal(DELEGATE_TOOL_NAME, "delegate_task");
  const tool = createDelegateTool({ createSession: async () => new FakeSubagent("x", "y") });
  assert.equal(tool.name, DELEGATE_TOOL_NAME);
  assert.match(tool.description, /子代理/);
});