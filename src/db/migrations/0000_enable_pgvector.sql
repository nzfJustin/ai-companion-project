-- migrations/0000_enable_pgvector.sql
--
-- MUST be applied BEFORE drizzle-kit generates the main schema migration.
-- Run once per database (dev and test):
--
--   psql $DATABASE_URL -f src/db/migrations/0000_enable_pgvector.sql
--
-- The vector extension is provided by the pgvector/pgvector:pg16 image;
-- no separate apt/brew install is needed inside Docker.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- backup for uuid_generate_v4()
