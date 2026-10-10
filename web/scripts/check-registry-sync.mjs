/**
 * 校验本地官方组件与 assistant-ui registry 发布内容是否逐字节一致。
 *
 * 为什么要这个脚本：我们说"样式和官方一样"，靠眼看不可靠。这些组件是 shadcn registry
 * 落盘的**源码**（会随上游更新），只有和内容比对才算证据。
 *
 * 为什么还要 baseline：上游是**实时**拉取的（无固定版本），"与官方逐字节一致"不可能长期
 * 成立；而这个检查一旦恒红就会被排除出门禁，等于没人守。所以改成
 * **「记录已知偏离 + 只对新增偏离报错」**：
 *   · 已登记在 registry-baseline.json 且本地内容哈希未变的偏离 → 打印但不阻断（退出 0）；
 *   · 未登记、或登记过但本地又被改动的偏离 → 判失败（退出 1）——这才是真正需要人看的信号；
 *   · 拉不到 registry → 退出 2（网络故障，不是内容问题）。
 *
 * 用法：
 *   node scripts/check-registry-sync.mjs                      # 默认查 thread / thread-list（含递归依赖）
 *   node scripts/check-registry-sync.mjs thread-list          # 指定入口
 *   node scripts/check-registry-sync.mjs --write-baseline     # 认下当前这批偏离（需在 PR 里可见地提交）
 *   node scripts/check-registry-sync.mjs --tolerate-network   # 网络不可达时按"跳过"处理（CI 用）
 *
 * 输出三类结果：
 *   same      内容一致（位置可能已被我们按 import 归位，不影响判定）
 *   MOVED     内容一致但不在 registry 声明的路径上（我们的目录归位，正常）
 *   MODIFIED  内容不一致 —— 说明有人改过官方组件，或上游变了
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://r.assistant-ui.com/styles/base-nova";
// 必须用 fileURLToPath：直接取 URL.pathname 在 Windows 下会留下前导斜杠（/D:/...），
// 导致所有文件被判成 MISSING。
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const BASELINE = fileURLToPath(new URL("./registry-baseline.json", import.meta.url));

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** 换行归一：CLI 在 Windows 落盘的是 CRLF，registry 内容用 LF，不归一会全部误报为修改。 */
const norm = (s) => s.replace(/\r\n/g, "\n");

/**
 * 比对用的规范化：换行归一 + 去掉行尾空白。
 * 行尾空白在编辑器里几乎不可见，却会让"逐字节一致"天天翻红 —— 它不是我们要守的东西。
 */
const canonical = (s) => norm(s).replace(/[ \t]+$/gm, "");

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

/** 读已知偏离清单；缺失或损坏都当作"没有 baseline"（那会让所有偏离都算新增，宁可红也不要静默放过）。 */
function loadBaseline() {
  if (!existsSync(BASELINE)) return { modified: {}, missing: {} };
  try {
    const b = JSON.parse(readFileSync(BASELINE, "utf8"));
    return { modified: b.modified ?? {}, missing: b.missing ?? {} };
  } catch (err) {
    console.error(`baseline 不是合法 JSON：${BASELINE}\n${err.message}`);
    process.exit(2);
  }
}

const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const targets = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const entries = targets.length > 0 ? targets : ["thread", "thread-list"];
const writeBaseline = flags.includes("--write-baseline");
const tolerateNetwork = flags.includes("--tolerate-network");

console.log(`registry: ${BASE}  entries: ${entries.join(", ")}`);

const { files, skipped, netFail } = await collect(entries);
if (netFail.length > 0) {
  const msg = `无法拉取 registry（网络故障，不代表内容不一致）：\n  ${netFail.join("\n  ")}`;
  if (tolerateNetwork) {
    console.error(`\n${msg}\n（--tolerate-network：按"跳过"处理，退出码 0 —— 没验证不等于验证通过。）`);
    process.exit(0);
  }
  console.error(`\n${msg}`);
  process.exit(2);
}

const baseline = loadBaseline();
const stats = { same: 0, moved: 0, modified: 0, missing: 0 };
const moved = [];
const waived = []; // 已登记且本地内容未变：不阻断
const fresh = []; // 新增偏离：判失败
const next = { modified: {}, missing: {} };

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
    const known = baseline.missing[f.path];
    next.missing[f.path] = { note: known?.note ?? "" };
    (known ? waived : fresh).push(`MISSING  ${f.path}`);
    continue;
  }

  const mine = canonical(readFileSync(hit, "utf8"));
  const theirs = canonical(f.content);
  if (mine === theirs) {
    const declared = join(SRC, f.path);
    if (hit === declared) stats.same++;
    else {
      stats.moved++;
      moved.push(`MOVED    ${f.path}  ->  ${relative(SRC, hit)}（内容一致，位置按 import 归位）`);
    }
    continue;
  }

  stats.modified++;
  const d = firstDiff(mine, theirs);
  const localSha = sha(mine);
  next.modified[f.path] = {
    sha: localSha,
    line: d?.line ?? null,
    note: baseline.modified[f.path]?.note ?? "",
  };
  const desc = `MODIFIED ${f.path}  第 ${d?.line} 行不同\n         local : ${d?.local}\n         registry: ${d?.remote}`;
  // 关键：**哈希对得上才算"已知偏离"**。登记过但本地内容又变了 → 新增偏离 → 失败。
  (baseline.modified[f.path]?.sha === localSha ? waived : fresh).push(desc);
}

if (writeBaseline) {
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        _说明:
          "已知偏离清单：这些官方组件与上游 registry 暂时不一致（上游实时拉取、无固定版本）。" +
          "`sha` 是**本地内容**规范化后的哈希——本地内容一变即视为新增偏离并判失败；确认是刻意的改动后，跑 " +
          "`npm --prefix web run check:official -- --write-baseline` 更新它（这一步必须出现在 PR 里被人看到）。" +
          "`line` / `note` 仅供人工判断，脚本不使用。",
        registry: BASE,
        entries,
        modified: next.modified,
        missing: next.missing,
      },
      null,
      2
    ) + "\n"
  );
  console.log(`\n已写入 baseline：${relative(process.cwd(), BASELINE)}（偏离 ${waived.length + fresh.length} 项）`);
  process.exit(0);
}

if (moved.length > 0) console.log(moved.join("\n"));
if (waived.length > 0) {
  console.log(`\n已登记的偏离（${waived.length} 项，baseline 认可，不阻断）：`);
  console.log(waived.map((p) => `  ${p}`).join("\n"));
}
if (fresh.length > 0) {
  console.log(`\n**新增**偏离（不在 baseline 里，判失败）：`);
  console.log(fresh.map((p) => `  ${p}`).join("\n"));
}

// baseline 里记着、但这次已不再偏离的条目：上游追平或文件被删了，提示清掉，免得清单无限膨胀。
const stale = [...Object.keys(baseline.modified), ...Object.keys(baseline.missing)].filter(
  (p) => !(p in next.modified) && !(p in next.missing)
);
if (stale.length > 0) {
  console.log(`\nbaseline 里这些已不再偏离，可跑 --write-baseline 清掉：\n  ${stale.join("\n  ")}`);
}

if (skipped.length > 0) console.log(`\n未比对（shadcn 内置件，不属本 registry）：${skipped.join(", ")}`);
console.log(
  `\n共 ${files.length} 个文件：一致 ${stats.same} / 仅移动 ${stats.moved} / 内容不同 ${stats.modified} / 本地缺失 ${stats.missing}`
);
console.log(`已登记偏离 ${waived.length} 项 · 新增偏离 ${fresh.length} 项`);
process.exit(fresh.length > 0 ? 1 : 0);
