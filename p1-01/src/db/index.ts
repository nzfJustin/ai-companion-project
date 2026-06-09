import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool }    from 'pg';
import * as schema from './schema';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error', err);
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;

/** Graceful shutdown — call this before process.exit() */
export async function closeDb() {
  await pool.end();
}
