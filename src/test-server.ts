/**
 * pi-starter · 测试用 HTTP/WS 服务器助手（仅测试引用，不进 dist）
 *
 * 存在的原因是一个真实踩过的坑：早先三处测试各写一遍
 * `await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))`，
 * 而 **listen 的回调签名是 `() => void`，不带错误参数**。于是端口分配失败
 * （EADDRINUSE 等偶发情况）时 Promise 永不 resolve——测试挂住，真正的原因被吞掉，
 * 排查时只能看到后续某个莫名的 "bad port"，根因早就丢了。
 *
 * 这里做三件事：
 *   1. **把listen 的错误接住**，失败时 reject 并带上真实错误码；
 *   2. **失败自动重试**（换端口重来）——端口分配冲突是环境性的，重试一次通常就好了；
 *   3. **关服时强制断开连接**，否则 fetch 的keep-alive 连接会让 `server.close()`
 *      永不回调，测试进程在全部断言通过后仍然不退出（同样踩过）。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface TestServer {
  url: string;
  port: number;
  server: Server;
  /** 关服并强制断开残留连接（幂等）。 */
  close(): Promise<void>;
}

/** 端口分配失败时的重试次数。 */
const LISTEN_ATTEMPTS = 3;

/**
 * 监听一个随机端口，失败自动重试。
 *
 * @param handler Node 请求处理器，或 Express app。
 */
export async function listenTestServer(handler: unknown): Promise<TestServer> {
  return listenExistingServer(createServer(handler as never));
}

/**
 * 同上，但复用调用方已经建好的 server —— WS 需要在 server 上挂 upgrade 监听，
 * 不能由本函数代建。
 */
export async function listenExistingServer(server: Server): Promise<TestServer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < LISTEN_ATTEMPTS; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        // 关键：once('error') 把端口冲突这类异步错误接住，否则只会挂住。
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, "127.0.0.1");
      });
    } catch (err) {
      lastError = err;
      // 换端口重试：同一实例可重复 listen。
      continue;
    }

    const address = server.address() as AddressInfo | null;
    if (!address || typeof address === "string") {
      throw new Error("listenTestServer: 无法取得端口");
    }
    return {
      url: `http://127.0.0.1:${address.port}`,
      port: address.port,
      server,
      close: async () => {
        // 先断连接再 close：fetch 的 keep-alive 连接会让 close 永不回调。
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      },
    };
  }
  const code = (lastError as NodeJS.ErrnoException | undefined)?.code ?? "UNKNOWN";
  throw new Error(`listenTestServer: ${LISTEN_ATTEMPTS} 次尝试均失败（最后错误码 ${code}）`);
}

/**
 * 等条件成立，而不是等固定时长。
 *
 * 同样是踩过的坑：测试里用 `await sleep(300)` 等 WS 消息，单跑稳、全量并发时偶发失败——
 * 因为并行跑十几个文件时 CPU 竞争，消息处理可能超过任何拍脑袋的固定值。
 * 于是「偶尔红」变成了无法复现、无法定位的玄学，只能被当成"和改动无关"跳过。
 *
 * 正确做法是等**结果**：条件一成立立刻返回，通常几毫秒；超时才抛，并如实报告等了多久。
 *
 * @param what 描述在等什么（出错时出现在消息里，便于定位）。
 */
export async function waitFor(
  predicate: () => boolean,
  what = "condition",
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: 等待「${what}」超时（${timeoutMs}ms）`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
