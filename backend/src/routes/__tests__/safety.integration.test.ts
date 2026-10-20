/**
 * src/routes/__tests__/safety.integration.test.ts
 *
 * Integration tests for the #66 AI-safety endpoints, against the real test
 * DB (see tests/integration/setup.ts):
 *   POST /v1/users/me/consent
 *   POST /v1/conversations/:id/messages/:messageId/report
 */

import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { app } from '../../app';
import { db }  from '../../db';
import {
  users, authSessions, userContext, conversations, messages, messageReports,
} from '../../db/schema';

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.JWT_PRIVATE_KEY = privateKey;
  process.env.JWT_PUBLIC_KEY  = publicKey;
});

const USER_A_EMAIL = 'safety-integration-a@example.com';
const USER_B_EMAIL = 'safety-integration-b@example.com';
const PASSWORD     = 'testpassword123';

async function cleanupUsers() {
  for (const email of [USER_A_EMAIL, USER_B_EMAIL]) {
    const user = await db.query.users.findFirst({ where: eq(users.email, email), columns: { id: true } });
    if (user) {
      await db.delete(messageReports).where(eq(messageReports.userId, user.id));
      await db.delete(conversations).where(eq(conversations.userId, user.id));
      await db.delete(authSessions).where(eq(authSessions.userId, user.id));
      await db.delete(userContext).where(eq(userContext.userId, user.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  }
}

async function registerAndLogin(email: string): Promise<{ token: string; userId: string }> {
  await request(app).post('/v1/auth/register').send({ email, password: PASSWORD, display_name: 'Test User' });
  const res = await request(app).post('/v1/auth/login').send({ email, password: PASSWORD });
  const user = await db.query.users.findFirst({ where: eq(users.email, email), columns: { id: true } });
  return { token: res.body.access_token as string, userId: user!.id };
}

/** Creates a conversation with one user message and one AI reply (content is opaque bytes — the report path never decrypts). */
async function seedConversation(token: string, userId: string) {
  const conv = await request(app).post('/v1/conversations').set('Authorization', `Bearer ${token}`);
  const convId = conv.body.id as string;
  const [userMsg] = await db.insert(messages).values({
    conversationId: convId, userId, role: 'user', content: Buffer.from('x'), contentIv: Buffer.from('iv'),
  }).returning({ id: messages.id });
  const [aiMsg] = await db.insert(messages).values({
    conversationId: convId, userId, role: 'assistant', content: Buffer.from('y'), contentIv: Buffer.from('iv'),
  }).returning({ id: messages.id });
  return { convId, userMsgId: userMsg.id, aiMsgId: aiMsg.id };
}

beforeEach(async () => { await cleanupUsers(); });
afterAll(async ()  => { await cleanupUsers(); });

// ── Consent ───────────────────────────────────────────────────────────────────

describe('POST /v1/users/me/consent (integration)', () => {
  it('a new user has no consent recorded', async () => {
    const { token } = await registerAndLogin(USER_A_EMAIL);
    const me = await request(app).get('/v1/users/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.ai_consent_at).toBeNull();
    expect(me.body.ai_consent_version).toBeNull();
  });

  it('records the timestamp and version, and GET /me returns them', async () => {
    const { token, userId } = await registerAndLogin(USER_A_EMAIL);
    const before = Date.now();

    const res = await request(app)
      .post('/v1/users/me/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ version: '2026-10-19' });

    expect(res.status).toBe(200);
    expect(res.body.ai_consent_version).toBe('2026-10-19');
    expect(new Date(res.body.ai_consent_at).getTime()).toBeGreaterThanOrEqual(before - 1000);

    const row = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(row!.aiConsentVersion).toBe('2026-10-19');
    expect(row!.aiConsentAt).not.toBeNull();

    const me = await request(app).get('/v1/users/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.ai_consent_version).toBe('2026-10-19');
  });

  it('re-consenting to a new version replaces the old one', async () => {
    const { token } = await registerAndLogin(USER_A_EMAIL);
    await request(app).post('/v1/users/me/consent').set('Authorization', `Bearer ${token}`).send({ version: 'v1' });
    const res = await request(app).post('/v1/users/me/consent').set('Authorization', `Bearer ${token}`).send({ version: 'v2' });
    expect(res.body.ai_consent_version).toBe('v2');
  });

  it('rejects a missing version with 400', async () => {
    const { token } = await registerAndLogin(USER_A_EMAIL);
    const res = await request(app).post('/v1/users/me/consent').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/v1/users/me/consent').send({ version: 'v1' });
    expect(res.status).toBe(401);
  });
});

// ── Reports ───────────────────────────────────────────────────────────────────

describe('POST /v1/conversations/:id/messages/:messageId/report (integration)', () => {
  const reportUrl = (convId: string, msgId: string) => `/v1/conversations/${convId}/messages/${msgId}/report`;

  it('stores a report for an AI reply and returns 201', async () => {
    const { token, userId } = await registerAndLogin(USER_A_EMAIL);
    const { convId, aiMsgId } = await seedConversation(token, userId);

    const res = await request(app).post(reportUrl(convId, aiMsgId))
      .set('Authorization', `Bearer ${token}`).send({ reason: 'harmful' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ reported: true });
    const rows = await db.select().from(messageReports)
      .where(and(eq(messageReports.userId, userId), eq(messageReports.messageId, aiMsgId)));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('harmful');
  });

  it('reporting the same message twice is idempotent (200, one row)', async () => {
    const { token, userId } = await registerAndLogin(USER_A_EMAIL);
    const { convId, aiMsgId } = await seedConversation(token, userId);

    await request(app).post(reportUrl(convId, aiMsgId)).set('Authorization', `Bearer ${token}`).send({ reason: 'harmful' });
    const res = await request(app).post(reportUrl(convId, aiMsgId)).set('Authorization', `Bearer ${token}`).send({ reason: 'other' });

    expect(res.status).toBe(200);
    const rows = await db.select().from(messageReports).where(eq(messageReports.messageId, aiMsgId));
    expect(rows).toHaveLength(1);
  });

  it('rejects reporting the user\'s own message with 400', async () => {
    const { token, userId } = await registerAndLogin(USER_A_EMAIL);
    const { convId, userMsgId } = await seedConversation(token, userId);
    const res = await request(app).post(reportUrl(convId, userMsgId))
      .set('Authorization', `Bearer ${token}`).send({ reason: 'other' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'ONLY_AI_MESSAGES_REPORTABLE' });
  });

  it('returns 404 when another user tries to report the message', async () => {
    const a = await registerAndLogin(USER_A_EMAIL);
    const b = await registerAndLogin(USER_B_EMAIL);
    const { convId, aiMsgId } = await seedConversation(a.token, a.userId);

    const res = await request(app).post(reportUrl(convId, aiMsgId))
      .set('Authorization', `Bearer ${b.token}`).send({ reason: 'harmful' });

    expect(res.status).toBe(404);
    const rows = await db.select().from(messageReports).where(eq(messageReports.messageId, aiMsgId));
    expect(rows).toHaveLength(0);
  });

  it('returns 404 when the message is not in that conversation', async () => {
    const { token, userId } = await registerAndLogin(USER_A_EMAIL);
    const { aiMsgId } = await seedConversation(token, userId);
    const res = await request(app).post(reportUrl('00000000-0000-0000-0000-000000000000', aiMsgId))
      .set('Authorization', `Bearer ${token}`).send({ reason: 'harmful' });
    expect(res.status).toBe(404);
  });

  it('returns 404 (not 500) for malformed ids', async () => {
    const { token } = await registerAndLogin(USER_A_EMAIL);
    const res = await request(app).post(reportUrl('not-a-uuid', 'also-not'))
      .set('Authorization', `Bearer ${token}`).send({ reason: 'harmful' });
    expect(res.status).toBe(404);
  });

  it('rejects an unknown reason with 400', async () => {
    const { token, userId } = await registerAndLogin(USER_A_EMAIL);
    const { convId, aiMsgId } = await seedConversation(token, userId);
    const res = await request(app).post(reportUrl(convId, aiMsgId))
      .set('Authorization', `Bearer ${token}`).send({ reason: 'meh' });
    expect(res.status).toBe(400);
  });
});
