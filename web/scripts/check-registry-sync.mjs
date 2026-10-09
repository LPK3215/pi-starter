/**
 * 校验本地官方组件与 assistant-ui registry 发布内容是否逐字节一致。
 *
 * 为什么要这个脚本：我们说"样式和官方一样"，靠眼看不可靠。这些组件是 shadcn registry
 * 落盘的**源码**（会随上游更新），只有和内容比对才算证据。
 *
 * 用法：
 *   node scripts/check-registry-sync.mjs                 # 默认查 thread / thread-list（含递归依赖）
 *   node scripts/check-registry-sync.mjs thread-list     # 指定入口
 *
 * 输出三类结果：
 *   same      内容一致（位置可能已被我们按 import 归位，不影响判定）
 *   MOVED     内容一致但不在 registry 声明的路径上（我们的目录归位，正常）
 *   MODIFIED  内容不一致 —— 说明有人改过官方组件，或上游变了
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://r.assistant-ui.com/styles/base-nova";
// 必须用 fileURLToPath：直接取 URL.pathname 在 Windows 下会留下前导斜杠（/D:/...），
// 导致所有文件被判成 MISSING。
const SRC = fileURLToPath(new URL("../src", import.meta.url));

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** 换行归一：CLI 在 Windows 落盘的是 CRLF，registry 内容用 LF，不归一会全部误报为修改。 */
const norm = (s) => s.replace(/\r\n/g, "\n");

/** 返回第一处不同的行号与两边内容，用于区分“只是换行/空白”与“真被改过”。 */
function firstDiff(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return { line: i + 1, local: la[i] ?? "(EOF)", remote: lb[i] ?? "(EOF)" };
  }
  return null;
}

/**
 * 带重试的 fetch：registry 偶发连接超时（实测碰到过 10s connect timeout）。
 * 网络故障不能和“内容不一致”混成同一个退出码，否则 CI 会误报组件被改过。
 */
async function fetchJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return { status: res.status };
      return { status: 200, json: await res.json() };
    } catch (err) {
      if (i === tries) return { status: 0, error: String(err?.cause?.code ?? err?.message ?? err) };
      await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  return { status: 0, error: "unreachable" };
}

/**
 * 递归收集 item（含 registryDependencies）里声明的所有文件。
 * 依赖有两种形态（实推）：绝对 URL 指向 assistant-ui 自己的 registry，
 * 裸名（button/skeleton 等）是 shadcn 内置件——不在本 registry 里，只能跳过并如实标注。
 */
async function collect(targets, seen = new Set(), out = [], skipped = [], netFail = []) {
  for (const target of targets) {
    const url = String(target).startsWith("http") ? String(target) : `${BASE}/${String(target).replace(/\.json$/, "")}.json`;
    const key = url;
    if (seen.has(key)) continue;
    seen.add(key);
    const { status, json, error } = await fetchJson(url);
    if (status !== 200) {
      if (status === 0) netFail.push(`${url} (${error})`);
      else console.log(`  ! ${url} -> HTTP ${status}`);
      continue;
    }
    for (const f of json.files ?? []) out.push({ item: json.name, path: f.path, content: f.content });
    const deps = (json.registryDependencies ?? []).map(String);
    await collect(deps.filter((d) => d.startsWith("http")), seen, out, skipped, netFail);
    skipped.push(...deps.filter((d) => !d.startsWith("http")));
  }
  return { files: out, skipped: [...new Set(skipped)], netFail };
}

/** 在 src/ 下按文件名找本地副本（我们做过目录归位，不能假定路径一致）。 */
function findLocal(basename) {
  const expected = join(SRC, basename.replace(/^components\//, "components/"));
  if (existsSync(expected)) return expected;
  const guess = join(SRC, basename.replace(/^components\/assistant-ui\//, "components/assistant-ui/"));
  if (existsSync(guess)) return guess;
  return null;
}

/** 已知的位置改动：registry 声明路径 -> 我们按 import 归位后的路径。 */
const RELOCATED = new Map([
  ["src/utils/href.ts", "components/assistant-ui/utils/href.ts"],
]);

const entries = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["thread", "thread-list"];
console.log(`registry: ${BASE}  entries: ${entries.join(", ")}`);

const { files, skipped, netFail } = await collect(entries);
if (netFail.length > 0) {
  console.error(`\n无法拉取 registry（网络故障，不代表内容不一致）：\n  ${netFail.join("\n  ")}`);
  process.exit(2);
}
const stats = { same: 0, moved: 0, modified: 0, missing: 0 };
const problems = [];

for (const f of files) {
  if (!f.content) continue;
  const local = findLocal(f.path) ?? (RELOCATED.has(f.path) ? join(SRC, RELOCATED.get(f.path)) : null);
  const candidates = [
    local,
    join(SRC, f.path),
    // 我们自己按 import 行归位过：.aui 落在 assistant-ui/elements，辅助件落在 components 根，href 落在 utils
    join(SRC, "components/assistant-ui/elements", f.path.split("/").pop()),
    join(SRC, "components", f.path.split("/").pop()),
    join(SRC, "hooks", f.path.split("/").pop()),
    join(SRC, "utils", f.path.split("/").pop()),
  ].filter(Boolean);

  const hit = candidates.find((p) => existsSync(p));
  if (!hit) {
    stats.missing++;
    problems.push(`MISSING  ${f.path}`);
    continue;
  }
  const mine = norm(readFileSync(hit, "utf8"));
  const theirs = norm(f.content);
  if (mine === theirs) {
    const declared = join(SRC, f.path);
    if (hit === declared) stats.same++;
    else {
      stats.moved++;
      problems.push(`MOVED    ${f.path}  ->  ${hit.slice(SRC.length + 1)}（内容一致，位置按 import 归位）`);
    }
  } else {
    stats.modified++;
    const d = firstDiff(mine, theirs);
    problems.push(
      `MODIFIED ${f.path}  第 ${d?.line} 行不同\n         local : ${d?.local}\n         registry: ${d?.remote}`,
    );
  }
}

console.log(problems.join("\n") || "（全部一致且原位）");
if (skipped.length > 0) console.log(`\n未比对（shadcn 内置件，不属本 registry）：${skipped.join(", ")}`);
console.log(`\n共 ${files.length} 个文件：一致 ${stats.same} / 仅移动 ${stats.moved} / 内容不同 ${stats.modified} / 本地缺失 ${stats.missing}`);
// 内容不同或缺失 = 官方组件被改过或没装全，视为不达标。
process.exit(stats.modified + stats.missing > 0 ? 1 : 0);
