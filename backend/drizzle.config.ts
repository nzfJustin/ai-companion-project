import 'dotenv/config';
import type { Config } from 'drizzle-kit';

export default {
  schema:  './src/db/schema.ts',
  out:     './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  /** Print the SQL that would be applied without running it */
  verbose: true,
  /** Require explicit confirmation for destructive changes */
  strict:  true,
} satisfies Config;
