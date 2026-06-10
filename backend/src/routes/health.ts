/**
 * src/routes/health.ts
 *
 * GET /health
 *
 * Checks DB and Redis connectivity.
 * Returns 200 when both are healthy, 503 when either is degraded.
 *
 * Response shape:
 *   { status: "ok" | "degraded", db: "connected" | "error", redis: "connected" | "error" }
 */

import { Router }  from 'express';
import type { Request, Response } from 'express';
import { sql }     from 'drizzle-orm';
import { db }      from '../db';
import { redis }   from '../lib/redis';

export const healthRouter = Router();

type CheckResult = 'connected' | 'error';

healthRouter.get('/', async (_req: Request, res: Response) => {
  const result: { db: CheckResult; redis: CheckResult } = {
    db:    'error',
    redis: 'error',
  };

  // Run both checks concurrently — don't let one block the other
  await Promise.allSettled([
    db.execute(sql`SELECT 1`).then(() => {
      result.db = 'connected';
    }),
    redis.ping().then(() => {
      result.redis = 'connected';
    }),
  ]);

  const healthy = result.db === 'connected' && result.redis === 'connected';

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    db:     result.db,
    redis:  result.redis,
  });
});
