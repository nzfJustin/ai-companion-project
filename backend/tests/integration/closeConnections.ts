/**
 * tests/integration/closeConnections.ts
 *
 * Every integration test file must call this as the LAST step of its
 * top-level afterAll, after its own table cleanup.
 *
 * Jest gives each test file its own module registry, so every integration
 * file that imports src/app creates its own pg Pool (src/db) and its own
 * ioredis client (src/lib/redis, connected by the rate-limit middleware on
 * the first request). Nothing in src/app closes them — only src/index.ts
 * does on SIGTERM — so their sockets kept Jest alive after the run finished
 * ("Jest did not exit one second after the test run has completed").
 *
 * This can't live in a `setupFilesAfterEnv` afterAll: Jest runs that hook
 * BEFORE the test file's own afterAll, which would close the pool before
 * the file's cleanup queries run.
 */

import { closeDb }    from '../../src/db';
import { closeRedis } from '../../src/lib/redis';

export async function closeConnections(): Promise<void> {
  await Promise.all([closeDb(), closeRedis()]);
}
