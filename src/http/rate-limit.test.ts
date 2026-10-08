/**
 * 速率限制的回归测试。
 *
 * 关注两类容易出错的地方：
 *   1. **窗口边界** —— 固定窗口必须在到期后真的重置，否则客户端会被永久锁死；
 *   2. **XFF 伪造** —— 不信任非白名单代理的 X-Forwarded-For，否则限流形同虚设。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedWindowLimiter, clientIp, DEFAULT_RATE_RULES } from "./rate-limit.js";

/** 可控时钟，避免测试真的 sleep。 */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("窗口内超出配额即拒绝，剩余额度递减", () => {
  const clock = fakeClock();
  const limiter = new FixedWindowLimiter({ windowMs: 1000, max: 3 }, clock.now);

  assert.equal(limiter.hit("a").allowed, true);
  assert.equal(limiter.hit("a").allowed, true);
  const third = limiter.hit("a");
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);

  const fourth = limiter.hit("a");
  assert.equal(fourth.allowed, false, "the 4th request in the window must be rejected");
  assert.equal(fourth.remaining, 0, "remaining must never go negative");
});

test("窗口到期后自动重置（否则客户端会被永久锁死）", () => {
  const clock = fakeClock();
  const limiter = new FixedWindowLimiter({ windowMs: 1000, max: 1 }, clock.now);
  assert.equal(limiter.hit("a").allowed, true);
  assert.equal(limiter.hit("a").allowed, false);

  clock.advance(999);
  assert.equal(limiter.hit("a").allowed, false, "still inside the window");

  clock.advance(2); // now past the reset point
  assert.equal(limiter.hit("a").allowed, true, "must recover after the window expires");
});

test("不同 IP 互不影响", () => {
  const clock = fakeClock();
  const limiter = new FixedWindowLimiter({ windowMs: 1000, max: 1 }, clock.now);
  assert.equal(limiter.hit("a").allowed, true);
  assert.equal(limiter.hit("a").allowed, false);
  assert.equal(limiter.hit("b").allowed, true, "a different IP must have its own budget");
});

test("peek 不计数，sweep 回收过期桶", () => {
  const clock = fakeClock();
  const limiter = new FixedWindowLimiter({ windowMs: 1000, max: 5 }, clock.now);
  assert.equal(limiter.peek("a"), 0);
  limiter.hit("a");
  limiter.hit("a");
  assert.equal(limiter.peek("a"), 2);
  assert.equal(limiter.peek("unknown"), 0);

  assert.equal(limiter.size, 1);
  clock.advance(1001);
  assert.equal(limiter.sweep(), 1, "expired bucket must be swept");
  assert.equal(limiter.size, 0, "map must not grow without bound");
});

test("默认不信任 X-Forwarded-For（否则限流可被伪造绕过）", () => {
  const req = {
    headers: { "x-forwarded-for": "1.2.3.4" },
    socket: { remoteAddress: "10.0.0.9" },
    ip: "10.0.0.9",
  } as never;
  // No trusted proxies → the client-controlled header is ignored.
  assert.equal(clientIp(req), "10.0.0.9");
});

test("白名单代理的 XFF 才被采信", () => {
  const req = {
    headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    socket: { remoteAddress: "127.0.0.1" },
    ip: "127.0.0.1",
  } as never;
  assert.equal(clientIp(req, ["127.0.0.1"]), "1.2.3.4", "must take the left-most entry");
  // Same request, untrusted proxy → header ignored.
  assert.equal(clientIp(req, ["10.0.0.1"]), "127.0.0.1");
});

test("缺少 IP 信息时回落为 unknown 而不是抛错", () => {
  const req = { headers: {}, socket: {}, ip: undefined } as never;
  assert.equal(clientIp(req), "unknown");
});

test("默认规则只限重资源端点，探针不限流", () => {
  // Throttling a health check would make orchestrators see spurious failures.
  assert.ok(DEFAULT_RATE_RULES["/chat"], "/chat must be limited");
  assert.ok(DEFAULT_RATE_RULES["/db/query"], "/db/query must be limited");
  assert.equal(DEFAULT_RATE_RULES["/health"], undefined);
  assert.equal(DEFAULT_RATE_RULES["/health/ready"], undefined);
  assert.equal(DEFAULT_RATE_RULES["/metrics"], undefined);
  // /chat costs a full LLM round trip, so it must be the tightest.
  assert.ok(
    DEFAULT_RATE_RULES["/chat"]!.max < DEFAULT_RATE_RULES["/db/query"]!.max,
    "/chat must be stricter than /db/query",
  );
});
