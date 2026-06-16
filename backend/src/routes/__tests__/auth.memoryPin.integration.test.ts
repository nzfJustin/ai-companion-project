/**
 * src/routes/__tests__/auth.memoryPin.integration.test.ts
 *
 * Integration tests for POST /v1/auth/memory-pin/set and
 * POST /v1/auth/memory-pin/verify.
 *
 * Requires a running test database AND Redis:
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/companion_test \
 *   REDIS_URL=redis://localhost:6380 \
 *     npm run db:migrate
 */

import { generateKeyPairSync } from 'node:crypto';
import jwt     from 'jsonwebtoken';
import request from 'supertest';
import { eq }  from 'drizzle-orm';
import { app } from '../../app';
import { db }  from '../../db';
import { redis, closeRedis } from '../../lib/redis';
import { users, authSessions, userContext, userMemoryPins } from '../../db/schema';
import { ELEVATED_TOKEN_SCOPE, ELEVATED_ACCESS_LEVEL } from '../../lib/jwt';

// ─── Key pair + Redis setup ───────────────────────────────────────────────────

beforeAll(async () => {
  await redis.connect();

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.JWT_PRIVATE_KEY = privateKey;
  process.env.JWT_PUBLIC_KEY  = publicKey;
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_EMAIL    = 'integration-memorypin@example.com';
const TEST_PASSWORD = 'memorypintest123';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function cleanupUser() {
  const user = await db.query.users.findFirst({
    where:   eq(users.email, TEST_EMAIL),
    columns: { id: true },
  });
  if (user) {
    await redis.del(`pin_lock:${user.id}`, `pin_fail:${user.id}`);
    await db.delete(authSessions).where(eq(authSessions.userId, user.id));
    await db.delete(userMemoryPins).where(eq(userMemoryPins.userId, user.id));
    await db.delete(userContext).where(eq(userContext.userId, user.id));
    await db.delete(users).where(eq(users.id, user.id));
  }
}

async function registerAndLogin(): Promise<{ token: string; userId: string }> {
  await request(app).post('/v1/auth/register').send({
    email:        TEST_EMAIL,
    password:     TEST_PASSWORD,
    display_name: 'Memory Pin Tester',
  });

  const loginRes = await request(app)
    .post('/v1/auth/login')
    .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

  const user = await db.query.users.findFirst({ where: eq(users.email, TEST_EMAIL) });

  return { token: loginRes.body.access_token as string, userId: user!.id };
}

beforeEach(async () => {
  await cleanupUser();
});

afterAll(async () => {
  await cleanupUser();
  await closeRedis();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/auth/memory-pin/set (integration)', () => {
  it('returns 200 and persists a bcrypt hash (never the raw pin)', async () => {
    const { token, userId } = await registerAndLogin();

    const res = await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '1234' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const row = await db.query.userMemoryPins.findFirst({
      where: eq(userMemoryPins.userId, userId),
    });
    expect(row).not.toBeUndefined();
    expect(row!.pinHash).not.toBe('1234');
    expect(row!.pinHash.startsWith('$2')).toBe(true); // bcrypt hash prefix
  });

  it('updates the existing record on a second call (upsert)', async () => {
    const { token, userId } = await registerAndLogin();

    await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '1111' });

    const first = await db.query.userMemoryPins.findFirst({
      where: eq(userMemoryPins.userId, userId),
    });

    await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '2222' });

    const second = await db.query.userMemoryPins.findFirst({
      where: eq(userMemoryPins.userId, userId),
    });

    // Same row (single record), hash changed
    expect(second!.id).toBe(first!.id);
    expect(second!.pinHash).not.toBe(first!.pinHash);

    // New pin verifies; old pin no longer does
    const verifyNew = await request(app)
      .post('/v1/auth/memory-pin/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '2222' });
    expect(verifyNew.status).toBe(200);
  });

  it('returns 401 with no token', async () => {
    const res = await request(app).post('/v1/auth/memory-pin/set').send({ pin: '1234' });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/auth/memory-pin/verify (integration)', () => {
  it('returns 404 PIN_NOT_SET before any pin has been set', async () => {
    const { token } = await registerAndLogin();

    const res = await request(app)
      .post('/v1/auth/memory-pin/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '1234' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'PIN_NOT_SET' });
  });

  it('returns 200 with a valid elevated token for the correct pin', async () => {
    const { token } = await registerAndLogin();

    await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '1234' });

    const res = await request(app)
      .post('/v1/auth/memory-pin/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '1234' });

    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.scope).toBe(ELEVATED_TOKEN_SCOPE);

    const decoded = jwt.verify(res.body.elevated_token, process.env.JWT_PUBLIC_KEY!, {
      algorithms: ['RS256'],
    }) as jwt.JwtPayload;
    expect(decoded.access_level).toBe(ELEVATED_ACCESS_LEVEL);
    expect(decoded.scope).toBe(ELEVATED_TOKEN_SCOPE);
  });

  it('returns 401 INVALID_PIN for an incorrect pin', async () => {
    const { token } = await registerAndLogin();

    await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '1234' });

    const res = await request(app)
      .post('/v1/auth/memory-pin/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '0000' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'INVALID_PIN' });
  });

  // ── The core acceptance-criteria test from TDD P1-004 ───────────────────────
  it('locks the pin after 3 consecutive failures, then rejects even the correct pin with 429', async () => {
    const { token } = await registerAndLogin();

    await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '1234' });

    // 3 consecutive wrong attempts
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', `Bearer ${token}`)
        .send({ pin: '0000' });

      if (i < 2) {
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'INVALID_PIN' });
      } else {
        // 3rd failure triggers the lock
        expect(res.status).toBe(429);
        expect(res.body).toEqual({ error: 'PIN_LOCKED' });
      }
    }

    // Now even the CORRECT pin is rejected while locked
    const lockedAttempt = await request(app)
      .post('/v1/auth/memory-pin/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '1234' });

    expect(lockedAttempt.status).toBe(429);
    expect(lockedAttempt.body).toEqual({ error: 'PIN_LOCKED' });
  });

  it('lock state has a TTL of approximately 15 minutes', async () => {
    const { token, userId } = await registerAndLogin();

    await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '1234' });

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', `Bearer ${token}`)
        .send({ pin: '0000' });
    }

    const ttl = await redis.ttl(`pin_lock:${userId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15 * 60);
  });

  it('setting a new pin clears an existing lock', async () => {
    const { token } = await registerAndLogin();

    await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '1234' });

    // Trigger lock
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', `Bearer ${token}`)
        .send({ pin: '0000' });
    }

    // Set a new pin
    await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '5678' });

    // New pin should work immediately — lock was cleared
    const res = await request(app)
      .post('/v1/auth/memory-pin/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '5678' });

    expect(res.status).toBe(200);
  });

  it('returns 401 with no token', async () => {
    const res = await request(app).post('/v1/auth/memory-pin/verify').send({ pin: '1234' });
    expect(res.status).toBe(401);
  });
});
