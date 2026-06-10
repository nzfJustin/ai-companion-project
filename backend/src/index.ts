/**
 * src/index.ts
 *
 * Entry point.  Validates required env vars, then starts the HTTP server.
 * Run with: npm run dev   (tsx watch)
 *       or: npm start     (compiled JS)
 */

import 'dotenv/config';
import { validateEnv }  from './config/env';
import { app }          from './app';
import { closeDb }      from './db';
import { closeRedis }   from './lib/redis';

// Fail immediately if required vars are missing — before any I/O
validateEnv();

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const server = app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT} (${process.env.NODE_ENV ?? 'development'})`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`[server] ${signal} received — shutting down gracefully`);

  server.close(async () => {
    await Promise.allSettled([closeDb(), closeRedis()]);
    console.log('[server] shut down complete');
    process.exit(0);
  });

  // Force-exit after 10 s if something is stuck
  setTimeout(() => {
    console.error('[server] forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
