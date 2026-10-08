/**
 * pi-starter · 优雅停机编排
 *
 * 从 `server.ts` 抽出来，有两个原因：
 *
 * 1. **原先的兜底位置是错的。** 拆解步骤（闸门 → WS → 会话 → 扩展）全部跑在
 *    `setTimeout(bail)` **之前**。任何一步抛错，`shutdown()` 就 reject，而信号处理器
 *    是 `void shutdown()` —— 变成未捕获拒绝，兜底定时器压根没建、`server.close()`
 *    永不调用，**进程永久挂死**，只能等 SIGKILL。也就是说这个「硬退出兜底」恰好
 *    保护不了最可能发生的失败（某个拆解步骤抛错）。
 *    现在兜底**先建**，每一步单独 try/catch，一步失败不影响其余步骤，最后一定走到关闭。
 *
 * 2. **清理路径此前零覆盖。** E2E 全程用 SIGKILL，直接绕过它；而没被跑过的清理代码
 *    等于没有清理。抽成纯函数后可以在任意平台上用替身测（Windows 上 Node 不投递
 *    可捕获的 SIGTERM，真信号路径只能在 POSIX 上测）。
 */

export interface ShutdownStep {
  /** 仅用于日志与失败定位。 */
  name: string;
  run: () => void | Promise<void>;
}

export interface GracefulShutdownOptions {
  /** 有序拆解步骤。逐个执行，单个失败会记日志并继续。 */
  steps: ReadonlyArray<ShutdownStep>;
  /** 关闭 HTTP listener，resolve 表示已真正关闭。 */
  closeServer: () => Promise<void>;
  logger: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
  };
  /** 兜底强退超时（毫秒）。默认 1000。 */
  bailMs?: number;
  /** 退出函数，默认 `process.exit`。测试注入。 */
  exit?: (code: number) => void;
}

/** 把未知异常压成一行文本，避免日志里出现 `[object Object]`。 */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 生成一个幂等的停机函数。重复调用（如 SIGINT 紧跟 SIGTERM）只有第一次生效。
 */
export function createGracefulShutdown(options: GracefulShutdownOptions): () => Promise<void> {
  const { steps, closeServer, logger } = options;
  const bailMs = options.bailMs ?? 1000;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;

  return async function shutdown(): Promise<void> {
    if (started) return;
    started = true;
    logger.info("开始优雅停机");

    // 兜底**先建**：拆解步骤里有任何一步抛错也必须能退出。
    // unref 是刻意的——它不能阻止进程自然退出，只在「有 socket 卡住不放」时才发力，
    // 这正是它存在的意义（同 ApprovalGate 的定时器踩过的坑）。
    let bailed = false;
    let closeFailed = false;
    let bail: ReturnType<typeof setTimeout>;
    const bailFired = new Promise<void>((resolve) => {
      bail = setTimeout(() => {
        bailed = true;
        logger.warn("优雅停机超时，强制退出");
        resolve();
      }, bailMs);
    });
    bail!.unref?.();

    for (const step of steps) {
      try {
        await step.run();
      } catch (err) {
        // 一步失败不该让其余资源漏收：继续跑后面的步骤，把原因留在日志里。
        logger.warn("停机步骤失败，继续", { step: step.name, error: describe(err) });
      }
    }

    // 必须与兜底**竞速**，而不是直接 await：`closeServer` 若永不回调（socket 拒绝关闭），
    // 直接 await 会让本函数永不 resolve。生产中 `process.exit` 会兜住，但只要 exit 被替换
    // （测试、嵌入方的自定义退出）就会永久挂死——这个坑实际踩到过：测试挂住并堆出孤儿进程。
    await Promise.race([
      closeServer().catch((err: unknown) => {
        closeFailed = true;
        logger.warn("关闭 listener 失败，强制退出", { error: describe(err) });
      }),
      bailFired,
    ]);

    clearTimeout(bail!);
    if (!bailed && !closeFailed) logger.info("已停机");
    exit(0);
  };
}
