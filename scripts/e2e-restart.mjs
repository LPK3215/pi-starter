/**
 * 真端到端：起真实进程 → 跑一次真实对话 → **杀掉进程** → 重启 → 验证会话恢复。
 *
 * 为什么不用同进程替身：`resume.test.ts` 只在同进程里重新读一遍索引，**从没真的重启过**。
 * 而「会话能不能跨进程恢复」恰恰是脚手架最容易在升级 SDK 时悄悄坏掉的地方——
 * 落盘时机、SessionManager 的会话目录推导、索引与 jsonl 的对应关系，任何一处变了，
 * 同进程测试都发现不了（同一个模块实例还在内存里）。
 *
 * 不用真实 API Key的办法：把 Pi 的agent 目录指向临时目录，在里面写一份
 * `models.json`，把 provider 指到一个**本地假OpenAI 兼容端点**。启动期不联网探测，
 * `auth.json` 的 key 也纯本地解析，所以整条链路自洽。
 *
 * 跑法：npm run e2e   （内联执行，不落盘；用完即退）
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, skipped: false, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
/**
 * 显式跳过。**不要用「条件不成立就 return」冒充通过**——那看着全绿、实际没跑，
 * 比没有测试更危险（本仓库的符号链接用例就栽在这上面）。跳过必须被打印出来并被统计。
 */
function skip(name, reason) {
  results.push({ name, ok: true, skipped: true, detail: reason });
  console.log(`SKIP  ${name} — ${reason}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 递归收集指定后缀的文件（跳过 node_modules 之类的大目录）。 */
function findFiles(dir, suffix, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) findFiles(full, suffix, out, depth + 1);
    else if (e.name.endsWith(suffix)) out.push(full);
  }
  return out;
}
/** 轮询直到条件成立，避免固定 sleep 造成的偶发红灯。 */
async function waitFor(label, fn, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(120);
  }
  throw new Error(`超时等待：${label}${lastErr ? `\n最近一次错误：${lastErr.message}` : ""}`);
}

const cleanup = [];
process.on("exit", () => { for (const fn of cleanup.reverse()) { try { fn(); } catch { /* ignore */ } } });

/* ── 1. 假 LLM：OpenAI 兼容的 /chat/completions，只回文本，走 SSE ── */
/**
 * 工具调用模式开关。
 *
 * 默认关闭——前面所有段落都依赖「回文本」。打开后，第一次请求（还没有 tool 结果）
 * 回一个 `ls` 工具调用，收到工具结果后的第二次请求回文本。**只在最后一段打开**，
 * 否则会把前面每一段的断言都打乱。
 */
let llmToolMode = false;
const seenRequests = [];
const llm = createServer((req, res) => {
  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    seenRequests.push(parsed);
    // 必须第一块就 200：SDK 侧有重试包装，制造 5xx 会拖慢甚至放大失败。
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // 请求里是否已经带了工具结果（OpenAI 协议用 role: "tool"）。
    const hasToolResult =
      Array.isArray(parsed.messages) && parsed.messages.some((m) => m && m.role === "tool");
    if (llmToolMode && !hasToolResult) {
      send({
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "call_e2e_ls",
              type: "function",
              function: { name: "ls", arguments: JSON.stringify({ path: "." }) },
            }],
          },
          finish_reason: null,
        }],
      });
      send({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const text = "已收到：E2E 假回复";
    // 分两段吐字，让客户端的增量路径也跑到
    send({ choices: [{ index: 0, delta: { role: "assistant", content: text.slice(0, 5) }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: { content: text.slice(5) }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => llm.listen(0, "127.0.0.1", r));
const llmPort = llm.address().port;
cleanup.push(() => llm.close());
console.log(`假 LLM 端点： http://127.0.0.1:${llmPort}/v1\n`);

/* ── 2. 隔离的 Pi agent 目录 + 指向假端点的 models.json ── */
const agentDir = mkdtempSync(join(tmpdir(), "pi-e2e-agent-"));
const workspace = mkdtempSync(join(tmpdir(), "pi-e2e-ws-"));
cleanup.push(() => rmSync(agentDir, { recursive: true, force: true }));
cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));

writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      e2e: {
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
        api: "openai-completions",
        models: [{ id: "fake-model", name: "E2E Fake" }],
      },
    },
  }),
  "utf8",
);
writeFileSync(
  join(agentDir, "auth.json"),
  JSON.stringify({ e2e: { type: "api_key", key: "sk-e2e-fake" } }),
  "utf8",
);
// 内置示例内容是**设置项**（不是环境变量），关掉它才能让 E2E 的知识库/技能清单是确定的。
// 顺带验证了「设置落盘后真的生效」——这条路径与 agentDir 同处，不会读到用户真实配置。
writeFileSync(
  join(agentDir, "pi-starter-settings.json"),
  JSON.stringify({ builtinKnowledge: false, builtinSkills: false, toolApprovalEnabled: false }, null, 2),
  "utf8",
);

/* ── 3. 拉起真实 server 进程 ── */
// 端口用 `--port 0` 让 OS 分配，再从启动日志里读**实际**绑定的端口。
//
// 旧做法是「先探一个空闲端口、关掉、再把它传给子进程」——探测与子进程真正 listen 之间
// 存在窗口，CI 并行时会被别的进程抢走，表现为偶发 EADDRINUSE（本轮就撞到过一次）。
// 让内核自己分配则没有这个窗口。server.ts 为此改成打印实际端口而非请求值。
function startServer(tag, extraEnv = {}) {
  const child = spawn(
    process.execPath,
    [join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), join(REPO, "src", "server.ts"),
     "--provider", "e2e", "--model", "fake-model", "--port", "0"],
    {
      cwd: workspace,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_HOST: "127.0.0.1",
        PI_APPROVAL_MODE: "off",
        // 明确关掉示例内容，避免子目录被算进知识库/技能清单影响断言
        PI_BUILTIN_KNOWLEDGE: "off",
        PI_BUILTIN_SKILLS: "off",
        // 默认 off；需要工具调用的段落自己传（内置默认是 "off"）。
        PI_BUILTIN_TOOLS: "off",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const log = [];
  child.stdout.on("data", (d) => log.push(d.toString()));
  child.stderr.on("data", (d) => log.push(d.toString()));
  child.on("exit", (code) => log.push(`\n[${tag}] 退出码=${code}\n`));
  cleanup.push(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } });
  return { child, log };
}

/** 当前活跃进程的实际端口，由 waitReady 填好后再给 connect / fetch 用。 */
let PORT = null;

async function waitReady(tag, log) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const text = log.join("");
    // server.ts 启动完成的标志是打出 ws 地址（"已启动" 那行），里面是**实际**端口
    const m = text.match(/"ws":"ws:\/\/[^:"]+:(\d+)/);
    if (m) {
      PORT = Number(m[1]);
      return PORT;
    }
    if (/Error|error:|ELIFECYCLE/.test(text)) {
      throw new Error(`[${tag}] 启动失败：\n${text}`);
    }
    await sleep(200);
  }
  throw new Error(`[${tag}] 90s 内未监听：\n${log.join("")}`);
}

function connect() {
  const frames = [];
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: `http://127.0.0.1:${PORT}` });
  socket.on("message", (d) => frames.push(JSON.parse(d.toString("utf8"))));
  socket.on("error", () => {});
  return { frames, socket };
}

/**
 * 当前进程加载了哪些知识库/技能。
 *
 * `agent.knowledge` / `agent.skills` 就是写进系统提示词的那两份清单，`/capabilities`
 * 直接暴露它们。**不要再用正则去日志里捞** `"knowledge":["about"]`——那耦合的是日志
 * 排版，日志格式一改断言就假红，而它检验的其实是启动行为。
 */
async function loadCatalogs() {
  const res = await fetch(`http://127.0.0.1:${PORT}/capabilities`);
  const body = await res.json();
  return {
    knowledge: (body.knowledge ?? []).map((k) => k.name),
    skills: (body.skills ?? []).map((s) => s.name),
  };
}
const waitFrame = (frames, type, label) =>
  waitFor(`${label} 收到 ${type}`, () => frames.find((f) => f.type === type), 60_000);

/** 断言失败时把最后一帧快照的结构打出来——比"超时"三个字有用得多。 */
function describeLastSnapshot(frames) {
  const snap = frames.filter((f) => f.type === "snapshot").pop();
  if (!snap) return "（从未收到 snapshot）";
  const s = snap.state ?? {};
  return [
    `消息数=${s.messages?.length ?? "n/a"}`,
    `isStreaming=${s.isStreaming}`,
    `streamingMessage=${s.streamingMessage ? "有" : "无"}`,
    `消息角色=[${(s.messages ?? []).map((m) => m.role).join(",")}]`,
  ].join(" ");
}

/** 端口是否已释放（没人监听）。用来证明停机真的关掉了 listener，而不只是进程退出。 */
async function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

let conversationId = null;
let assistantText = "";

/* ── 4. 第一段进程：真实对话 ── */
console.log("── 第一段：起进程 → 真实对话 ──");
{
  const { child, log } = startServer("run1");
  await waitReady("run1", log);

  const { frames, socket } = connect();
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));

  await waitFrame(frames, "ready", "run1");
  const snap0 = await waitFrame(frames, "snapshot", "run1");
  conversationId = snap0.state.conversationId;
  check("进程 1: 握手后拿到 conversationId", !!conversationId, conversationId ?? "");
  // 设置是从 agentDir 里的文件读的——这条同时验证「设置落盘真的生效」。
  // 数据源用 `/capabilities`（文档化契约）而不是日志正则。
  const catalogs = await loadCatalogs();
  check("进程 1: 内置示例内容确实未加载",
    !catalogs.knowledge.includes("about") && !catalogs.skills.includes("summarize"),
    `knowledge=[${catalogs.knowledge.join(",")}] skills=[${catalogs.skills.join(",")}]`);

  socket.send(JSON.stringify({ type: "prompt", text: "记住这句话：pineapple" }));

  // 权威结束信号——必须由 SDK 的 agent_end 驱动，不是靠超时猜的
  const end = await waitFrame(frames, "run_end", "run1");
  check("进程 1: 收到 run_end（真实跑完一轮）", !!end, `stopReason=${end?.stopReason ?? "-"}`);
  check("进程 1: 没有落到自动重试", !end?.willRetry);

  // run_end 只推结束信号，不保证附带新快照；主动 get_state 强制刷新一次
  socket.send(JSON.stringify({ type: "get_state" }));
  const final = await waitFor("run1 快照含助手消息", () =>
    frames.filter((f) => f.type === "snapshot").pop()?.state?.messages?.find((m) => m.role === "assistant"),
  ).catch((err) => {
    throw new Error(`${err.message}\n最后快照：${describeLastSnapshot(frames)}`);
  });
  assistantText = final.text ?? final.content ?? "";
  check("进程 1: 助手回复内容正确", String(assistantText).includes("E2E"), String(assistantText).slice(0, 40));
  check("进程 1: 假 LLM 确实被调用", seenRequests.length >= 1, `requests=${seenRequests.length}`);
  check("进程 1: 同一进程内用户消息可见",
    !!frames.filter((f) => f.type === "snapshot").pop()?.state?.messages?.find((m) => m.role === "user"));

  // 会话文件必须已经落盘，否则重启无从恢复。
  // SDK 的会话目录是 `<PI_CODING_AGENT_DIR>/sessions/<编码后的 cwd>/`，实测确认受
  // PI_CODING_AGENT_DIR 隔离，所以这个脚本不会在用户真实的 ~/.pi 下留垃圾。
  const found = findFiles(agentDir, ".jsonl");
  check("进程 1: SDK 会话 jsonl 已落盘", found.length > 0,
    found.map((f) => f.replace(agentDir, "…")).join(", ") || "未找到 .jsonl");
  check("进程 1: 会话文件确实隔离在临时 agentDir 内",
    found.every((f) => f.startsWith(agentDir)));

  socket.terminate();
  await sleep(300);

  /* ── 5. 杀掉进程，并确认它真的死了 ──
   * 这一步是整个脚本的核心：进程内的一切状态（含内存里的 SessionManager）必须随进程消失，
   * 否则「重启后恢复」就只是同进程复用，测不到落盘与索引的真实行为。 */
  const exited = new Promise((r) => child.once("exit", () => r(true)));
  child.kill("SIGKILL");
  check("进程 1: 已真被杀（会话只可能来自磁盘）", (await Promise.race([
    exited, sleep(15_000).then(() => false),
  ])) === true);
}

/* ── 6. 第二段进程：全新进程，从磁盘恢复 ── */
console.log("── 第二段：重启进程 → 从磁盘恢复会话 ──");
let run2;
{
  const started = startServer("run2");
  run2 = started.child;
  await waitReady("run2", started.log);

  const { frames, socket } = connect();
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
  await waitFrame(frames, "ready", "run2");
  await waitFrame(frames, "snapshot", "run2");

  // 新进程的初始会话不是刚才那个，索引里应该有它且标记为 dormant
  socket.send(JSON.stringify({ type: "list_conversations" }));
  const list = await waitFrame(frames, "conversations", "run2");
  const entries = list.conversations ?? list.items ?? [];
  const target = entries.find((c) => c.id === conversationId || c.conversationId === conversationId);
  check("进程 2: 索引里找得到重启前的会话", !!target,
    `可见 ${entries.length} 个：${entries.map((c) => `${c.id ?? c.conversationId}(${c.dormant ? "dormant" : "active"})`).join(", ")}`);
  check("进程 2: 该会话标记为 dormant（需显式打开）", target?.dormant === true, `dormant=${target?.dormant}`);

  socket.send(JSON.stringify({ type: "open_conversation", conversationId }));
  const snap = await waitFor("run2 打开后含历史助手消息", () =>
    frames.filter((f) => f.type === "snapshot").pop()?.state?.messages?.find((m) => m.role === "assistant"),
  );
  check("进程 2: 恢复出重启前的助手消息", String(snap.text ?? snap.content ?? "").includes("E2E"),
    String(snap.text ?? snap.content ?? "").slice(0, 40));
  check("进程 2: 恢复出重启前的用户消息",
    !!frames.filter((f) => f.type === "snapshot").pop()?.state?.messages?.find((m) => m.role === "user"));

  // 恢复后还能继续对话——这才是「可恢复」的真实含义。
  // 用「新的 run_end」作权威信号：open_conversation 恢复出来的是磁盘上的旧会话，
  // 它不该、也不能自己再产生一轮。
  const before = seenRequests.length;
  const framesBefore = frames.length;
  socket.send(JSON.stringify({ type: "prompt", text: "第二轮" }));
  const secondEnd = await waitFor("run2 第二轮跑完", () =>
    frames.slice(framesBefore).find((f) => f.type === "run_end"),
  ).catch((err) => {
    throw new Error(`${err.message}\n最后快照：${describeLastSnapshot(frames)}`);
  });
  check("进程 2: 恢复后能继续对话（第二轮真跑完）", !!secondEnd && seenRequests.length > before,
    `stopReason=${secondEnd?.stopReason ?? "-"}，新增请求 ${seenRequests.length - before} 次`);

  socket.terminate();
  await sleep(300);

  // 必须真杀掉：下一段要起run3，而三个进程共用同一个端口。
  const exited = new Promise((r) => run2.once("exit", () => r(true)));
  run2.kill("SIGKILL");
  await Promise.race([exited, sleep(15_000)]);
}

/* ── 7. 设置：改完落盘 → 再起一个进程 → 真的生效 ──
 * 内置示例内容（about.md / summarize）在**组装期**写进系统提示词，无法热切换。
 * 单测能证明「patch 成功且落盘」，但证明不了「下次组装时真的读走了」——那一步
 * 只发生在真实启动里。这一段把它补上。
 *
 * 起点是「关着」（上面写的 settings 把两个开关都设成 false），所以反转成 true之后
 * 才看得出是否真的被读走。 */
console.log("\n── 设置：改 → 落盘 → 重启后生效 ──");
{
  // 7a. 起一个进程，在里面改设置
  const first = startServer("run3");
  await waitReady("run3", first.log);
  const beforeCatalogs = await loadCatalogs();
  check("设置: 改之前示例内容确实是关的",
    !beforeCatalogs.knowledge.includes("about") && !beforeCatalogs.skills.includes("summarize"),
    `knowledge=[${beforeCatalogs.knowledge.join(",")}] skills=[${beforeCatalogs.skills.join(",")}]`);

  const res = await fetch(`http://127.0.0.1:${PORT}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ builtinKnowledge: true, builtinSkills: true }),
  });
  const body = await res.json();
  check("设置: PATCH /settings 返回改后的值", body?.settings?.builtinKnowledge === true,
    `status=${res.status} builtinKnowledge=${body?.settings?.builtinKnowledge}`);

  const onDisk = JSON.parse(readFileSync(join(agentDir, "pi-starter-settings.json"), "utf8"));
  check("设置: 值已落盘", onDisk.builtinKnowledge === true && onDisk.builtinSkills === true,
    `落盘 builtinKnowledge=${onDisk.builtinKnowledge} builtinSkills=${onDisk.builtinSkills}`);

  // 同一进程内不该热切换——内核必须如实说「要重启」，而不是假装已生效
  const stillOff = await loadCatalogs();
  check("设置: 同进程内不热切换（系统提示词里仍无示例）",
    !stillOff.knowledge.includes("about") && !stillOff.skills.includes("summarize"),
    `knowledge=[${stillOff.knowledge.join(",")}] skills=[${stillOff.skills.join(",")}]`);

  await new Promise((r) => { first.child.once("exit", () => r(true)); first.child.kill("SIGKILL"); });

  // 7b. 再起一个进程：这次必须真的把示例内容加载回来
  const second = startServer("run4");
  await waitReady("run4", second.log);
  const afterCatalogs = await loadCatalogs();
  check("设置: 重启后示例知识真的被加载（knowledge 里有 about）",
    afterCatalogs.knowledge.includes("about"), `knowledge=[${afterCatalogs.knowledge.join(",")}]`);
  check("设置: 重启后示例技能真的被加载（skills 里有 summarize）",
    afterCatalogs.skills.includes("summarize"), `skills=[${afterCatalogs.skills.join(",")}]`);

  await new Promise((r) => { second.child.once("exit", () => r(true)); second.child.kill("SIGKILL"); });
}

/* ── 7.5 跨会话记忆：写 → 落盘 → 重启后仍在 ──
 * 记忆的全部意义就是「换个会话/重启还在」。单测能证明 store 落盘与重建实例仍可读，
 * 但证明不了「真实进程里的 `/memory` 与工具用的是同一份、且真的落在 agentDir 下」——
 * 那一步只在真实启动里发生。这里直接打 HTTP，不依赖模型调用。 */
console.log("\n── 跨会话记忆：写 → 落盘 → 重启后仍在 ──");
{
  const first = startServer("memory-run1");
  await waitReady("memory-run1", first.log);

  // 默认开：能力目录里必须有两个记忆工具（关掉时才不该出现）。
  const caps = await (await fetch(`http://127.0.0.1:${PORT}/capabilities`)).json();
  const toolNames = (caps.tools ?? []).map((t) => t.name);
  check("记忆: 默认开，能力目录里有 remember / recall",
    toolNames.includes("remember") && toolNames.includes("recall"),
    `tools=[${toolNames.join(",")}]`);

  // 空查询就是「我记过什么」，起点必须是空的（落到临时 agentDir，不读用户真实记忆）。
  const emptyList = await (await fetch(`http://127.0.0.1:${PORT}/memory`)).json();
  check("记忆: 起点是空的（用的是临时 agentDir，不碰用户真实记忆）",
    emptyList.total === 0, `total=${emptyList.total}`);

  const wrote = await fetch(`http://127.0.0.1:${PORT}/memory`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "用户偏好中文回答，恢复时要记住这条", tags: ["preference"] }),
  });
  const wroteBody = await wrote.json();
  check("记忆: POST /memory 写入成功并给出 id", wrote.status === 200 && Boolean(wroteBody.id),
    `status=${wrote.status} id=${wroteBody.id}`);

  const memFile = join(agentDir, "pi-starter-memory.jsonl");
  check("记忆: 已落盘到 agentDir 下（不是内存）", existsSync(memFile), `期望文件 ${memFile}`);

  await new Promise((r) => { first.child.once("exit", () => r(true)); first.child.kill("SIGKILL"); });

  // 重启：换一个进程，记忆必须还在，且能按关键词命中。
  const second = startServer("memory-run2");
  await waitReady("memory-run2", second.log);
  const afterList = await (await fetch(`http://127.0.0.1:${PORT}/memory`)).json();
  check("记忆: 重启后仍在（跨会话的前提）",
    afterList.total === 1 && String(afterList.hits?.[0]?.text).includes("偏好中文"),
    `total=${afterList.total} hit=${afterList.hits?.[0]?.text}`);

  const searched = await (await fetch(`http://127.0.0.1:${PORT}/memory?q=中文`)).json();
  check("记忆: 重启后按关键词命中", searched.hits?.length === 1, `hits=${searched.hits?.length}`);

  // 删除后重启不该复活。
  const id = afterList.hits?.[0]?.id;
  const deleted = await fetch(`http://127.0.0.1:${PORT}/memory/${id}`, { method: "DELETE" });
  check("记忆: DELETE /memory/:id 删除成功", deleted.status === 200, `status=${deleted.status}`);

  await new Promise((r) => { second.child.once("exit", () => r(true)); second.child.kill("SIGKILL"); });

  const third = startServer("memory-run3");
  await waitReady("memory-run3", third.log);
  const finalList = await (await fetch(`http://127.0.0.1:${PORT}/memory`)).json();
  check("记忆: 删除已落盘，重启后不复活", finalList.total === 0, `total=${finalList.total}`);
  await new Promise((r) => { third.child.once("exit", () => r(true)); third.child.kill("SIGKILL"); });
}

/* ── 8. 优雅停机 ──
 * `shutdown()` 负责按序拆掉审批闸门 → WS → 会话 → 扩展，并回收 MCP 子进程。
 * 这条链路此前**零覆盖**：E2E 全程用 SIGKILL，直接绕过它；而没被跑过的清理代码
 * 等于没有清理——「声明了但没接线」在这个项目里反复出现过。
 *
 * 两个断言方向：进程必须**自己**退出（不是被杀），且不是靠 1s 兜底强退的
 * （走了兜底说明 socket 没关干净，只是被超时掩盖了）。 */
console.log("\n── 优雅停机：真进程 + 真信号 ──");
{
  const started = startServer("shutdown");
  await waitReady("shutdown", started.log);

  // 制造两类活跃连接：HTTP keep-alive（fetch 会复用）与 WS。关闭时都要被收拾掉。
  const info = await fetch(`http://127.0.0.1:${PORT}/info`);
  await info.json();
  const { frames, socket } = connect();
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
  await waitFrame(frames, "ready", "shutdown");

  const exited = new Promise((r) => started.child.once("exit", (code) => r(code)));
  started.child.kill("SIGTERM");
  const code = await Promise.race([exited, sleep(20_000).then(() => "timeout")]);

  const text = started.log.join("");
  const sawHandler = text.includes("开始优雅停机");

  // Windows 上 Node **不投递**可供子进程捕获的 SIGTERM：`child.kill("SIGTERM")` 走的是
  // TerminateProcess（实测退出码为 null、handler 从不运行）。所以真信号路径只在 POSIX
  // 上能测，这里**显式报告跳过**——让它假通过比没有这条测试更糟（之前那条
  // 「不是兜底强退」的断言就在 handler 未运行时也通过了，是纯粹的假阳性）。
  // 编排逻辑本身（顺序 / 失败隔离 / 幂等 / 兜底）已由 `src/graceful.test.ts` 全平台覆盖。
  if (!sawHandler) {
    skip("停机: SIGTERM 优雅停机全链路",
      `${process.platform} 不投递可捕获的 SIGTERM —— 逻辑已由 graceful.test.ts 覆盖`);
  } else {
    check("停机: SIGTERM 触发了 shutdown（不只是被内核杀死）", sawHandler, "日志有「开始优雅停机」");
    check("停机: 进程自行退出且退出码为 0", code === 0, `退出码=${code}`);
    // 这条只有在 handler 真的跑过时才有意义——否则「没有超时日志」只是因为压根没停机。
    check("停机: 走的是正常关闭而非 1s 兜底强退", text.includes("已停机") && !text.includes("优雅停机超时"),
      text.includes("优雅停机超时") ? "走了兜底 —— socket 没关干净，被超时掩盖了" : "日志有「已停机」");
    check("停机: 有活跃 HTTP/WS 连接时也能干净退出（keep-alive 不卡住 close）", code === 0,
      "停机前已建立 fetch keep-alive + WS 连接");
  }
  // 端口释放是**最终**状态，不能单次瞬时判定：进程刚退出时 listener 可能还没被 OS
  // 收走（这条曾在多次通过后偶发变红）。轮询给一个合理窗口，超时才算真失败——
  // 若真的泄漏，10s 后依然会红，所以不是在掩盖问题。
  const freed = await waitFor("停机后端口释放", () => portFree(PORT), 10_000)
    .then(() => true)
    .catch(() => false);
  check("停机: 进程结束后端口已释放", freed, `port=${PORT}`);
}

/* ── 9. 索引指向一个已被删掉的文件 ──
 * 这个场景真实存在：用户手工清理 `sessions/`、备份不完整、或外部删了 jsonl。
 * 此时索引里那条记录**是脏的**——重启后若列表照旧显示它、或打开时抛 500 而不是
 * 干净地把它摘掉，用户就会面对一个永远打不开的幽灵条目。
 *
 * `catalog.remove()` 全项目只有一个调用点（`session-hub.ts`，打开历史会话失败且
 * 文件确实不在时），且只在 `code === "forbidden"` 时触发——这条判断到底成不成立，
 * 同进程测试测不出来，必须真重启。 */
console.log("\n── 索引与磁盘不一致：文件被外部删掉后重启 ──");
{
  // 9a. 先起一个进程，拿到索引里的会话
  const first = startServer("stale1");
  await waitReady("stale1", first.log);
  const { frames, socket } = connect();
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
  await waitFrame(frames, "ready", "stale1");
  socket.send(JSON.stringify({ type: "list_conversations" }));
  const listed = await waitFrame(frames, "conversations", "stale1");
  const entries = listed.items ?? listed.conversations ?? [];
  check("脏索引: 重启前列表里有历史会话", entries.length > 0, `共 ${entries.length} 条`);
  socket.terminate();
  await new Promise((r) => { first.child.once("exit", () => r(true)); first.child.kill("SIGKILL"); });

  // 9b. 在**没有进程运行**时删掉 jsonl（模拟外部清理）——索引文件保持不动，于是它变脏
  const jsonl = findFiles(agentDir, ".jsonl");
  check("脏索引: 磁盘上存在 jsonl 可供删除", jsonl.length > 0, `${jsonl.length} 个`);
  for (const f of jsonl) unlinkSync(f);
  check("脏索引: jsonl 已从磁盘移除（索引仍是脏的）", findFiles(agentDir, ".jsonl").length === 0);

  // 9c. 重启：入口不能挂，列表要么干净、要么至少能自愈
  const second = startServer("stale2");
  await waitReady("stale2", second.log);
  const c2 = connect();
  await once(c2.socket, "open");
  c2.socket.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
  await waitFrame(c2.frames, "ready", "stale2");
  c2.socket.send(JSON.stringify({ type: "list_conversations" }));
  const after = await waitFrame(c2.frames, "conversations", "stale2");
  const afterEntries = after.items ?? after.conversations ?? [];

  // 索引文件本身**没有被清理**——这正是关键：脏数据还在盘上，靠的是每次加载时过滤
  // （`sanitizeIndexEntries` → `assertSessionFileAllowed`，`realpath` 对已删文件失败）。
  // 断言索引里确实还留着那个死条目，否则「列表干净」可能只是因为索引被重写了。
  const indexFiles = findFiles(agentDir, "index.json");
  const indexed = indexFiles.length
    ? JSON.parse(readFileSync(indexFiles[0], "utf8")).conversations ?? []
    : [];
  check("脏索引: 索引文件里确实还留着已删除文件的条目", indexed.length > 0,
    `索引条目 ${indexed.length} 个（用于证明过滤真的发生了）`);

  // 列表里不能出现它——否则用户会看到一个永远打不开的幽灵。
  const listedIds = new Set(afterEntries.map((c) => c.id));
  const ghosts = indexed.filter((e) => listedIds.has(e.sessionId));
  check("脏索引: 列表里不出现幽灵条目（加载时 fail-closed 过滤）", ghosts.length === 0,
    `列表 ${afterEntries.length} 条，索引 ${indexed.length} 条，交集 ${ghosts.length}`);

  // 9d. 真正的风险：客户端手里有旧 id（缓存列表 / 重连前的会话）时来打开它。
  // 必须给出明确错误，**不能静默造一个空会话**——那会让用户以为历史被清空了。
  if (indexed.length > 0) {
    const staleId = indexed[0].sessionId;
    c2.frames.length = 0;
    c2.socket.send(JSON.stringify({ type: "open_conversation", conversationId: staleId }));
    const outcome = await waitFor("stale2 打开已删除会话有结果", () =>
      c2.frames.find((f) => f.type === "error" || f.type === "snapshot"), 15_000,
    ).catch(() => null);
    check("脏索引: 打开已删除的会话 id 给出错误而非假装成功", outcome?.type === "error",
      outcome ? `收到 ${outcome.type}${outcome.type === "error" ? `：${outcome.message}` : ""}`
              : "15s 内无任何响应 —— 前端会一直等");
    if (outcome?.type === "snapshot") {
      const snapshotId = outcome.state?.conversationId;
      check("脏索引: 若返回快照，至少不能是那个已删除的 id（静默假成功）",
        snapshotId !== staleId,
        `请求 ${staleId}，返回 ${snapshotId} —— 若相同即为「打开不存在的会话却成功」`);
    }
  }

  c2.socket.terminate();
  await new Promise((r) => { second.child.once("exit", () => r(true)); second.child.kill("SIGKILL"); });
}

/* ── 10. 恢复后带工具调用 ──
 * 这是升级 SDK 时最容易悄悄坏掉的地方：jsonl 里的 `tool_use` / `tool_result` 必须**成对**
 * 恢复到下一次请求里。少一半就是悬空工具调用——真实 provider 会直接报错，
 * 而错误信息通常指向「消息格式非法」，极难反推到「恢复时配对断了」。
 *
 * 断言打在**出站请求**上（而不是快照），因为那正是 provider 会校验的东西：
 * 恢复后再问一轮，检查发给假 LLM 的 messages 里每个 tool_call 都有对应 tool 结果，反之亦然。 */
console.log("\n── 恢复后带工具调用：tool_use / tool_result 必须成对 ──");
{
  llmToolMode = true;
  const first = startServer("tool1", { PI_BUILTIN_TOOLS: "readonly" });
  await waitReady("tool1", first.log);
  const { frames, socket } = connect();
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
  await waitFrame(frames, "ready", "tool1");
  const snap0 = await waitFrame(frames, "snapshot", "tool1");
  const toolConvId = snap0.state.conversationId;

  const before = seenRequests.length;
  socket.send(JSON.stringify({ type: "prompt", text: "列一下当前目录" }));
  const end = await waitFrame(frames, "run_end", "tool1");
  check("工具调用: 一轮真的跑完（含工具往返）", !!end, `stopReason=${end?.stopReason ?? "-"}`);
  check("工具调用: 假 LLM 至少被调两次（工具前 + 工具后）",
    seenRequests.length - before >= 2, `新增 ${seenRequests.length - before} 次`);
  const toolEnd = frames.find((f) => f.type === "tool_status" && f.phase === "end");
  check("工具调用: ls 真的被执行且未报错",
    !!toolEnd && toolEnd.toolName === "ls" && !toolEnd.isError,
    toolEnd ? `${toolEnd.toolName} isError=${toolEnd.isError}` : "未收到 tool_status end");

  socket.terminate();
  await new Promise((r) => { first.child.once("exit", () => r(true)); first.child.kill("SIGKILL"); });

  // 重启 → 恢复 → 再问一轮，检查历史里的工具调用是否成对带过去了
  const second = startServer("tool2", { PI_BUILTIN_TOOLS: "readonly" });
  await waitReady("tool2", second.log);
  const c2 = connect();
  await once(c2.socket, "open");
  c2.socket.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
  await waitFrame(c2.frames, "ready", "tool2");
  c2.socket.send(JSON.stringify({ type: "open_conversation", conversationId: toolConvId }));
  const resumed = await waitFor("tool2 恢复出带工具的历史", () =>
    c2.frames.filter((f) => f.type === "snapshot").pop()?.state?.messages?.some((m) => m.role === "assistant"),
    30_000,
  ).catch(() => null);
  check("工具调用: 重启后恢复了该会话", !!resumed, resumed ? "有助手消息" : "未恢复");

  c2.socket.send(JSON.stringify({ type: "prompt", text: "继续" }));
  await waitFrame(c2.frames, "run_end", "tool2");

  const req = seenRequests[seenRequests.length - 1];
  const msgs = Array.isArray(req?.messages) ? req.messages : [];
  const callIds = new Set(
    msgs.filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls))
      .flatMap((m) => m.tool_calls.map((tc) => tc.id)),
  );
  const resultIds = new Set(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  check("恢复后: 历史里的工具调用确实带到了出站请求里", callIds.size > 0,
    `tool_calls=${callIds.size}，tool 结果=${resultIds.size}`);
  check("恢复后: 每个 tool_call 都有对应结果（无悬空调用）",
    callIds.size > 0 && [...callIds].every((id) => resultIds.has(id)),
    `calls=[${[...callIds].join(",")}] results=[${[...resultIds].join(",")}]`);
  check("恢复后: 没有孤立的结果（无对应调用）",
    [...resultIds].every((id) => callIds.has(id)),
    `results=[${[...resultIds].join(",")}]`);

  c2.socket.terminate();
  await new Promise((r) => { second.child.once("exit", () => r(true)); second.child.kill("SIGKILL"); });
}

const failed = results.filter((r) => !r.ok);
const skippedCount = results.filter((r) => r.skipped).length;
const passed = results.length - failed.length - skippedCount;
console.log(
  `\n${passed} 通过 / ${skippedCount} 跳过 / ${failed.length} 失败（共 ${results.length}）`,
);
if (failed.length) {
  console.log("失败项：");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
}
if (skippedCount) {
  console.log("跳过项（必须显式列出，避免假绿）：");
  for (const s of results.filter((r) => r.skipped)) console.log(`  - ${s.name} — ${s.detail}`);
}
process.exit(failed.length ? 1 : 0);
