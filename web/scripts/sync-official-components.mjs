/**
 * 把官方 registry 的组件源码**逐字**写到它自己声明的路径上。
 *
 * 为什么需要它：`shadcn add` 落盘时会改写 import 路径并把文件平铺，结果是本地文件与
 * registry 当前内容并不相同（check-registry-sync.mjs 实测出 6 处差异，含一处
 * Base UI `render` vs registry `asChild` 的组件风味差异）。要说"样式和官方一样"，
 * 判据只能是内容与官方发布一致，所以这里按 registry 的 path + content 原样落盘。
 *
 * 用法：
 *   node scripts/sync-official-components.mjs            # 默认 thread + thread-list
 *   node scripts/sync-official-components.mjs thread     # 指定入口
 *
 * 写完请接着跑：
 *   node scripts/check-registry-sync.mjs   # 期望 17/17 一致
 *   npm run build
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://r.assistant-ui.com/styles/base-nova";
const SRC = fileURLToPath(new URL("../src", import.meta.url));

async function collect(targets, seen = new Set(), out = [], netFail = []) {
  for (const target of targets) {
    const url = String(target).startsWith("http")
      ? String(target)
      : `${BASE}/${String(target).replace(/\.json$/, "")}.json`;
    if (seen.has(url)) continue;
    seen.add(url);
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    } catch (err) {
      netFail.push(`${url} (${String(err?.cause?.code ?? err?.message ?? err)})`);
      continue;
    }
    if (!res.ok) {
      console.log(`  ! ${url} -> HTTP ${res.status}`);
      netFail.push(`${url} (HTTP ${res.status})`);
      continue;
    }
    const item = await res.json();
    for (const f of item.files ?? []) if (f.content) out.push(f);
    const deps = (item.registryDependencies ?? []).map(String);
    await collect(deps.filter((d) => d.startsWith("http")), seen, out, netFail);
  }
  return { files: out, netFail: [...new Set(netFail)] };
}

const entries = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["thread", "thread-list"];
const { files, netFail } = await collect(entries);

// 先全部拉到再写盘：拉到一半断线会导致只同步部分组件，比不同步更难查。
if (netFail.length > 0) {
  console.error(`\n拉取不完整，拒绝写盘（避免只同步一半）：\n  ${netFail.join("\n  ")}`);
  process.exit(2);
}

let written = 0;
for (const f of files) {
  const dest = join(SRC, f.path);
  mkdirSync(dirname(dest), { recursive: true });
  // registry 用 LF；原样写入，不做任何"贴心"改写。
  writeFileSync(dest, f.content.replace(/\r\n/g, "\n"), "utf8");
  written++;
  console.log(`  write src/${f.path}`);
}
console.log(`\n已按 registry 原样写入 ${written} 个文件。`);
console.log("下一步：删除旧的平铺副本（否则同一组件存在两份，构建时按别名解析容易拿错），再跑 check-registry-sync.mjs 与 npm run build。");
console.log(`（当前 src/components 下仍可能存在这些历史副本：${["file.tsx", "image.tsx", "markdown-text.tsx", "media-player.tsx", "surfaces.tsx", "tooltip-icon-button.tsx", "reasoning.tsx"].filter((n) => existsSync(join(SRC, "components", n))).join(", ")}）`);
