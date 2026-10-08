/**
 * pi-starter · 速率限制
 *
 * `/chat` 会消耗一次完整 LLM 轮次，`/db/query` 会占用数据库连接。两者都是重资源端点，
 * 却没有配额——单个客户端（或脚本）就能把它们打满，进而影响所有其他客户端。
 *
 * 实现：**固定窗口 + 内存令牌桶**，零依赖。理由：
 *   - 本地脚手架不需要跨进程共享配额，内存表够用且零运维；
 *   - 固定窗口比滑动窗口便宜得多，而这里的保护目标是"挡住突发"，不是精确计费；
 *   - 不引 express-rate-limit 等依赖，保持"能自己写的就不引第三方"。
 *
 * 关键设计：
 *   1. **按 (IP, 路由) 二维限流**——`/chat` 可以调得比 `/health` 严得多；
 *   2. **懒清理**，每次访问顺带扫掉过期桶，避免定时器泄漏；
 *   3. **受信任代理白名单**：默认不信任 X-Forwarded-For，否则任何人都能伪造 IP 绕过限流。
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface RateLimitRule {
  /** Window length (ms). */
  windowMs: number;
  /** Requests allowed per window. */
  max: number;
}

export interface RateLimiterOptions {
  /** Route → limit. Routes not listed are unthrottled. */
  rules: Record<string, RateLimitRule>;
  /**
   * Proxies whose X-Forwarded-For may be trusted (e.g. "loopback" for a local nginx).
   * Anything else has its header ignored, because it is client-controlled.
   */
  trustedProxies?: readonly string[];
  /** Called when a request is rejected (for logging/metrics). */
  onLimit?: (info: { path: string; ip: string; limit: RateLimitRule }) => void;
  /** Clock override (tests). */
  now?: () => number;
}

/** Extract client IP, honoring XFF only for trusted proxies. */
export function clientIp(req: Request, trustedProxies: readonly string[] = []): string {
  if (trustedProxies.length > 0) {
    const remote = req.socket.remoteAddress ?? "";
    if (trustedProxies.includes(remote)) {
      const xff = req.headers["x-forwarded-for"];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  // req.ip is the address Express derived from the socket (unspoofable without a proxy).
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/** Per-IP fixed-window counter. Pure and unit-testable. */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly rule: RateLimitRule,
    private readonly now: () => number = Date.now,
  ) {}

  /** Register a hit; returns the state after counting. */
  hit(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = this.now();
    const existing = this.hits.get(key);
    if (!existing || existing.resetAt <= now) {
      const resetAt = now + this.rule.windowMs;
      this.hits.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.rule.max - 1, resetAt };
    }
    existing.count += 1;
    return {
      allowed: existing.count <= this.rule.max,
      remaining: Math.max(0, this.rule.max - existing.count),
      resetAt: existing.resetAt,
    };
  }

  /** Peek without counting. */
  peek(key: string): number {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= this.now()) return 0;
    return entry.count;
  }

  /**
   * Drop expired buckets so the map cannot grow without bound.
   * Called opportunistically — no timer, therefore no leak and no extra wakeups.
   */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) {
        this.hits.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.hits.size;
  }

  reset(): void {
    this.hits.clear();
  }
}

/** Hard cap on tracked (IP, route) pairs, so a spoofed-IP flood cannot exhaust memory. */
const MAX_TRACKED_KEYS = 10_000;

export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const now = options.now ?? Date.now;
  const limiters = new Map<string, FixedWindowLimiter>();
  for (const [path, rule] of Object.entries(options.rules)) {
    limiters.set(path, new FixedWindowLimiter(rule, now));
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const limiter = limiters.get(req.path);
    if (!limiter) return next(); // unlisted route: unthrottled

    // Cheap periodic cleanup — only sweep when the table is getting large.
    if (limiter.size > MAX_TRACKED_KEYS / 2) limiter.sweep();
    // Even after sweeping, an overflow means the map is being flooded; refuse rather than
    // growing without bound. Client gets 429, which is the correct signal anyway.
    if (limiter.size >= MAX_TRACKED_KEYS) {
      res.status(429).json({ error: "请求过于频繁，请稍后重试" });
      return;
    }

    const ip = clientIp(req, options.trustedProxies);
    const result = limiter.hit(ip);
    const rule = options.rules[req.path]!;
    res.setHeader("X-RateLimit-Limit", String(rule.max));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((result.resetAt - now()) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      options.onLimit?.({ path: req.path, ip, limit: rule });
      res.status(429).json({ error: "请求过于频繁，请稍后重试" });
      return;
    }
    next();
  };
}

/**
 * Default rules.
 *
 * `/chat` is by far the most expensive (a full LLM round trip), so it gets the tightest
 * budget. `/db/query` is capped separately. Probes and static reads stay unlimited —
 * throttling a health check would cause orchestrators to see spurious failures.
 */
export const DEFAULT_RATE_RULES: Record<string, RateLimitRule> = {
  "/chat": { windowMs: 60_000, max: 30 },
  "/db/query": { windowMs: 60_000, max: 120 },
  "/model": { windowMs: 60_000, max: 30 },
};
