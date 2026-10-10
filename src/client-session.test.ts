/**
 * 连接级对话上限：并发开新对话时，同时在册的 AgentSession 数不得超过 `maxOpenConversations`。
 *
 * 每个 `Conversation` 都持有一个完整 AgentSession（loader + 工具表 + 事件订阅），所以
 * 「上限」不是统计口径问题，而是资源问题。这里不复用 `sessions/resume.test.ts` 的 SDK
 * 目录夹具：本文件测的是**容量与生命周期**，与磁盘会话无关，直接用最小替身把分配次数、
 * 同时在册数、dispose 次数记下来即可。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { BuiltAgent } from "./agent.js";
import { ClientSession } from "./client-session.js";
import { resolveRuntimeConfig } from "./config.js";

/** 记录分配 / 存活 / 释放的会话替身，形状对齐 `Conversation` 消费到的那部分 SDK Session。 */
class TrackingSession {
  readonly sessionId: string;
  readonly sessionFile = undefined;
  messages: unknown[] = [];
  model = { provider: "test", id: "m1", name: "M1", contextWindow: 1000 };
  thinkingLevel = "default";
  isStreaming = false;
  disposed = false;

  constructor(id: string, private readonly registry: SessionRegistry) {
    this.sessionId = id;
    registry.alive.add(this);
    registry.peakAlive = Math.max(registry.peakAlive, registry.alive.size);
  }

  subscribe(): () => void {
    return () => {};
  }
  getSessionStats() {
    return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
  }
  getActiveToolNames(): string[] {
    return [];
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
  async setModel(): Promise<void> {}
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  dispose(): void {
    this.disposed = true;
    this.registry.alive.delete(this);
    this.registry.disposed.push(this.sessionId);
  }
}

class SessionRegistry {
  readonly alive = new Set<TrackingSession>();
  readonly disposed: string[] = [];
  /** 工厂被调用了几次（= 一共分配出几个 AgentSession）。 */
  factoryCalls = 0;
  /** 同时存活的 AgentSession 峰值。 */
  peakAlive = 0;
  /** 每次分配完成后停留多久，用来拉长 `await` 窗口。 */
  delayMs = 0;
  private seq = 0;

  /**
   * 造一个注入 `ClientSession` 的 BuiltAgent；工厂返回的 id 是 `s1`、`s2`、……。
   *
   * `agent.session`（无工厂时的共享会话）**不进 registry**：它不属于「按对话分配」的那批，
   * `Conversation` 也只在没有独立工厂时才用它。把它计入峰值会让上限断言永远差一。
   */
  agent(failOn?: number): BuiltAgent {
    const registry = this;
    return {
      session: new (class {
        sessionId = "shared";
        messages: unknown[] = [];
        model = { provider: "test", id: "m1", name: "M1", contextWindow: 1000 };
        thinkingLevel = "default";
        isStreaming = false;
        subscribe(): () => void {
          return () => {};
        }
        getSessionStats() {
          return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
        }
        getActiveToolNames(): string[] {
          return [];
        }
        setActiveToolsByName(): void {}
        getSteeringMessages(): readonly string[] {
          return [];
        }
        getFollowUpMessages(): readonly string[] {
          return [];
        }
        setThinkingLevel(): void {}
        async setModel(): Promise<void> {}
        async prompt(): Promise<void> {}
        async abort(): Promise<void> {}
        dispose(): void {}
      })(),
      model: { provider: "test", id: "m1", name: "M1", contextWindow: 1000 },
      builtinTools: "off",
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
      listModels: async () => [],
      switchModel: async () => {
        throw new Error("not used");
      },
      createSession: async () => {
        registry.factoryCalls += 1;
        const index = (registry.seq += 1);
        if (registry.delayMs > 0) await delay(registry.delayMs);
        if (index === failOn) throw new Error("factory failed");
        return new TrackingSession(`s${index}`, registry) as never;
      },
      dispose: () => {},
    } as never;
  }
}

function client(registry: SessionRegistry, cap: number, failOn?: number): ClientSession {
  return new ClientSession({
    clientId: "c1",
    agent: registry.agent(failOn),
    cfg: resolveRuntimeConfig(),
    cwd: process.cwd(),
    push: () => {},
    maxOpenConversations: cap,
  });
}

test("并发开对话：同时在册的 AgentSession 不超过上限", async () => {
  const registry = new SessionRegistry();
  registry.delayMs = 5;
  const session = client(registry, 4);

  await Promise.all(Array.from({ length: 8 }, () => session.newConversation()));

  assert.ok(
    registry.peakAlive <= 4,
    `同时存活的 AgentSession 峰值为 ${registry.peakAlive}，超过上限 4`,
  );
  assert.equal(session.conversationCount(), 4, "在册对话数必须停在上限");
  assert.equal(registry.alive.size, 4, "上限之外不应有游离的 AgentSession");
});

test("并发开对话：慢工厂最后返回时同样不超过上限", async () => {
  // 逆序返回是真实的 IO 形态（先发起的请求最后完成）。这条覆盖的是「靠分配完再补收
  // 一次」那套写法会漏掉的时序：补收时新会话还没入册，收不到它自己。
  const registry = new SessionRegistry();
  const session = client(registry, 3);
  const staggered = [9, 7, 5, 3, 1, 1];
  await Promise.all(
    staggered.map((ms) => delay(ms).then(() => session.newConversation())),
  );

  assert.ok(registry.peakAlive <= 3, `峰值 ${registry.peakAlive} 超过上限 3`);
  assert.equal(session.conversationCount(), 3);
});

test("上限为 2 时并发也不突破", async () => {
  const registry = new SessionRegistry();
  registry.delayMs = 2;
  const session = client(registry, 2);

  await Promise.all(Array.from({ length: 6 }, () => session.newConversation()));

  assert.ok(registry.peakAlive <= 2, `峰值 ${registry.peakAlive} 超过上限 2`);
  assert.equal(session.conversationCount(), 2);
});

test("串行开对话：超出上限的会被淘汰并释放", async () => {
  const registry = new SessionRegistry();
  const session = client(registry, 3);

  for (let i = 0; i < 6; i += 1) await session.newConversation();

  assert.equal(session.conversationCount(), 3);
  assert.equal(registry.alive.size, 3, "被淘汰的对话必须真的释放掉");
  assert.deepEqual(registry.disposed, ["s1", "s2", "s3"], "淘汰的是最久未活动的三条");
});

test("分配失败：不占名额，也不留下游离会话", async () => {
  const registry = new SessionRegistry();
  registry.delayMs = 2;
  // 第 3 次分配失败。
  const session = client(registry, 4, 3);

  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => session.newConversation()),
  );

  assert.equal(results.filter((r) => r.status === "rejected").length, 1, "恰好一次失败");
  assert.ok(registry.peakAlive <= 4, `峰值 ${registry.peakAlive} 超过上限 4`);
  assert.equal(session.conversationCount(), 4, "在册对话数仍停在上限");
  assert.equal(registry.alive.size, 4, "上限之外没有游离会话");
  assert.equal(registry.factoryCalls, 6, "失败的分配不能被静默重试掉");
});

test("入册阶段抛错：刚分配的 AgentSession 会被释放", async () => {
  // 工厂已经返回了 session，但包装/快照阶段失败——这个 session 必须有人回收，
  // 否则它就是没人持有、也没人释放的孤儿。
  const registry = new SessionRegistry();
  const agent = registry.agent();
  agent.createSession = (async () => {
    registry.factoryCalls += 1;
    const session = new TrackingSession("s-bad", registry);
    // 让入册阶段的 `getState()` 抛错。
    session.getSessionStats = () => {
      throw new Error("snapshot failed");
    };
    return session as never;
  }) as typeof agent.createSession;
  const session = new ClientSession({
    clientId: "c1",
    agent,
    cfg: resolveRuntimeConfig(),
    cwd: process.cwd(),
    push: () => {},
    maxOpenConversations: 4,
  });

  await assert.rejects(() => session.newConversation(), /snapshot failed/);
  assert.equal(registry.alive.size, 0, "孤儿 AgentSession 必须被释放");
  assert.deepEqual(registry.disposed, ["s-bad"]);
});

test("dispose 时唤醒还在等名额的请求，不留永久挂起的 Promise", async () => {
  // 名额被占满、后续请求排队时若直接拆掉连接，排队的那些必须被唤醒并结算 ——
  // 否则它们挂在一个再也不会被兑现的 Promise 上。
  const registry = new SessionRegistry();
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const agent = registry.agent();
  agent.createSession = (async () => {
    registry.factoryCalls += 1;
    await gate;
    return new TrackingSession(`s${registry.factoryCalls}`, registry) as never;
  }) as typeof agent.createSession;
  const session = new ClientSession({
    clientId: "c1",
    agent,
    cfg: resolveRuntimeConfig(),
    cwd: process.cwd(),
    push: () => {},
    maxOpenConversations: 2,
  });

  const occupying = [session.newConversation(), session.newConversation()];
  await delay(5);
  const queued = session.newConversation();
  await delay(5);
  session.dispose();
  openGate();

  const settled = await Promise.race([
    Promise.allSettled([...occupying, queued]).then(() => "settled"),
    delay(500).then(() => "pending"),
  ]);
  assert.equal(settled, "settled", "dispose 后排队请求仍在挂起");
});
