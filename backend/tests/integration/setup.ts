/**
 * tests/integration/setup.ts
 *
 * Loaded by Jest before every test file (wired in via `setupFiles` in
 * package.json's jest config) — see the note below on why that has to be
 * global rather than scoped to just the integration suite.
 *
 * Sets environment variables for the test Postgres + Redis instances
 * started by docker-compose.test.yml (ports 5433 and 6380).
 */

// src/app.ts (imported directly by every test — unit and integration alike)
// never loads dotenv itself; only src/index.ts and src/db/migrate.ts do. Load
// it here so APP_SECRET, JWT_PRIVATE_KEY, etc. from .env are available —
// EncryptionService throws without a real APP_SECRET, and integration tests
// exercise it for real (message + memory encryption/decryption).
import 'dotenv/config';

// Test database (port 5433 from docker-compose.test.yml).
// Unconditional, NOT `??=` — .env's own DATABASE_URL points at the
// development database (port 5432), and dotenv.config() above already set
// process.env.DATABASE_URL from it by the time this line runs. A `??=`
// here would silently keep that dev URL, and truncateAll() in the
// integration suite would then be deleting rows from the dev database.
process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/companion_test';

// Test Redis (port 6380 from docker-compose.test.yml) — same reasoning.
process.env.REDIS_URL = 'redis://localhost:6380';

process.env.NODE_ENV = 'test';

// Never hit the real Anthropic API from a test run. There's no NODE_ENV
// branch in src/ai/instance.ts that swaps in a mock provider automatically —
// the integration suite calls conversations.router.ts's exported
// setOrchestrator() itself to inject MockLLMProvider. This key only needs
// to exist so nothing throws on missing-env-var before that injection runs.
process.env.ANTHROPIC_API_KEY ??= 'test-key-will-not-be-called';
