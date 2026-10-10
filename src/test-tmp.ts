/**
 * pi-starter · 测试临时目录助手（仅测试引用，不进 dist —— 见 `tsconfig.build.json` 的 exclude）
 *
 * 为什么需要它：`mkdtempSync(join(tmpdir(), "pi-…"))` 在系统临时目录里造目录，而全项目
 * 111 处调用里，有 21 个测试文件**一个删除动作都没有**。实测堆到 8528 个 `pi-*` 目录、
 * 5.0 GB：会话 JSONL、SQLite 库、日志分片都是有体积的东西，而且每跑一轮全量测试就再长一层。
 * 「测试通过」从来不等于「资源释放了」。
 *
 * 用法：`mkdtempSync(join(tmpdir(), "pi-xxx-"))` → `tempDir("pi-xxx-")`。
 *
 * 清理挂在**进程退出**上（`node:test` 每个测试文件一个进程），所以不需要把 `TestContext`
 * 一路传进每个 helper——那会把 100 多处调用改成签名传染。删除失败不静默：剩下的目录
 * 连同数量一起打印出来（Windows 上最常见的原因是 SQLite 句柄没关，那是被测代码的问题，
 * 正是要暴露的，不该被 `force: true` 掩盖掉）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];
let armed = false;

/** 建一个临时目录并登记回收；进程退出时统一删除。 */
export function tempDir(prefix = "pi-starter-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  if (!armed) {
    armed = true;
    process.on("exit", cleanupTempDirs);
  }
  return dir;
}

/**
 * 立即回收全部登记过的目录，返回**没能删除**的那些。
 * 导出它是为了让测试能显式断言「清干净了」，也让失败可见。
 */
export function cleanupTempDirs(): string[] {
  const failed: string[] = [];
  while (created.length > 0) {
    const dir = created.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      failed.push(`${dir} — ${(err as Error).message}`);
    }
  }
  if (failed.length > 0) {
    console.error(`test-tmp: ${failed.length} 个临时目录没能回收（多半是句柄未关）：\n  ${failed.join("\n  ")}`);
  }
  return failed;
}
