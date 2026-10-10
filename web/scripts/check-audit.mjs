/**
 * 前端依赖审计闸门：只对**新增**高危通告报错，已知且已复核的登记在 audit-baseline.json。
 *
 * 为什么要自己包一层，而不是直接用 `npm audit --omit=dev`：
 *   web/ 的依赖链里有一条**没有可用修复**的高危通告（`braces` 的 GHSA-vfj7-8cjw-p6xm，
 *   见 baseline 的 note）。`npm audit` 对它的建议是 `npm audit fix --force`，而那条会把
 *   `shadcn` 降到 1.0.0（breaking change），且实测**换不来修复**——`braces` 最新版本就是
 *   受影响的 3.0.3，上游 `micromatch` / `fast-glob` 也均已是最新。
 *   若把闸门收窄成 `--omit=dev`，这条通告会**彻底从 CI 里消失**——那等于用「看不见」冒充
 *   「修好了」，正是本仓反复声明要避免的事。所以这里改成与 check-registry-sync.mjs 同款的
 *   **基线化**门禁：
 *     · 已登记的 GHSA + 依赖链未变  -> 打印但不阻断（退出 0）；
 *     · 未登记的新通告              -> 失败（退出 1）——这才是需要人看的信号；
 *     · 登记过但**影响范围变了**    -> 失败（退出 1），逼人重新复核。
 *   再加一条硬门：**生产依赖（--omit=dev）必须保持 0 高危**。`shadcn` 已从 dependencies
 *   移到 devDependencies（它是构建期用 `shadcn/tailwind.css` 的 CSS 源 + 开发期 CLI，
 *   产物已内联进 web/dist，不是运行时依赖），所以生产依赖里本就不该有漏洞。
 *
 * 用法：
 *   node scripts/check-audit.mjs                    # 门禁：登记过的放过，新增的判失败
 *   node scripts/check-audit.mjs --write-baseline   # 认下当前这批通告（必须在 PR 里可见地提交）
 *   node scripts/check-audit.mjs --tolerate-network # 网络不可达时按"跳过"处理并退出 0（CI 用）
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org";
const BASELINE = fileURLToPath(new URL("./audit-baseline.json", import.meta.url));
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const writeBaseline = flags.includes("--write-baseline");
const tolerateNetwork = flags.includes("--tolerate-network");

/**
 * 跑一次 npm audit --json。
 * `--omit=dev` 时只审计生产依赖（用于「生产依赖必须为 0」那条硬门）。
 * 退出码：npm audit 有漏洞时返回非 0，这是**预期**的（我们靠 JSON 判断，不靠退出码）。
 */
function runAudit({ omitDev }) {
  const args = ["audit", "--json", `--registry=${REGISTRY}`];
  if (omitDev) args.push("--omit=dev");
  let stdout;
  try {
    stdout = execFileSync("npm", args, { cwd: WEB_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    stdout = err.stdout;
    // 网络故障 / registry 端点异常时 stdout 可能不是 JSON；交给调用方判空。
    if (!stdout) return { error: String(err.stderr || err.message).trim() };
  }
  try {
    return { report: JSON.parse(stdout) };
  } catch {
    return { error: (stdout || "").slice(0, 400) };
  }
}

/**
 * 从 audit 报告里抽出**根通告**（GHSA）。
 * npm 的 report 是"每个受影响包一条"，其中 `via` 为字符串的是传递包、为对象的是真实通告。
 * 我们只关心真实通告（带 url 的那些）——它们才是"要修的东西"，其余是它的影响面。
 */
function rootAdvisories(report) {
  const found = new Map();
  for (const [pkg, v] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== "object" || !via.url) continue;
      const id = vsaKey(via.url, via.source);
      const entry = found.get(id) ?? {
        id,
        package: via.dependency ?? pkg,
        severity: via.severity ?? v.severity,
        title: via.title ?? "",
        url: via.url,
        range: via.range ?? "",
        affected: new Set(),
      };
      entry.affected.add(pkg);
      found.set(id, entry);
    }
  }
  return [...found.values()].map((e) => ({ ...e, affected: [...e.affected].sort() }));
}

/** 优先用 URL 里的 GHSA / CVE 编号做稳定 key；退化时用 npm source id（至少同源可比）。 */
function vsaKey(url, source) {
  const m = String(url).match(/(GHSA-[\w-]+|CVE-\d{4}-\d+)/i);
  return m ? m[1].toUpperCase() : `npm-${source}`;
}

function loadBaseline() {
  if (!existsSync(BASELINE)) return { advisories: {} };
  try {
    const b = JSON.parse(readFileSync(BASELINE, "utf8"));
    return { advisories: b.advisories ?? {} };
  } catch (err) {
    console.error(`audit baseline 不是合法 JSON：${BASELINE}\n${err.message}`);
    process.exit(2);
  }
}

const full = runAudit({ omitDev: false });
if (full.error) {
  const msg = `无法完成 npm audit（网络或 registry 故障）：\n  ${full.error}`;
  if (tolerateNetwork) {
    console.error(`\n${msg}\n（--tolerate-network：按"跳过"处理，退出码 0 —— 没验证不等于验证通过。）`);
    process.exit(0);
  }
  console.error(`\n${msg}`);
  process.exit(2);
}

const prod = runAudit({ omitDev: true });
if (prod.error) {
  const msg = `无法完成生产依赖审计：\n  ${prod.error}`;
  if (tolerateNetwork) {
    console.error(`\n${msg}\n（--tolerate-network：按"跳过"处理，退出码 0。）`);
    process.exit(0);
  }
  console.error(`\n${msg}`);
  process.exit(2);
}

const advisories = rootAdvisories(full.report);
const prodAdvisories = rootAdvisories(prod.report);

// ---- 硬门：生产依赖必须 0 高危 -------------------------------------------------
const prodHigh = prodAdvisories.filter((a) => ["high", "critical"].includes(a.severity));
const prodMeta = prod.report?.metadata?.vulnerabilities ?? {};
if (prodHigh.length > 0 || (prodMeta.high ?? 0) + (prodMeta.critical ?? 0) > 0) {
  console.error("\n[audit] 生产依赖（--omit=dev）存在高危通告 —— 这是硬门，任何情况下都不放过：");
  for (const a of prodHigh) console.error(`  - ${a.id} ${a.package} (${a.severity}) ${a.url}`);
  console.error(`  摘要：high=${prodMeta.high ?? 0} critical=${prodMeta.critical ?? 0}`);
  process.exit(1);
}
console.log(`[audit] 生产依赖（--omit=dev）：0 高危（high=${prodMeta.high ?? 0} critical=${prodMeta.critical ?? 0}）。`);

// ---- 基线化门：开发依赖里的已知通告放过，新增判失败 ---------------------------
if (writeBaseline) {
  const advisoriesOut = {};
  for (const a of advisories) {
    advisoriesOut[a.id] = {
      package: a.package,
      severity: a.severity,
      url: a.url,
      range: a.range,
      affected: a.affected,
      note: "",
    };
  }
  writeFileSync(BASELINE, JSON.stringify({ _说明: "", advisories: advisoriesOut }, null, 2) + "\n");
  console.log(`[audit] 已写入 baseline（${Object.keys(advisoriesOut).length} 条）：${BASELINE}`);
  process.exit(0);
}

const { advisories: known } = loadBaseline();
const failures = [];

for (const a of advisories) {
  const k = known[a.id];
  if (!k) {
    failures.push({ reason: "新增通告（未登记）", a });
    continue;
  }
  // 影响范围变了就要求重新复核（版本区间 / 受影响包集合是"这条漏洞到底打谁"的判断依据）。
  if (k.range !== a.range || JSON.stringify(k.affected) !== JSON.stringify(a.affected)) {
    failures.push({ reason: "已知通告的影响范围发生变化，需重新复核", a, prev: k });
  }
}

for (const id of Object.keys(known)) {
  if (!advisories.some((a) => a.id === id)) {
    console.log(`[audit] 提示：baseline 里的 ${id} 已不再出现（依赖已升级或移除），可从 baseline 删除。`);
  }
}

if (advisories.length > 0) {
  console.log(`\n[audit] 全部通告（含已登记）：${advisories.length} 条根通告`);
  for (const a of advisories) {
    const tag = known[a.id] ? "已登记" : "新增";
    console.log(`  [${tag}] ${a.id} ${a.package} (${a.severity}) range=${a.range}`);
    console.log(`           ${a.url}`);
    if (known[a.id]?.note) console.log(`           note: ${known[a.id].note}`);
  }
}

if (failures.length > 0) {
  console.error(`\n[audit] 以下 ${failures.length} 条需要处理：`);
  for (const f of failures) {
    console.error(`  - ${f.reason}：${f.a.id} ${f.a.package} (${f.a.severity}) range=${f.a.range}`);
    if (f.prev) console.error(`      原记录 range=${f.prev.range}，现为 range=${f.a.range}`);
  }
  console.error(`\n若是**已复核、且无可用修复**的新通告，把它登记进 ${BASELINE}（并在同一 PR 里写明理由）；`);
  console.error("若确实可修，请升级依赖，不要往 baseline 里塞。");
  process.exit(1);
}

console.log(
  `\n[audit] 通过：生产依赖 0 高危；开发依赖 ${advisories.length} 条通告均在基线内（${Object.keys(known).length} 条已登记）。`
);
