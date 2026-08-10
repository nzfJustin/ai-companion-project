import 'dotenv/config';
import { validateEnv }  from './config/env';
import { app }          from './app';
import { closeDb }      from './db';
import { closeRedis }   from './lib/redis';
import PgBoss           from 'pg-boss';
import { startJobQueue } from './jobs';
import { setJobQueue }   from './routes/v1/conversations.router';

validateEnv();

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const boss = new PgBoss(process.env.DATABASE_URL_DIRECT!);

boss.on('error', (err) => console.error('[pg-boss] error', err));

boss.start().then(() => {
  setJobQueue(boss);
  startJobQueue(boss);
  console.log('[pg-boss] job queue started');
}).catch((err) => {
  console.error('[pg-boss] failed to start', err);
});

const server = app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT} (${process.env.NODE_ENV ?? 'development'})`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[server] ${signal} received — shutting down gracefully`);
  server.close(async () => {
    await Promise.allSettled([closeDb(), closeRedis(), boss.stop()]);
    console.log('[server] shut down complete');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[server] forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));