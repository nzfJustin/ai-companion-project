/**
 * src/routes/__tests__/conversations.integration.test.ts
 *
 * Integration tests for conversation endpoints.
 * Requires a running test database:
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
import { users, authSessions, userContext, conversations } from '../../db/schema';

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

const USER_A_EMAIL = 'conv-integration-a@example.com';
const USER_B_EMAIL = 'conv-integration-b@example.com';
const PASSWORD     = 'testpassword123';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function cleanupUsers() {
  for (const email of [USER_A_EMAIL, USER_B_EMAIL]) {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true },
    });
    if (user) {
      await db.delete(conversations).where(eq(conversations.userId, user.id));
      await db.delete(authSessions).where(eq(authSessions.userId, user.id));
      await db.delete(userContext).where(eq(userContext.userId, user.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  }
}

async function registerAndLogin(email: string): Promise<string> {
  await request(app).post('/v1/auth/register').send({
    email, password: PASSWORD, display_name: 'Test User',
  });
  const res = await request(app).post('/v1/auth/login').send({ email, password: PASSWORD });
  return res.body.access_token as string;
}

beforeEach(async () => { await cleanupUsers(); });
afterAll(async ()  => { await cleanupUsers(); });

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/conversations (integration)', () => {
  it('creates a conversation with status active and returns { id, started_at, status }', async () => {
    const token = await registerAndLogin(USER_A_EMAIL);

    const res = await request(app)
      .post('/v1/conversations')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.started_at).toBeTruthy();
  });

  it('persists the conversation in the database', async () => {
    const token = await registerAndLogin(USER_A_EMAIL);

    const res = await request(app)
      .post('/v1/conversations')
      .set('Authorization', `Bearer ${token}`);

    const saved = await db.query.conversations.findFirst({
      where: eq(conversations.id, res.body.id),
    });

    expect(saved).not.toBeUndefined();
    expect(saved!.status).toBe('active');
  });
});

describe('GET /v1/conversations (integration)', () => {
  it('returns the authenticated user\'s conversations in descending order', async () => {
    const token = await registerAndLogin(USER_A_EMAIL);

    await request(app).post('/v1/conversations').set('Authorization', `Bearer ${token}`);
    await request(app).post('/v1/conversations').set('Authorization', `Bearer ${token}`);

    const res = await request(app)
      .get('/v1/conversations')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(2);
    // Most recent first
    const [first, second] = res.body.conversations;
    expect(new Date(first.started_at).getTime()).toBeGreaterThanOrEqual(
      new Date(second.started_at).getTime(),
    );
  });

  it('does not return another user\'s conversations', async () => {
    const tokenA = await registerAndLogin(USER_A_EMAIL);
    const tokenB = await registerAndLogin(USER_B_EMAIL);

    await request(app).post('/v1/conversations').set('Authorization', `Bearer ${tokenA}`);

    const res = await request(app)
      .get('/v1/conversations')
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.body.conversations).toHaveLength(0);
  });
});

describe('PATCH /v1/conversations/:id (integration)', () => {
  it('closes the conversation and sets ended_at', async () => {
    const token = await registerAndLogin(USER_A_EMAIL);
    const createRes = await request(app)
      .post('/v1/conversations')
      .set('Authorization', `Bearer ${token}`);

    const { id } = createRes.body;

    const patchRes = await request(app)
      .patch(`/v1/conversations/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'closed' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.status).toBe('closed');
    expect(patchRes.body.ended_at).toBeTruthy();

    const saved = await db.query.conversations.findFirst({
      where: eq(conversations.id, id),
    });
    expect(saved!.status).toBe('closed');
    expect(saved!.endedAt).not.toBeNull();
  });

  it('returns 403 FORBIDDEN when another user tries to close the conversation', async () => {
    const tokenA = await registerAndLogin(USER_A_EMAIL);
    const tokenB = await registerAndLogin(USER_B_EMAIL);

    const createRes = await request(app)
      .post('/v1/conversations')
      .set('Authorization', `Bearer ${tokenA}`);

    const { id } = createRes.body;

    const res = await request(app)
      .patch(`/v1/conversations/${id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ status: 'closed' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('returns 403 CONVERSATION_NOT_ACTIVE when conversation is already closed', async () => {
    const token = await registerAndLogin(USER_A_EMAIL);
    const createRes = await request(app)
      .post('/v1/conversations')
      .set('Authorization', `Bearer ${token}`);

    const { id } = createRes.body;

    // Close it once
    await request(app)
      .patch(`/v1/conversations/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'closed' });

    // Try to close it again
    const res = await request(app)
      .patch(`/v1/conversations/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'closed' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CONVERSATION_NOT_ACTIVE');
  });
});

describe('GET /v1/conversations/:id (integration)', () => {
  it('returns conversation metadata with an empty messages array', async () => {
    const token = await registerAndLogin(USER_A_EMAIL);
    const createRes = await request(app)
      .post('/v1/conversations')
      .set('Authorization', `Bearer ${token}`);

    const { id } = createRes.body;

    const res = await request(app)
      .get(`/v1/conversations/${id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.status).toBe('active');
    expect(res.body.messages).toEqual([]);
  });

  it('returns 404 when attempting to fetch another user\'s conversation', async () => {
    const tokenA = await registerAndLogin(USER_A_EMAIL);
    const tokenB = await registerAndLogin(USER_B_EMAIL);

    const createRes = await request(app)
      .post('/v1/conversations')
      .set('Authorization', `Bearer ${tokenA}`);

    const { id } = createRes.body;

    const res = await request(app)
      .get(`/v1/conversations/${id}`)
      .set('Authorization', `Bearer ${tokenB}`);

    // Must be 404, not 403 — must not reveal conversation existence
    expect(res.status).toBe(404);
  });

  it('full lifecycle: create → list → get → close → get', async () => {
    const token = await registerAndLogin(USER_A_EMAIL);

    // Create
    const { body: { id } } = await request(app)
      .post('/v1/conversations')
      .set('Authorization', `Bearer ${token}`);

    // List includes it
    const listRes = await request(app)
      .get('/v1/conversations')
      .set('Authorization', `Bearer ${token}`);
    expect(listRes.body.conversations.some((c: { id: string }) => c.id === id)).toBe(true);

    // Get by ID
    const getRes = await request(app)
      .get(`/v1/conversations/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.body.status).toBe('active');

    // Close
    await request(app)
      .patch(`/v1/conversations/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'closed' });

    // Get after close
    const getAfterClose = await request(app)
      .get(`/v1/conversations/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(getAfterClose.body.status).toBe('closed');
    expect(getAfterClose.body.ended_at).toBeTruthy();
  });
});
