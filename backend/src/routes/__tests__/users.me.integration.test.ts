/**
 * src/routes/__tests__/users.me.integration.test.ts
 *
 * Integration tests for GET/PATCH /v1/users/me.
 * Requires a running test database with migrations applied:
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/companion_test \
 *     npm run db:migrate
 */

import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { eq }  from 'drizzle-orm';
import { app } from '../../app';
import { db }  from '../../db';
import { users, authSessions, userContext } from '../../db/schema';

// ─── Key pair setup ───────────────────────────────────────────────────────────

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.JWT_PRIVATE_KEY = privateKey;
  process.env.JWT_PUBLIC_KEY  = publicKey;
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_EMAIL    = 'integration-usersme@example.com';
const TEST_PASSWORD = 'usersmetest123';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function cleanupUser() {
  const user = await db.query.users.findFirst({
    where:   eq(users.email, TEST_EMAIL),
    columns: { id: true },
  });
  if (user) {
    await db.delete(authSessions).where(eq(authSessions.userId, user.id));
    await db.delete(userContext).where(eq(userContext.userId, user.id));
    await db.delete(users).where(eq(users.id, user.id));
  }
}

/** Registers + logs in a fresh user, returns the access token. */
async function registerAndLogin(): Promise<string> {
  await request(app).post('/v1/auth/register').send({
    email:        TEST_EMAIL,
    password:     TEST_PASSWORD,
    display_name: 'Users Me Tester',
  });

  const loginRes = await request(app)
    .post('/v1/auth/login')
    .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

  return loginRes.body.access_token as string;
}

async function getUserId(): Promise<string> {
  const user = await db.query.users.findFirst({ where: eq(users.email, TEST_EMAIL) });
  return user!.id;
}

beforeEach(async () => {
  await cleanupUser();
});

afterAll(async () => {
  await cleanupUser();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/users/me (integration)', () => {
  it('returns the user profile with the expected shape', async () => {
    const token = await registerAndLogin();

    const res = await request(app)
      .get('/v1/users/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id:              expect.stringMatching(/^[0-9a-f-]{36}$/),
      email:           TEST_EMAIL,
      display_name:    'Users Me Tester',
      timezone:        'UTC',
      comm_style:      'warm',
      onboarding_done: false,
    });
    expect(res.body.created_at).toBeTruthy();
  });

  it('does not return password_hash or other internal fields', async () => {
    const token = await registerAndLogin();
    const res = await request(app).get('/v1/users/me').set('Authorization', `Bearer ${token}`);
    expect(res.body).not.toHaveProperty('password_hash');
    expect(res.body).not.toHaveProperty('passwordHash');
    expect(res.body).not.toHaveProperty('deleted_at');
  });

  it('returns 401 with no token', async () => {
    const res = await request(app).get('/v1/users/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
  });

  // ── TDD P1-005: user_context seeded on registration ──────────────────────────
  it('seeds an empty user_context row on registration', async () => {
    await registerAndLogin();
    const userId = await getUserId();

    const ctx = await db.query.userContext.findFirst({
      where: eq(userContext.userId, userId),
    });

    expect(ctx).not.toBeUndefined();
    expect(ctx!.contextSummary).toBeNull();
    expect(ctx!.statedGoals).toEqual([]);
    expect(ctx!.sessionCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /v1/users/me (integration)', () => {
  it('updates display_name, timezone, and comm_style together', async () => {
    const token = await registerAndLogin();

    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ display_name: 'New Name', timezone: 'Asia/Tokyo', comm_style: 'direct' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      display_name: 'New Name',
      timezone:      'Asia/Tokyo',
      comm_style:    'direct',
    });

    // Persisted
    const getRes = await request(app).get('/v1/users/me').set('Authorization', `Bearer ${token}`);
    expect(getRes.body).toMatchObject({
      display_name: 'New Name',
      timezone:      'Asia/Tokyo',
      comm_style:    'direct',
    });
  });

  it('returns 400 INVALID_COMM_STYLE for an invalid comm_style and does not persist it', async () => {
    const token = await registerAndLogin();

    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ comm_style: 'not-a-real-style' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'INVALID_COMM_STYLE' });

    const getRes = await request(app).get('/v1/users/me').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.comm_style).toBe('warm'); // unchanged default
  });

  it('silently ignores unknown fields like { role: "admin" } without altering the record', async () => {
    const token = await registerAndLogin();

    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'admin', display_name: 'Still Me' });

    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Still Me'); // known field still applied
    expect(res.body).not.toHaveProperty('role');
  });

  it('cannot set onboarding_done directly', async () => {
    const token = await registerAndLogin();

    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ onboarding_done: true });

    expect(res.status).toBe(200);
    expect(res.body.onboarding_done).toBe(false);

    const userId = await getUserId();
    const dbUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(dbUser!.onboardingDone).toBe(false);
  });

  it('returns 401 with no token', async () => {
    const res = await request(app).patch('/v1/users/me').send({ display_name: 'X' });
    expect(res.status).toBe(401);
  });
});
