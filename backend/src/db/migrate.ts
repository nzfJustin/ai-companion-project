/**
 * src/db/migrate.ts
 *
 * Standalone migration runner.
 * Run via: npx tsx src/db/migrate.ts
 * Or via:  npm run db:migrate
 */

import 'dotenv/config';
import path from 'path';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, closeDb } from './index';

async function main() {
  console.log('[migrate] Running migrations…');

  // Extensions must be created outside a transaction
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await pool.end();

  await migrate(db, {
    migrationsFolder: path.join(__dirname, 'migrations'),
  });

  console.log('[migrate] All migrations applied successfully.');
  await closeDb();
  process.exit(0);
}

main().catch((err) => {
  console.error('[migrate] Migration failed:', err);
  process.exit(1);
});
