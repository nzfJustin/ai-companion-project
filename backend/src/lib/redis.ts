/**
 * src/lib/redis.ts
 *
 * Shared ioredis client.  Uses lazyConnect so the socket isn't opened
 * until the first command — this keeps unit tests fast (no connection
 * attempt) and lets the health check report 'error' cleanly if Redis
 * isn't reachable.
 */

import Redis from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  lazyConnect:          true,
  maxRetriesPerRequest: 1,   // fail fast — don't block the health check
  enableOfflineQueue:   false,
  connectTimeout:       3000,
});

redis.on('error', (err: Error) => {
  // Non-fatal: logged here so the health check can report 'degraded'
  // without crashing the process.
  console.error('[redis] connection error:', err.message);
});

/** Graceful shutdown — call before process.exit() */
export async function closeRedis(): Promise<void> {
  await redis.quit();
}
