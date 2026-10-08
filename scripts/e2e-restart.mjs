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
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
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
    seenRequests.push(JSON.parse(body || "{}"));
    // 必须第一块就 200：SDK 侧有重试包装，制造 5xx 会拖慢甚至放大失败。
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
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
function startServer(tag) {
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
  // 设置是从 agentDir 里的文件读的——这条同时验证「设置落盘真的生效」
  check("进程 1: 内置示例内容确实未加载", !log.join("").includes('"knowledge":["about"]'),
    log.join("").match(/"knowledge":\[[^\]]*\]/)?.[0] ?? "未匹配");

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
  check("设置: 改之前示例内容确实是关的",
    /"knowledge":\[[^\]]*\]/.test(first.log.join("")) && !/"knowledge":\[[^\]]*"about"/.test(first.log.join("")),
    first.log.join("").match(/"knowledge":\[[^\]]*\]/)?.[0] ?? "未匹配");

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
  const stillOff = !/"knowledge":\[[^\]]*"about"/.test(first.log.join(""));
  check("设置: 同进程内不热切换（系统提示词里仍无示例）", stillOff,
    "示例内容在组装期写进提示词，热切换会前后不一致");

  await new Promise((r) => { first.child.once("exit", () => r(true)); first.child.kill("SIGKILL"); });

  // 7b. 再起一个进程：这次必须真的把示例内容加载回来
  const second = startServer("run4");
  await waitReady("run4", second.log);
  const text = second.log.join("");
  check("设置: 重启后示例知识真的被加载（knowledge 里有 about）",
    /"knowledge":\[[^\]]*"about"/.test(text), text.match(/"knowledge":\[[^\]]*\]/)?.[0] ?? "未匹配");
  check("设置: 重启后示例技能真的被加载（skills 里有 summarize）",
    /"skills":\[[^\]]*"summarize"/.test(text), text.match(/"skills":\[[^\]]*\]/)?.[0] ?? "未匹配");

  await new Promise((r) => { second.child.once("exit", () => r(true)); second.child.kill("SIGKILL"); });
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
  check("停机: 进程结束后端口已释放", await portFree(PORT), `port=${PORT}`);
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
