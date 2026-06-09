-- migrations/post_migrate_vector_index.sql
--
-- Creates the IVFFlat cosine-similarity index on memories.embedding.
--
-- ⚠️  DO NOT run this during the initial empty-DB setup.
--     IVFFlat requires at least (lists × 1) rows to train; with lists=100
--     you need ≥ 1,000 rows for a useful index. Run this once you have
--     real data (typically end of P2 beta).
--
-- Run via:
--   psql $DATABASE_URL -f src/db/migrations/post_migrate_vector_index.sql
--
-- This is a CONCURRENT build — it does NOT lock the table.

SET maintenance_work_mem = '256MB';

CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_embedding_cosine_idx
  ON memories
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
