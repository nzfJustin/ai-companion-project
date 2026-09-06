/**
 * src/index.ts
 *
 * Entry point.  Validates required env vars, then starts the HTTP server.
 * Run with: npm run dev   (tsx watch)
 *       or: npm start     (compiled JS)
 */
import 'dotenv/config';
import PgBoss            from 'pg-boss';
import { validateEnv }   from './config/env';
import { app }           from './app';
import { closeDb }       from './db';
import { closeRedis }    from './lib/redis';
import { startJobQueue } from './jobs';
import { setJobQueue }   from './routes/v1/conversations.router';
import { startExtractionSweep, stopExtractionSweep } from './jobs/extractionSweep';

// Fail immediately if required vars are missing — before any I/O
validateEnv();

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── pg-boss job queue ─────────────────────────────────────────────────────────
const boss = new PgBoss(process.env.DATABASE_URL_DIRECT!);

boss.on('error', (err: Error) => console.error('[pg-boss] error', err));

// boss.start() only opens the connection and runs pg-boss's own internal
// migrations — it does NOT create the app's queues or register the worker.
// startJobQueue() does that (boss.createQueue() + boss.work()), and those
// are async too. Previously setJobQueue(boss) ran as soon as boss.start()
// resolved, without waiting for startJobQueue() to finish, and app.listen()
// didn't wait on any of this — so the server could accept a conversation
// close (and call boss.send()) before the 'memory_extraction' queue row
// existed in Postgres. pg-boss's send() doesn't throw in that case, it
// just resolves with null (see the added check in jobs/index.ts), so the
// job was silently dropped: no error, no retry, no trace — the
// conversation stayed 'closed' forever and no memory was ever extracted.
//
// Fix: don't call setJobQueue() (which makes route handlers start sending
// jobs) and don't start accepting HTTP traffic until the whole chain —
// boss.start() → startJobQueue()'s createQueue()/work() calls — has
// actually completed.
let server: ReturnType<typeof app.listen> | undefined;

async function start(): Promise<void> {
  // Memory extraction no longer depends on pg-boss at all (see
  // jobs/extractionSweep.ts) — start it unconditionally and first, so a
  // pg-boss outage (which still runs inactivity_close) can never take
  // memory generation down with it.
  startExtractionSweep();

  try {
    await boss.start();
    await startJobQueue(boss);
    setJobQueue(boss);
    console.log('[pg-boss] job queue started');
  } catch (err) {
    // Memory extraction is unaffected (see startExtractionSweep() above) —
    // this only takes down inactivity_close. Still a production incident
    // worth surfacing loudly, not booting past quietly.
    console.error('[pg-boss] failed to start — inactivity auto-close will not run', err);
  }

  // ── HTTP server ─────────────────────────────────────────────────────────────
  server = app.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT} (${process.env.NODE_ENV ?? 'development'})`);
  });
}

void start();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  console.log(`[server] ${signal} received — shutting down gracefully`);
  stopExtractionSweep();

  // A signal arriving during the brief pg-boss-setup window (before
  // app.listen() has run) would otherwise throw on server.close(). Fall
  // straight through to closing the shared resources in that case.
  if (!server) {
    await Promise.allSettled([closeDb(), closeRedis(), boss.stop()]);
    process.exit(0);
    return;
  }

  server.close(async () => {
    await Promise.allSettled([closeDb(), closeRedis(), boss.stop()]);
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
