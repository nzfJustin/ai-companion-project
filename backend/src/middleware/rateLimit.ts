/**
 * src/middleware/rateLimit.ts
 *
 * Redis-backed sliding window rate limiter (TDD P1-021 / sprint P1-16).
 *
 * Algorithm — sorted set per user:
 *   Each request is stored as a member of a Redis sorted set, scored by its
 *   timestamp.  On every request we atomically:
 *     1. Remove all entries older than (now - windowMs)
 *     2. Count remaining entries
 *     3. If count ≥ max → reject with 429
 *     4. Otherwise → add the new entry and refresh the key TTL
 *
 *   A Lua script makes all four steps atomic so there are no race conditions
 *   even under concurrent load from the same user.
 *
 * Two pre-configured limiters are exported:
 *   globalRateLimit — 60 req/min across all authenticated endpoints
 *   aiRateLimit     — 20 req/min for POST /v1/conversations/:id/messages
 *
 * Fail-open policy:
 *   If Redis is unavailable the middleware logs a warn and lets the request
 *   through.  This prevents a Redis outage from taking down the API, at the
 *   cost of temporarily disabling per-user rate limits.
 */

import { randomUUID }  from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { redis }       from '../lib/redis';
import { AppError }    from '../lib/errors';

// ─── Lua script ───────────────────────────────────────────────────────────────
//
// KEYS[1] — the sorted-set key (e.g. "rl:global:user-uuid")
// ARGV[1] — current timestamp in milliseconds
// ARGV[2] — window start = now - windowMs
// ARGV[3] — max requests per window
// ARGV[4] — window duration in SECONDS (for EXPIRE)
// ARGV[5] — unique member string (prevents collision at the same millisecond)
//
// Returns array [allowed, oldest_ts_ms]:
//   allowed = 1  → request is within limit
//   allowed = 0  → rate limited; oldest_ts_ms is the score of the oldest entry

const SLIDING_WINDOW_SCRIPT = `
local key          = KEYS[1]
local now          = tonumber(ARGV[1])
local window_start = tonumber(ARGV[2])
local max_req      = tonumber(ARGV[3])
local window_sec   = tonumber(ARGV[4])
local member       = ARGV[5]

-- 1. Evict expired entries
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- 2. Count requests currently in the window
local count = redis.call('ZCARD', key)

-- 3. Rate-limited: return the timestamp of the oldest entry so the caller
--    can compute Retry-After precisely.
if count >= max_req then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if #oldest >= 2 then
    return {0, tonumber(oldest[2])}
  end
  return {0, now}
end

-- 4. Allow: record this request and refresh the key TTL
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, window_sec + 1)

return {1, 0}
`.trim();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RateLimitOptions {
  /** Window duration in milliseconds */
  windowMs:   number;
  /** Maximum requests per window */
  max:        number;
  /**
   * Redis key prefix.  The full key is `<prefix>:<userId>`.
   * Use different prefixes to maintain independent counters per limiter.
   */
  keyPrefix?: string;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates an Express middleware that rate-limits authenticated requests
 * using a sliding window algorithm backed by Redis.
 *
 * Unauthenticated requests (`req.userId` not set) pass through unchanged —
 * always apply this middleware AFTER `authenticate`.
 */
export function createRateLimit(opts: RateLimitOptions) {
  const { windowMs, max, keyPrefix = 'rl' } = opts;
  const windowSec = Math.ceil(windowMs / 1000);

  return async function rateLimitMiddleware(
    req:  Request,
    res:  Response,
    next: NextFunction,
  ): Promise<void> {
    // No userId → request is unauthenticated; skip (this limiter is per-user)
    if (!req.userId) return next();

    const now         = Date.now();
    const windowStart = now - windowMs;
    const key         = `${keyPrefix}:${req.userId}`;
    const member      = `${now}:${randomUUID()}`;

    try {
      const result = await redis.eval(
        SLIDING_WINDOW_SCRIPT,
        1,                     // number of KEYS
        key,                   // KEYS[1]
        now.toString(),        // ARGV[1]
        windowStart.toString(),// ARGV[2]
        max.toString(),        // ARGV[3]
        windowSec.toString(),  // ARGV[4]
        member,                // ARGV[5]
      ) as [number, number];

      const [allowed, oldestTs] = result;

      if (!allowed) {
        // Time at which the oldest request in the window will expire
        const resetAtMs  = oldestTs + windowMs;
        const retryAfter = Math.max(1, Math.ceil((resetAtMs - now) / 1000));
        const resetEpoch = Math.ceil(resetAtMs / 1000);

        res.setHeader('Retry-After',      String(retryAfter));
        res.setHeader('X-RateLimit-Reset', String(resetEpoch));

        return next(new AppError(429, 'RATE_LIMITED'));
      }

      return next();
    } catch (err) {
      // Redis unavailable — fail open so a Redis outage doesn't take down the API
      console.warn(
        JSON.stringify({
          event:   'rate_limit_redis_miss',
          user_id: req.userId,
          error:   err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
      return next();
    }
  };
}

// ─── Pre-configured instances ─────────────────────────────────────────────────

/**
 * Global rate limiter: 60 requests per minute per authenticated user.
 * Apply to all authenticated routes via router.use() or route middleware.
 */
export const globalRateLimit = createRateLimit({
  windowMs:  60_000,
  max:       60,
  keyPrefix: 'rl:global',
});

/**
 * AI rate limiter: 20 requests per minute per user.
 * Apply to POST /v1/conversations/:id/messages in addition to globalRateLimit.
 * This stricter limit protects LLM inference costs.
 */
export const aiRateLimit = createRateLimit({
  windowMs:  60_000,
  max:       20,
  keyPrefix: 'rl:ai',
});
