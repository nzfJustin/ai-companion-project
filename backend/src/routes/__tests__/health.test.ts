/**
 * src/routes/__tests__/health.test.ts
 *
 * Unit tests for GET /health.
 * DB and Redis are mocked — no running services required.
 */

// jest.mock calls are hoisted before imports by Babel/ts-jest
jest.mock('../../db', () => ({
  db: { execute: jest.fn() },
}));

jest.mock('../../lib/redis', () => ({
  redis: { ping: jest.fn() },
}));

import request          from 'supertest';
import { app }          from '../../app';
import { db }           from '../../db';
import { redis }        from '../../lib/redis';

// Typed mock handles
const mockExecute = db.execute as jest.MockedFunction<typeof db.execute>;
const mockPing    = redis.ping  as jest.MockedFunction<typeof redis.ping>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dbUp()    { mockExecute.mockResolvedValue([] as never); }
function dbDown()  { mockExecute.mockRejectedValue(new Error('ECONNREFUSED')); }
function redisUp() { mockPing.mockResolvedValue('PONG'); }
function redisDown() { mockPing.mockRejectedValue(new Error('Redis ECONNREFUSED')); }

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => jest.clearAllMocks());

describe('GET /health', () => {
  describe('when DB and Redis are both healthy', () => {
    it('responds 200', async () => {
      dbUp(); redisUp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    });

    it('returns { status: "ok", db: "connected", redis: "connected" }', async () => {
      dbUp(); redisUp();
      const res = await request(app).get('/health');
      expect(res.body).toEqual({
        status: 'ok',
        db:     'connected',
        redis:  'connected',
      });
    });
  });

  describe('when DB is down', () => {
    it('responds 503', async () => {
      dbDown(); redisUp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(503);
    });

    it('returns { status: "degraded", db: "error", redis: "connected" }', async () => {
      dbDown(); redisUp();
      const res = await request(app).get('/health');
      expect(res.body).toEqual({
        status: 'degraded',
        db:     'error',
        redis:  'connected',
      });
    });
  });

  describe('when Redis is down', () => {
    it('responds 503', async () => {
      dbUp(); redisDown();
      const res = await request(app).get('/health');
      expect(res.status).toBe(503);
    });

    it('returns { status: "degraded", db: "connected", redis: "error" }', async () => {
      dbUp(); redisDown();
      const res = await request(app).get('/health');
      expect(res.body).toEqual({
        status: 'degraded',
        db:     'connected',
        redis:  'error',
      });
    });
  });

  describe('when both DB and Redis are down', () => {
    it('responds 503', async () => {
      dbDown(); redisDown();
      const res = await request(app).get('/health');
      expect(res.status).toBe(503);
    });

    it('returns { status: "degraded", db: "error", redis: "error" }', async () => {
      dbDown(); redisDown();
      const res = await request(app).get('/health');
      expect(res.body).toEqual({
        status: 'degraded',
        db:     'error',
        redis:  'error',
      });
    });
  });

  it('returns JSON content-type', async () => {
    dbUp(); redisUp();
    const res = await request(app).get('/health');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('runs both checks concurrently (both failures appear together)', async () => {
    dbDown(); redisDown();
    const res = await request(app).get('/health');
    // Both errors must be present in the same response — not sequentially failing
    expect(res.body.db).toBe('error');
    expect(res.body.redis).toBe('error');
  });
});
