/**
 * src/routes/__tests__/auth.refresh.integration.test.ts
 *
 * Integration tests for POST /v1/auth/refresh and POST /v1/auth/logout.
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
import { users, authSessions } from '../../db/schema';
import { REFRESH_COOKIE_NAME, hashRefreshToken } from '../../lib/jwt';

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

const TEST_EMAIL    = 'integration-refresh@example.com';
const TEST_PASSWORD = 'refreshtest123';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the refresh_token value from a Set-Cookie header array. */
function extractRefreshToken(setCookie: string[] | undefined): string {
  const cookie = (setCookie ?? []).find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
  if (!cookie) throw new Error('refresh_token cookie not found in response');
  return cookie.split(';')[0].split('=')[1];
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

async function registerAndLogin(): Promise<string> {
  await request(app).post('/v1/auth/register').send({
    email:        TEST_EMAIL,
    password:     TEST_PASSWORD,
    display_name: 'Refresh Tester',
  });

  const loginRes = await request(app)
    .post('/v1/auth/login')
    .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

  return extractRefreshToken(loginRes.headers['set-cookie'] as unknown as string[]);
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

describe('POST /v1/auth/refresh (integration)', () => {
  it('returns a new access token and rotates the refresh cookie', async () => {
    const token1 = await registerAndLogin();

    const res = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${token1}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      access_token: expect.any(String),
      token_type:   'Bearer',
      expires_in:   900,
    });

    const token2 = extractRefreshToken(res.headers['set-cookie'] as unknown as string[]);
    expect(token2).not.toBe(token1);
  });

  it('preserves the token_family across rotation', async () => {
    const token1 = await registerAndLogin();
    const userId = await getUserId();

    const before = await db.query.authSessions.findFirst({
      where: eq(authSessions.userId, userId),
    });

    const res = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${token1}`);

    const token2 = extractRefreshToken(res.headers['set-cookie'] as unknown as string[]);

    const newSession = await db.query.authSessions.findFirst({
      where: eq(authSessions.refreshToken, hashRefreshToken(token2)),
    });

    expect(newSession!.tokenFamily).toBe(before!.tokenFamily);
  });

  it('revokes the old session row after rotation', async () => {
    const token1 = await registerAndLogin();

    await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${token1}`);

    const oldSession = await db.query.authSessions.findFirst({
      where: eq(authSessions.refreshToken, hashRefreshToken(token1)),
    });

    expect(oldSession!.revokedAt).not.toBeNull();
  });

  // ── The core acceptance-criteria test from TDD P1-003 ───────────────────────
  it('full rotation + reuse flow: reuse of old token revokes the family and the rotated token also fails', async () => {
    // 1. Login → token1
    const token1 = await registerAndLogin();

    // 2. Refresh with token1 → token2 (valid)
    const refresh1 = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${token1}`);
    expect(refresh1.status).toBe(200);
    const token2 = extractRefreshToken(refresh1.headers['set-cookie'] as unknown as string[]);

    // 3. Attempt to REUSE token1 (already consumed) → reuse detected
    const reuseAttempt = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${token1}`);

    expect(reuseAttempt.status).toBe(401);
    expect(reuseAttempt.body).toEqual({ error: 'TOKEN_REUSE_DETECTED' });

    // 4. token2 — though never itself reused — must ALSO now fail,
    //    because the entire family was revoked in step 3.
    const secondTokenAttempt = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${token2}`);

    expect(secondTokenAttempt.status).toBe(401);
    expect(secondTokenAttempt.body.error).toMatch(/TOKEN_REUSE_DETECTED|TOKEN_EXPIRED/);
  });

  it('returns 401 TOKEN_EXPIRED for a garbage token', async () => {
    const res = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=not-a-real-token`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'TOKEN_EXPIRED' });
  });

  it('returns 401 TOKEN_EXPIRED when no cookie is sent', async () => {
    const res = await request(app).post('/v1/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'TOKEN_EXPIRED' });
  });

  it('returns 401 TOKEN_EXPIRED for an expired session', async () => {
    const token1 = await registerAndLogin();
    const userId = await getUserId();

    // Manually expire the session
    await db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSessions.userId, userId));

    const res = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${token1}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'TOKEN_EXPIRED' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/auth/logout (integration)', () => {
  it('returns 200 and revokes the session', async () => {
    const token1 = await registerAndLogin();

    const res = await request(app)
      .post('/v1/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${token1}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const session = await db.query.authSessions.findFirst({
      where: eq(authSessions.refreshToken, hashRefreshToken(token1)),
    });
    expect(session!.revokedAt).not.toBeNull();
  });

  it('sets Set-Cookie with Max-Age=0', async () => {
    const token1 = await registerAndLogin();

    const res = await request(app)
      .post('/v1/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${token1}`);

    const cookies: string[] = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const rtCookie = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
    expect(rtCookie).toMatch(/Max-Age=0/i);
  });

  it('a logged-out token cannot be used to refresh', async () => {
    const token1 = await registerAndLogin();

    await request(app)
      .post('/v1/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${token1}`);

    const res = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${token1}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/TOKEN_REUSE_DETECTED|TOKEN_EXPIRED/);
  });

  it('returns 401 TOKEN_EXPIRED when no cookie is sent', async () => {
    const res = await request(app).post('/v1/auth/logout');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'TOKEN_EXPIRED' });
  });
});
