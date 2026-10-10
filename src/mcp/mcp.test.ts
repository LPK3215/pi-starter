/**
 * MCP 桥测试。
 *
 * 起的是**真的子进程**（`process.execPath` + 一个临时脚本），不是 mock：
 * 行缓冲、握手顺序、进程退出时把在途请求拒掉——这三处正是 mock 最容易放过、
 * 而线上一定会炸的地方。整条链路不碰网络。
 *
 * 反向验证过的缺陷：
 *   - 把 `unregisterWhere` 换成空实现 → 「服务器下线后工具仍留在目录里」用例会红；
 *   - 把子进程退出时的 `failAllPending` 去掉 → 「崩溃后调用方永久挂起」用例会红（超时）。
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { McpBridge } from "./bridge.js";
import { McpClient } from "./client.js";
import { createToolRegistry } from "../tools/registry.js";
import type { McpServerConfig } from "../settings.js";
import { waitFor } from "../test-server.js";
import { tempDir } from "../test-tmp.js";

/** 一个最小但**真实**的 MCP stdio 服务器。 */
const SERVER_SOURCE = `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

function handle(msg) {
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake", version: "1.0.0" },
    });
    return;
  }
  if (msg.method === "tools/list") {
    reply(msg.id, {
      tools: [
        {
          name: "echo",
          description: "回显传入的文本",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string", description: "要回显的文本" }, times: { type: "integer" } },
            required: ["text"],
          },
        },
        { name: "boom", description: "立刻让服务器进程退出", inputSchema: { type: "object", properties: {} } },
      ],
    });
    return;
  }
  if (msg.method === "tools/call") {
    if (msg.params.name === "boom") { process.exit(3); }
    if (msg.params.name === "echo") {
      const args = msg.params.arguments || {};
      reply(msg.id, {
        content: [{ type: "text", text: "echo:" + args.text + " x" + (args.times || 1) }],
        isError: false,
      });
      return;
    }
    reply(msg.id, { content: [{ type: "text", text: "unknown tool" }], isError: true });
    return;
  }
  // notifications/* 无需应答
}
`;

function writeServerScript(): string {
  const dir = tempDir("pi-mcp-");
  const file = join(dir, "server.mjs");
  writeFileSync(file, SERVER_SOURCE, "utf8");
  return file;
}

const script = writeServerScript();

function serverConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name: "demo", command: process.execPath, args: [script], ...overrides };
}

test("MCP：stdio 客户端完成握手、取工具、调用工具", async () => {
  const client = new McpClient({ command: process.execPath, args: [script], requestTimeoutMs: 10_000 });
  await client.start();
  try {
    assert.equal(client.isReady, true);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["boom", "echo"],
      "tools/list must return the server's tools",
    );
    const echo = tools.find((tool) => tool.name === "echo")!;
    assert.equal(echo.inputSchema?.type, "object", "inputSchema must be preserved for the tool definition");

    const result = await client.callTool("echo", { text: "hi", times: 2 });
    assert.equal(result.text, "echo:hi x2");
    assert.equal(result.isError, false);
  } finally {
    client.dispose();
  }
});

test("MCP：子进程崩溃时在途请求失败，而不是永久挂起", async () => {
  const client = new McpClient({ command: process.execPath, args: [script], requestTimeoutMs: 200 });
  await client.start();
  const started = Date.now();
  // boom 让服务器直接退出：不 fail 挂起的 promise 的话，这里只能等超时才知道，
  // 而线上表现为「工具卡住」而不是「工具不可用」。
  await assert.rejects(() => client.callTool("boom", {}));
  assert.ok(
    Date.now() - started < 200,
    `in-flight calls must fail as soon as the server dies, took ${Date.now() - started}ms`,
  );
  assert.equal(client.isReady, false);
  assert.match(String(client.failure), /exited/);
  client.dispose();
});

test("MCP 桥：工具进注册表并带dynamic 来源与 mcp 能力标签", async () => {
  const registry = createToolRegistry();
  const bridge = new McpBridge({ servers: () => [serverConfig()], registry });
  try {
    const status = await bridge.sync();
    assert.equal(status.length, 1);
    assert.equal(status[0]?.ready, true, `sync failed: ${status[0]?.error ?? ""}`);

    const catalog = registry.catalog();
    const names = catalog.map((tool) => tool.name);
    assert.ok(names.includes("mcp__demo__echo"), `expected namespaced tool, got ${names.join(",")}`);
    assert.ok(names.includes("mcp__demo__boom"));
    const echo = catalog.find((tool) => tool.name === "mcp__demo__echo")!;
    assert.equal(echo.source, "dynamic");
    assert.ok(echo.capabilities.includes("mcp"));

    // 工具定义真的可调用（不是只登记了个名字）。
    const definitions = bridge.toolDefinitions();
    assert.equal(definitions.length, 2);
    const echoDef = definitions.find((tool) => tool.name === "mcp__demo__echo")!;
    const output = await echoDef.execute("call-1", { text: "hello" }, undefined, undefined, {} as never);
    const text = output.content.map((part) => (part as { text?: string }).text ?? "").join("");
    assert.equal(text, "echo:hello x1");
  } finally {
    bridge.dispose();
  }
});

test("MCP 桥：改配置即生效（新增 / 移除），且移除会把工具摘干净", async () => {
  const registry = createToolRegistry();
  let servers: McpServerConfig[] = [];
  const bridge = new McpBridge({ servers: () => servers, registry });
  try {
    await bridge.sync();
    assert.equal(registry.catalog().length, 0, "no servers configured → no tools");

    servers = [serverConfig()];
    await bridge.sync();
    assert.ok(registry.has("mcp__demo__echo"), "adding a server must publish its tools without a restart");

    // 同名服务器换一个（命令变了）→ 必须重连，工具不能是上一台的残留。
    servers = [serverConfig({ args: [script] })];
    await bridge.sync();
    assert.ok(registry.has("mcp__demo__echo"));

    servers = [];
    await bridge.sync();
    assert.equal(
      registry.catalog().filter((tool) => tool.name.startsWith("mcp__")).length,
      0,
      "removing a server must unregister its tools; a stale entry would invite calls that always fail",
    );
    assert.equal(bridge.status().length, 0);
  } finally {
    bridge.dispose();
  }
});

test("MCP 桥：一个服务器接不上不影响其它服务器", async () => {
  const registry = createToolRegistry();
  const bridge = new McpBridge({
    servers: () => [
      { name: "broken", command: "definitely-not-a-real-binary-xyz", args: [] },
      serverConfig(),
    ],
    registry,
  });
  try {
    await bridge.sync();
    const status = bridge.status();
    const broken = status.find((item) => item.name === "broken");
    const demo = status.find((item) => item.name === "demo");
    assert.equal(broken?.ready, false, "the broken server must be reported as failed");
    assert.ok(broken?.error, "a failure must carry a reason");
    assert.equal(demo?.ready, true, "a healthy server must still connect");
    assert.ok(registry.has("mcp__demo__echo"));
  } finally {
    bridge.dispose();
  }
});

test("MCP 桥：dispose 回收子进程，不留残留在途请求", async () => {
  const registry = createToolRegistry();
  const bridge = new McpBridge({ servers: () => [serverConfig()], registry });
  await bridge.sync();
  assert.equal(registry.has("mcp__demo__echo"), true);

  bridge.dispose();
  assert.equal(registry.has("mcp__demo__echo"), false, "dispose must also drop the tools it published");
  assert.equal(bridge.toolDefinitions().length, 0);
  // Idempotent: shutdown paths may run twice (signal + explicit dispose).
  bridge.dispose();
});

test("MCP 桥：并发 sync 只跑一轮，不会重复拉起子进程", async () => {
  const registry = createToolRegistry();
  let syncs = 0;
  const bridge = new McpBridge({
    servers: () => {
      syncs += 1;
      return [serverConfig()];
    },
    registry,
  });
  try {
    const [a, b] = await Promise.all([bridge.sync(), bridge.sync()]);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    await waitFor(() => registry.has("mcp__demo__echo"), "mcp tool registered");
    // 工具只登记一次：重复拉起子进程会让远端看到两份 server。
    assert.equal(registry.catalog().filter((tool) => tool.name === "mcp__demo__echo").length, 1);
  } finally {
    bridge.dispose();
  }
});

test("MCP：握手中途停机就收尸，不再拉起子进程", async () => {
  const client = new McpClient({ command: process.execPath, args: [script], requestTimeoutMs: 10_000 });
  client.dispose();
  // 已停机的客户端再 start() 会 spawn 出一个 dispose 已经扫不到的孤儿进程。
  await assert.rejects(() => client.start(), /已停机/);
  assert.equal(client.isReady, false);
});

test("MCP 桥：握手中途收到 dispose，既不注册工具也不留残连接", async () => {
  const registry = createToolRegistry();
  const bridge = new McpBridge({ servers: () => [serverConfig()], registry });
  const inFlight = bridge.sync();
  // 握手最长 15s：此时子进程还没进 `connected`，dispose() 扫不到它——旧实现会在握手完成后
  // 把已停机的桥的 connected 填回去、并把工具重新注册进注册表（工具"复活"）。
  bridge.dispose();
  await inFlight.catch(() => {});
  assert.equal(
    registry.catalog().filter((tool) => tool.name.startsWith("mcp__")).length,
    0,
    "停机后不能再把工具注册进注册表",
  );
  assert.equal(bridge.toolDefinitions().length, 0);
  assert.equal(bridge.status().length, 0);
  bridge.dispose(); // 幂等
});

test("MCP 桥：sync 在途期间的配置变更会被补跑（改配置即生效）", async () => {
  const registry = createToolRegistry();
  let servers: McpServerConfig[] = [serverConfig()];
  const bridge = new McpBridge({ servers: () => servers, registry });
  try {
    const first = bridge.sync(); // 第一轮：读到的配置是 [demo]，握手需要时间
    // 握手还没结束就把配置清空：旧实现会把这次调用直接并给在途那一轮（返回同一 promise），
    // 于是这次变更被丢掉——demo 会一直连着，直到下一次配置变更才消失。
    servers = [];
    const second = bridge.sync();
    await Promise.all([first, second]);
    assert.equal(
      registry.catalog().filter((tool) => tool.name.startsWith("mcp__")).length,
      0,
      "在途期间清空配置必须生效，否则工具会残留到下一次变更",
    );
    assert.equal(bridge.status().length, 0);
  } finally {
    bridge.dispose();
  }
});