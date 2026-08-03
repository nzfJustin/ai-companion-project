/**
 * tests/integration/p1024.integration.test.ts
 *
 * P1-024 · Integration Test Suite (T-005)
 *
 * Three end-to-end flows per the task breakdown spec, running against real
 * Postgres (pgvector/pgvector:pg16) and Redis (redis:7-alpine).
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/companion_test \
 *     npm run db:migrate
 *
 * Then run:
 *   npm run test:integration
 *
 * Design rules (from spec P1-024):
 *   - MockLLMProvider for ALL LLM calls — no real Anthropic API calls
 *   - Real Postgres, Redis
 *   - Tables truncated between test FILES (handled by beforeAll/afterAll here)
 *   - Every security-critical test has a corresponding negative-case test
 *   - Suite must complete in under 3 minutes
 *
 * pg-boss note: pg-boss ships as a pure ESM package with no CJS build, and
 * nothing in this codebase constructs a real instance yet (it isn't wired
 * into src/index.ts at startup) — see the import comment further down for
 * why the job queue is a spy here rather than a real PgBoss instance.
 */

import request  from 'supertest';
// pg-boss ships as a pure ESM package ("type": "module", no CJS build). Both
// a static `import { PgBoss } from 'pg-boss'` AND a dynamic `import('pg-boss')`
// fail under Jest — Jest's runtime hooks intercept dynamic import() too (it
// needs to, for its module registry/mocking to work), routing it through the
// same "node_modules is excluded from transform" wall as a static import.
// No file anywhere in this codebase actually constructs `new PgBoss(...)`
// yet (pg-boss isn't wired into src/index.ts at startup), so there's no
// existing precedent to fall back on either. Rather than pull in new
// dependencies (@babel/preset-env + a JS transform just for this one
// package), inject a spy standing in for the queue — enqueueExtractionJob()
// only ever calls `.send(name, payload, options)` on it, so this still
// exercises the real conversation-close → enqueue call path end-to-end;
// it just verifies the call arguments (below) instead of a real row landing
// in pgboss.job.
import type { PgBoss } from 'pg-boss';
import { eq, and } from 'drizzle-orm';
import { app }  from '../../src/app';
import { db }   from '../../src/db';
import {
  users,
  authSessions,
  conversations,
  messages,
  memories,
  userMemoryPins,
} from '../../src/db/schema';
import { setJobQueue, setOrchestrator } from '../../src/routes/v1/conversations.router';
import { JOB_MEMORY_EXTRACTION } from '../../src/jobs';
import { EncryptionService } from '../../src/services/EncryptionService';
import { AIOrchestrationService } from '../../src/ai/AIOrchestrationService';
import { MockLLMProvider } from '../mocks/MockLLMProvider';


// ─── Helpers ─────────────────────────────────────────────────────────────────

async function register(email: string, password = 'TestPass123!') {
  const res = await request(app)
    .post('/v1/auth/register')
    .send({ email, password, display_name: 'Integration User' });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

async function login(email: string, password = 'TestPass123!') {
  const res = await request(app)
    .post('/v1/auth/login')
    .send({ email, password });
  expect(res.status).toBe(200);
  return {
    accessToken: (res.body as { access_token: string }).access_token,
    cookie:      res.headers['set-cookie'] as unknown as string[],
  };
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ─── Table cleanup ────────────────────────────────────────────────────────────

async function truncateAll() {
  // Order matters — FK constraints: messages → conversations, memories → conversations
  await db.delete(memories);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(authSessions);
  await db.delete(userMemoryPins);
  // Deleting users cascades to userContext, userStreaks, etc.
  await db
    .delete(users)
    .where(
      // Only delete test users to avoid touching any seed data
      eq(users.displayName, 'Integration User'),
    );
}

// ─── pg-boss stand-in ─────────────────────────────────────────────────────────
// See the import comment above for why this is a spy rather than a real
// PgBoss instance.

const mockSend = jest.fn().mockResolvedValue('fake-job-id');

beforeAll(async () => {
  setJobQueue({ send: mockSend } as unknown as PgBoss);
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
});

// ═════════════════════════════════════════════════════════════════════════════
// Flow 1 — Full Auth Lifecycle
//
// register → login → use access token → refresh (rotate) →
// reuse old refresh token → verify revocation (401 TOKEN_REUSE_DETECTED) →
// logout → verify session gone
// ═════════════════════════════════════════════════════════════════════════════

describe('Flow 1 — Full Auth Lifecycle', () => {
  const EMAIL = `auth-lifecycle-${Date.now()}@test.invalid`;
  let userId:       string;
  let accessToken:  string;
  let firstCookie:  string[];
  let secondCookie: string[];

  it('1.1 — register creates a user and returns id + display_name', async () => {
    const res = await request(app)
      .post('/v1/auth/register')
      .send({ email: EMAIL, password: 'TestPass123!', display_name: 'Integration User' });

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    userId = res.body.id;
  });

  it('1.2 — login returns access_token and sets httpOnly refresh cookie', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: EMAIL, password: 'TestPass123!' });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.headers['set-cookie']).toBeDefined();

    accessToken = res.body.access_token;
    firstCookie = res.headers['set-cookie'] as unknown as string[];
  });

  it('1.3 — access token grants access to GET /v1/users/me', async () => {
    const res = await request(app)
      .get('/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(userId);
    expect(res.body.email).toBe(EMAIL);
    expect(res.body).not.toHaveProperty('password_hash');
  });

  it('1.3N — (negative) tampered access token returns 401', async () => {
    const tampered = `${accessToken.slice(0, -4)}XXXX`;
    const res = await request(app)
      .get('/v1/users/me')
      .set('Authorization', `Bearer ${tampered}`);

    expect(res.status).toBe(401);
  });

  it('1.4 — refresh rotates the token and returns a new access_token', async () => {
    // signAccessToken()'s `iat` claim has 1-second granularity and RS256
    // signing is deterministic — two tokens signed for the same user within
    // the same wall-clock second are byte-for-byte identical. Cross a
    // second boundary so the "new token differs from old" check below is
    // actually meaningful rather than racy.
    await new Promise((r) => setTimeout(r, 1100));

    const res = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', firstCookie);

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.access_token).not.toBe(accessToken);

    secondCookie = res.headers['set-cookie'] as unknown as string[];
    accessToken  = res.body.access_token;
  });

  it('1.5 — reusing the old refresh token is detected and returns 401 TOKEN_REUSE_DETECTED', async () => {
    // The old refresh cookie was rotated in step 1.4.
    // Attempting to use it again must be rejected as token reuse.
    const res = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', firstCookie);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOKEN_REUSE_DETECTED');
  });

  it('1.6 — logout invalidates the session', async () => {
    const logoutRes = await request(app)
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', secondCookie);

    expect(logoutRes.status).toBe(200);
  });

  it('access token is stateless — it still works after logout until it naturally expires', async () => {
    // authenticate middleware (src/middleware/authenticate.ts) only verifies
    // the JWT signature + expiry; it never looks up the session in the DB.
    // Logout revokes the *refresh* session (see 1.6N below — no new access
    // token can be minted afterward), but a still-valid access token keeps
    // working until its own 15-minute TTL elapses. This is the intended
    // design, not a gap — asserted here so a future change to make logout
    // revoke access tokens too doesn't silently break this assumption.
    const res = await request(app)
      .get('/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
  });

  it('1.6N — (negative) refresh token no longer works after logout', async () => {
    const res = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', secondCookie);

    expect(res.status).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Flow 2 — Conversation Lifecycle
//
// create conversation → send message via MockLLMProvider →
// verify message encrypted in DB → close conversation →
// verify memory_extraction job enqueued in pg-boss
// ═════════════════════════════════════════════════════════════════════════════

describe('Flow 2 — Conversation Lifecycle', () => {
  const EMAIL = `conv-lifecycle-${Date.now()}@test.invalid`;
  let userId:         string;
  let accessToken:    string;
  let conversationId: string;
  let messageId:      string;

  beforeAll(async () => {
    // POST /:id/messages calls the orchestrator synchronously in the request
    // handler (unlike memory extraction, which only runs in a pg-boss worker
    // this suite never starts) — inject MockLLMProvider so this never hits
    // the real Anthropic API, per the design rule at the top of this file.
    setOrchestrator(new AIOrchestrationService(new MockLLMProvider()));

    const reg    = await register(EMAIL);
    userId       = reg.id;
    const logIn  = await login(EMAIL);
    accessToken  = logIn.accessToken;
  });

  it('2.1 — POST /v1/conversations creates a conversation with status active', async () => {
    const res = await request(app)
      .post('/v1/conversations')
      .set(...Object.entries(authHeader(accessToken))[0]);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    conversationId = res.body.id;
  });

  it('2.2N — (negative) cannot create a second active conversation while one is open', async () => {
    const res = await request(app)
      .post('/v1/conversations')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ACTIVE_CONVERSATION_EXISTS');
  });

  it('2.3 — POST /v1/conversations/:id/messages streams a response and the user message is stored encrypted', async () => {
    // Send a test message — MockLLMProvider is configured via env/app setup
    const res = await request(app)
      .post(`/v1/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Accept', 'text/event-stream')
      .send({ content: 'Hello, this is my first message.' });

    // The streaming endpoint returns 200 with SSE content
    expect(res.status).toBe(200);

    // Verify the user message was persisted — find it in the DB
    const rows = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.role, 'user'),
        ),
      )
      .limit(1);

    expect(rows.length).toBe(1);
    messageId = rows[0].id;

    // The content column must be a Buffer (encrypted), not the plaintext string
    // (Buffer.isBuffer alone is sufficient — Buffer is-a Uint8Array in Node.)
    const storedContent = rows[0].content;
    expect(Buffer.isBuffer(storedContent)).toBe(true);

    // Confirm the plaintext is NOT in the DB
    const raw = storedContent.toString('utf8');
    expect(raw).not.toContain('Hello, this is my first message.');
  });

  it('2.4 — encrypted content decrypts back to the original message', async () => {
    const enc = new EncryptionService(userId);
    const row = await db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
      .then((r) => r[0]);

    expect(row).toBeDefined();
    const decrypted = enc.decrypt(row.content, row.contentIv);
    expect(decrypted).toBe('Hello, this is my first message.');
  });

  it('2.5 — PATCH /v1/conversations/:id closes the conversation', async () => {
    const res = await request(app)
      .patch(`/v1/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'closed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
    expect(res.body.ended_at).toBeTruthy();
  });

  it('2.5N — (negative) closing an already-closed conversation returns 403', async () => {
    const res = await request(app)
      .patch(`/v1/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'closed' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CONVERSATION_NOT_ACTIVE');
  });

  it('2.6 — a memory_extraction job is enqueued after close', async () => {
    // See the pg-boss import comment near the top of this file — a spy
    // stands in for the real queue, so this checks the enqueue call the
    // route handler made rather than a row in pgboss.job.
    expect(mockSend).toHaveBeenCalledWith(
      JOB_MEMORY_EXTRACTION,
      expect.objectContaining({ conversation_id: conversationId }),
      expect.anything(),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Flow 3 — Memory Access Control
//
// Set up a Level 4 memory → attempt read without elevated token → 403 →
// verify PIN → get elevated token → retry with token → 200 with content
// ═════════════════════════════════════════════════════════════════════════════

describe('Flow 3 — Memory Access Control (Level 4)', () => {
  const EMAIL   = `memory-access-${Date.now()}@test.invalid`;
  const PIN     = '123456';
  let userId:       string;
  let accessToken:  string;
  let memoryId:     string;

  beforeAll(async () => {
    const reg   = await register(EMAIL);
    userId      = reg.id;
    const logIn = await login(EMAIL);
    accessToken = logIn.accessToken;

    // Set the memory PIN for this user
    const pinRes = await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ pin: PIN });
    expect(pinRes.status).toBe(200);

    // Insert a Level 4 memory directly (the extraction job is tested in Flow 2)
    const enc = new EncryptionService(userId);
    const { ciphertext, iv } = enc.encrypt('This is a very sensitive memory summary.');

    const [memory] = await db
      .insert(memories)
      .values({
        userId,
        conversationId: null as unknown as string, // no conversation needed for this test
        title:          'A sensitive level-4 memory',
        summary:        ciphertext,
        summaryIv:      iv,
        keyEvents:      ['Something important happened'],
        emotionalTags:  ['anxious'],
        dominantEmotion: 'anxiety',
        level:          4,
        periodStart:    new Date().toISOString().slice(0, 10),
        periodEnd:      new Date().toISOString().slice(0, 10),
        embedding:      null,
      })
      .returning({ id: memories.id });

    memoryId = memory.id;
  });

  it('3.1N — (negative) GET /v1/memories/:id without elevated token returns 403 MEMORY_ACCESS_DENIED', async () => {
    const res = await request(app)
      .get(`/v1/memories/${memoryId}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MEMORY_ACCESS_DENIED');
    // Confirm no content leaked
    expect(res.body.summary).toBeUndefined();
    expect(res.body.content).toBeUndefined();
  });

  it('3.1N — (negative) wrong PIN returns 401 INVALID_PIN', async () => {
    const res = await request(app)
      .post('/v1/auth/memory-pin/verify')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ pin: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_PIN');
  });

  it('3.2 — correct PIN returns an elevated_token', async () => {
    const res = await request(app)
      .post('/v1/auth/memory-pin/verify')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ pin: PIN });

    expect(res.status).toBe(200);
    expect(res.body.elevated_token).toBeTruthy();
  });

  it('3.3 — GET /v1/memories/:id with valid elevated token returns 200 and decrypted content', async () => {
    // Get a fresh elevated token
    const verifyRes = await request(app)
      .post('/v1/auth/memory-pin/verify')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ pin: PIN });

    const elevatedToken = verifyRes.body.elevated_token;

    const res = await request(app)
      .get(`/v1/memories/${memoryId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Elevated-Token', elevatedToken);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(memoryId);
    expect(res.body.summary).toBe('This is a very sensitive memory summary.');
    expect(res.body.level).toBe(4);
  });

  it('3.3N — (negative) elevated token from a different user is rejected', async () => {
    // Register a second user and get their elevated token
    const EMAIL2 = `other-user-${Date.now()}@test.invalid`;
    await register(EMAIL2);
    const { accessToken: token2 } = await login(EMAIL2);

    const pinRes = await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', `Bearer ${token2}`)
      .send({ pin: PIN });
    expect(pinRes.status).toBe(200);

    const verifyRes = await request(app)
      .post('/v1/auth/memory-pin/verify')
      .set('Authorization', `Bearer ${token2}`)
      .send({ pin: PIN });

    const otherElevatedToken = verifyRes.body.elevated_token;

    // Use other user's elevated token to access first user's memory
    const res = await request(app)
      .get(`/v1/memories/${memoryId}`)
      .set('Authorization', `Bearer ${accessToken}`)   // correct user's access token
      .set('X-Elevated-Token', otherElevatedToken);     // but other user's elevated token

    // memories.router.ts's elevated-token gate checks payload.sub === userId
    // and returns 403 MEMORY_ACCESS_DENIED for any mismatch (not a 401 —
    // the token itself is validly signed, it just belongs to someone else).
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MEMORY_ACCESS_DENIED');
  });

  it('3.4N — (negative) Level 1–3 memories are accessible without elevated token', async () => {
    // Insert a Level 2 memory
    const enc = new EncryptionService(userId);
    const { ciphertext, iv } = enc.encrypt('A normal level-2 memory.');

    const [mem] = await db
      .insert(memories)
      .values({
        userId,
        conversationId: null as unknown as string,
        title:          'A normal memory',
        summary:        ciphertext,
        summaryIv:      iv,
        keyEvents:      ['Something happened'],
        emotionalTags:  ['calm'],
        dominantEmotion: 'calm',
        level:          2,
        periodStart:    new Date().toISOString().slice(0, 10),
        periodEnd:      new Date().toISOString().slice(0, 10),
        embedding:      null,
      })
      .returning({ id: memories.id });

    const res = await request(app)
      .get(`/v1/memories/${mem.id}`)
      .set('Authorization', `Bearer ${accessToken}`);

    // Level 2 should be accessible without elevated token
    expect(res.status).toBe(200);
    expect(res.body.summary).toBe('A normal level-2 memory.');
  });
});
