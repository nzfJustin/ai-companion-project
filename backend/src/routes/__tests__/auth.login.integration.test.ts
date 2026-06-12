/**
 * src/routes/__tests__/auth.login.integration.test.ts
 *
 * Integration tests for POST /v1/auth/login.
 * Requires a running test database with migrations applied:
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/companion_test \
 *     npm run db:migrate
 */

import { generateKeyPairSync } from 'node:crypto';
import request    from 'supertest';
import jwt        from 'jsonwebtoken';
import { eq }     from 'drizzle-orm';
import { app }    from '../../app';
import { db }     from '../../db';
import { users, authSessions } from '../../db/schema';
import { REFRESH_COOKIE_NAME } from '../../lib/jwt';

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

const TEST_EMAIL    = 'integration-login@example.com';
const TEST_PASSWORD = 'logintest123';

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function seedUser() {
  // Use the register endpoint so we test the real bcrypt hash flow
  await request(app).post('/v1/auth/register').send({
    email:        TEST_EMAIL,
    password:     TEST_PASSWORD,
    display_name: 'Login Tester',
  });
}

async function cleanupUser() {
  const user = await db.query.users.findFirst({
    where:   eq(users.email, TEST_EMAIL),
    columns: { id: true },
  });
  if (user) {
    await db.delete(authSessions).where(eq(authSessions.userId, user.id));
    await db.delete(users).where(eq(users.id, user.id));
  }
}

beforeEach(async () => {
  await cleanupUser();
  await seedUser();
});

afterAll(async () => {
  await cleanupUser();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/auth/login (integration)', () => {
  it('returns 200 with access_token, token_type, and expires_in', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      access_token: expect.any(String),
      token_type:   'Bearer',
      expires_in:   900,
    });
  });

  it('access_token is a valid RS256 JWT with user id as sub', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    const payload = jwt.verify(
      res.body.access_token,
      process.env.JWT_PUBLIC_KEY!,
      { algorithms: ['RS256'] },
    ) as jwt.JwtPayload;

    // sub should be the user's UUID
    expect(payload.sub).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets HttpOnly refresh_token cookie scoped to /v1/auth', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const rtCookie = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));

    expect(rtCookie).toBeDefined();
    expect(rtCookie).toMatch(/HttpOnly/i);
    expect(rtCookie).toMatch(/Path=\/v1\/auth/i);
    expect(rtCookie).toMatch(/SameSite=Strict/i);
  });

  it('persists a session row in auth_sessions', async () => {
    await request(app)
      .post('/v1/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    const user = await db.query.users.findFirst({
      where: eq(users.email, TEST_EMAIL),
    });

    const session = await db.query.authSessions.findFirst({
      where: eq(authSessions.userId, user!.id),
    });

    expect(session).not.toBeUndefined();
    expect(session!.tokenFamily).toBeTruthy();
    expect(session!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns 401 INVALID_CREDENTIALS for wrong password', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: TEST_EMAIL, password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'INVALID_CREDENTIALS' });
  });

  it('returns 401 INVALID_CREDENTIALS for unknown email', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'nobody@example.com', password: TEST_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'INVALID_CREDENTIALS' });
  });

  it('is case-insensitive for email lookup', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: TEST_EMAIL.toUpperCase(), password: TEST_PASSWORD });

    expect(res.status).toBe(200);
  });
});
