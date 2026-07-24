/**
 * src/routes/__tests__/messages.test.ts
 *
 * Unit tests for POST /v1/conversations/:id/messages.
 * DB, Redis, AIOrchestrationService, and EncryptionService are all mocked.
 *
 * TDD-required test (P1-012 criterion 5):
 *   "A unit test verifies that a LLM timeout (mocked) does NOT result in
 *    the user's message being lost — the role: 'user' message is present
 *    in the DB even when the AI response fails."
 */

// ── Mocks (hoisted before imports) ────────────────────────────────────────────

const mockDbFindFirst   = jest.fn();
const mockDbFindMany    = jest.fn();
const mockDbInsert      = jest.fn();
const mockDbUpdate      = jest.fn();
const mockDbTransaction = jest.fn();
const mockRedis         = { lrange: jest.fn(), pipeline: jest.fn() };
const mockEncrypt       = jest.fn();
const mockDecrypt       = jest.fn();
const _mockStream       = jest.fn();

jest.mock('../../db', () => ({
  db: {
    query: {
      conversations: { findFirst: mockDbFindFirst },
      messages:      { findMany:  mockDbFindMany  },
      users:         { findFirst: jest.fn().mockResolvedValue(null) },
      userContext:   { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert:      mockDbInsert,
    update:      mockDbUpdate,
    transaction: mockDbTransaction,
  },
}));

jest.mock('../../lib/redis',  () => ({ redis: mockRedis }));
jest.mock('../../services/EncryptionService', () => ({
  EncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: mockEncrypt,
    decrypt: mockDecrypt,
  })),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { generateKeyPairSync } from 'node:crypto';
import request                  from 'supertest';
import { app }                  from '../../app';
import { signAccessToken }      from '../../lib/jwt';
import { setOrchestrator }      from '../v1/conversations.router';
import type { AIOrchestrationService } from '../../ai/AIOrchestrationService';
import { LLMTimeoutError, LLMStreamError } from '../../ai/llm/errors';
import { CRISIS_SENTINEL }      from '../v1/messagesStream';

// ── Auth setup ─────────────────────────────────────────────────────────────────

const USER_ID = 'aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
let authHeader: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength:  2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.JWT_PRIVATE_KEY = privateKey;
  process.env.JWT_PUBLIC_KEY  = publicKey;
  authHeader = `Bearer ${signAccessToken(USER_ID)}`;
});

// ── Fixtures ───────────────────────────────────────────────────────────────────

const CONV_ID = 'cccc-cccc-cccc-cccc-cccccccccccc';

const ACTIVE_CONV = {
  id:           CONV_ID,
  userId:       USER_ID,
  status:       'active',
  messageCount: 0,
  startedAt:    new Date(),
  endedAt:      null,
};

const CLOSED_CONV = { ...ACTIVE_CONV, status: 'closed', endedAt: new Date() };

// ── Redis pipeline mock setup ──────────────────────────────────────────────────

function setupRedisMock(cachedMessages: unknown[] = []) {
  mockRedis.lrange.mockResolvedValue(
    cachedMessages.map((m) => JSON.stringify(m)),
  );
  const pipe = { rpush: jest.fn(), ltrim: jest.fn(), expire: jest.fn(),
                 exec: jest.fn().mockResolvedValue(null),
                 del: jest.fn() };
  pipe.rpush.mockReturnValue(pipe);
  pipe.ltrim.mockReturnValue(pipe);
  pipe.expire.mockReturnValue(pipe);
  pipe.del.mockReturnValue(pipe);
  mockRedis.pipeline.mockReturnValue(pipe);
  return pipe;
}

// ── DB mock helpers ────────────────────────────────────────────────────────────

function _setupInsertMock() {
  const returning = jest.fn().mockResolvedValue([{ id: 'msg-uuid-001' }]);
  const values    = jest.fn().mockReturnValue({ returning });
  mockDbInsert.mockReturnValue({ values });
  return { values, returning };
}

function _setupUpdateMock() {
  const where     = jest.fn().mockResolvedValue(undefined);
  const set       = jest.fn().mockReturnValue({ where });
  mockDbUpdate.mockReturnValue({ set });
  return { set, where };
}

function setupTransactionMock(insertResult = [{ id: 'msg-uuid-001' }]) {
  mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const txInsertReturning = jest.fn().mockResolvedValue(insertResult);
    const txInsertValues    = jest.fn().mockReturnValue({ returning: txInsertReturning });
    const txInsert          = jest.fn().mockReturnValue({ values: txInsertValues });
    const txUpdateWhere     = jest.fn().mockResolvedValue(undefined);
    const txUpdateSet       = jest.fn().mockReturnValue({ where: txUpdateWhere });
    const txUpdate          = jest.fn().mockReturnValue({ set: txUpdateSet });
    return cb({ insert: txInsert, update: txUpdate });
  });
}

// ── Streaming orchestrator mock ────────────────────────────────────────────────

function makeStreamOrchestrator(tokens: string[], throwAfter?: Error) {
  const orchestrator = {
    stream: jest.fn().mockImplementation(async function* () {
      for (const token of tokens) {
        yield token;
      }
      if (throwAfter) throw throwAfter;
    }),
  } as unknown as AIOrchestrationService;
  setOrchestrator(orchestrator);
  return orchestrator;
}

// Helper to collect a full SSE response body from supertest
async function collectSSE(path: string, body: unknown, headers: Record<string, string> = {}) {
  return request(app)
    .post(path)
    .set('Authorization', authHeader)
    .set(headers)
    .send(body as object)
    .buffer(true)
    .parse((res, callback) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => callback(null, data));
    });
}

function parseSSEFrames(raw: string) {
  return raw.split('\n\n').filter(Boolean).map((block) => {
    const lines  = block.split('\n');
    const id     = lines.find((l) => l.startsWith('id:'))    ?.replace(/^id:\s*/, '');
    const event  = lines.find((l) => l.startsWith('event:')) ?.replace(/^event:\s*/, '');
    const rawData = lines.find((l) => l.startsWith('data:'))  ?.replace(/^data:\s*/, '');
    let data: unknown;
    try { data = JSON.parse(rawData ?? ''); } catch { data = rawData; }
    return { id, event, data };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setupRedisMock();
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /:id/messages — input validation', () => {
  it('returns 400 for empty content', async () => {
    const res = await request(app)
      .post(`/v1/conversations/${CONV_ID}/messages`)
      .set('Authorization', authHeader)
      .send({ content: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when content is missing', async () => {
    const res = await request(app)
      .post(`/v1/conversations/${CONV_ID}/messages`)
      .set('Authorization', authHeader)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 413 when content exceeds 2,000 characters', async () => {
    const res = await request(app)
      .post(`/v1/conversations/${CONV_ID}/messages`)
      .set('Authorization', authHeader)
      .send({ content: 'a'.repeat(2001) });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('CONTENT_TOO_LONG');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post(`/v1/conversations/${CONV_ID}/messages`)
      .send({ content: 'hello' });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation guard
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /:id/messages — conversation guard', () => {
  it('returns 404 when conversation does not exist', async () => {
    mockDbFindFirst.mockResolvedValue(undefined);
    const res = await request(app)
      .post(`/v1/conversations/${CONV_ID}/messages`)
      .set('Authorization', authHeader)
      .send({ content: 'hello' });
    expect(res.status).toBe(404);
  });

  it('returns 403 when conversation belongs to another user', async () => {
    mockDbFindFirst.mockResolvedValue({ ...ACTIVE_CONV, userId: 'other-user' });
    const res = await request(app)
      .post(`/v1/conversations/${CONV_ID}/messages`)
      .set('Authorization', authHeader)
      .send({ content: 'hello' });
    expect(res.status).toBe(403);
  });

  it('returns 409 CONVERSATION_CLOSED when status is closed', async () => {
    mockDbFindFirst.mockResolvedValue(CLOSED_CONV);
    const res = await request(app)
      .post(`/v1/conversations/${CONV_ID}/messages`)
      .set('Authorization', authHeader)
      .send({ content: 'hello' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONVERSATION_CLOSED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TDD P1-012 REQUIRED TEST
// "A unit test verifies that a LLM timeout (mocked) does NOT result in the
//  user's message being lost — the role: 'user' message is present in the
//  DB even when the AI response fails."
// ─────────────────────────────────────────────────────────────────────────────

describe('TDD P1-012 required — user message preserved on LLM failure', () => {
  it('role:user message is inserted in DB even when LLM stream times out', async () => {
    mockDbFindFirst.mockResolvedValue(ACTIVE_CONV);
    mockEncrypt.mockReturnValue({ ciphertext: Buffer.from('enc'), iv: Buffer.alloc(12) });

    // Track whether the user-message transaction was called
    let userMessageInserted = false;
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      userMessageInserted = true;
      const txInsertReturn = jest.fn().mockResolvedValue([{ id: 'user-msg-id' }]);
      const txInsertValues = jest.fn().mockReturnValue({ returning: txInsertReturn });
      const txInsert       = jest.fn().mockReturnValue({ values: txInsertValues });
      const txUpdateWhere  = jest.fn().mockResolvedValue(undefined);
      const txUpdateSet    = jest.fn().mockReturnValue({ where: txUpdateWhere });
      const txUpdate       = jest.fn().mockReturnValue({ set: txUpdateSet });
      return cb({ insert: txInsert, update: txUpdate });
    });

    // LLM times out — throws immediately
    makeStreamOrchestrator([], new LLMTimeoutError('timed out'));

    const res = await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'I feel anxious' });

    // User message MUST have been saved (first transaction)
    expect(userMessageInserted).toBe(true);

    // Response should be an SSE error frame, not an HTTP 5xx
    const frames = parseSSEFrames(res.body as string);
    const errorFrame = frames.find((f) => f.event === 'error');
    expect(errorFrame).toBeDefined();
    expect((errorFrame?.data as { code: string }).code).toBe('LLM_TIMEOUT');
  });

  it('role:user message is inserted in DB even when LLM stream errors mid-stream', async () => {
    mockDbFindFirst.mockResolvedValue(ACTIVE_CONV);
    mockEncrypt.mockReturnValue({ ciphertext: Buffer.from('enc'), iv: Buffer.alloc(12) });

    let userMessageInserted = false;
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      userMessageInserted = true;
      const txInsertReturn = jest.fn().mockResolvedValue([{ id: 'user-msg-id' }]);
      const txInsertValues = jest.fn().mockReturnValue({ returning: txInsertReturn });
      const txInsert       = jest.fn().mockReturnValue({ values: txInsertValues });
      const txUpdateWhere  = jest.fn().mockResolvedValue(undefined);
      const txUpdateSet    = jest.fn().mockReturnValue({ where: txUpdateWhere });
      const txUpdate       = jest.fn().mockReturnValue({ set: txUpdateSet });
      return cb({ insert: txInsert, update: txUpdate });
    });

    // Emit one token then throw
    makeStreamOrchestrator(['Hello '], new LLMStreamError('connection reset'));

    await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'Tell me something' });

    expect(userMessageInserted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SSE happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /:id/messages — SSE stream', () => {
  beforeEach(() => {
    mockDbFindFirst.mockResolvedValue(ACTIVE_CONV);
    mockEncrypt.mockReturnValue({ ciphertext: Buffer.from('enc'), iv: Buffer.alloc(12) });
    setupTransactionMock();
  });

  it('sets Content-Type: text/event-stream', async () => {
    makeStreamOrchestrator(['Hi', ' there']);
    const res = await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'hello' });
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });

  it('emits event:token frames for each token', async () => {
    makeStreamOrchestrator(['Hello', ', ', 'world']);
    const res = await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'hello' });
    const frames = parseSSEFrames(res.body as string);

    const tokens = frames.filter((f) => f.event === 'token');
    expect(tokens).toHaveLength(3);
    expect((tokens[0].data as { delta: string }).delta).toBe('Hello');
    expect((tokens[1].data as { delta: string }).delta).toBe(', ');
    expect((tokens[2].data as { delta: string }).delta).toBe('world');
  });

  it('token frames include sequential id fields for reconnection', async () => {
    makeStreamOrchestrator(['A', 'B', 'C']);
    const res = await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'hello' });
    const frames = parseSSEFrames(res.body as string);

    const tokens = frames.filter((f) => f.event === 'token');
    expect(tokens[0].id).toBe('0');
    expect(tokens[1].id).toBe('1');
    expect(tokens[2].id).toBe('2');
  });

  it('emits event:done with message_id and emotion_tags after stream completes', async () => {
    makeStreamOrchestrator(['Hi!']);
    const res = await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'I feel anxious' });
    const frames = parseSSEFrames(res.body as string);

    const done = frames.find((f) => f.event === 'done');
    expect(done).toBeDefined();
    const doneData = done?.data as { message_id: string; emotion_tags: { primary: string; score: number } };
    expect(doneData.message_id).toBeTruthy();
    expect(doneData.emotion_tags.primary).toBe('anxiety'); // detected from content
    expect(typeof doneData.emotion_tags.score).toBe('number');
  });

  it('saves the assistant message in a DB transaction after stream completes', async () => {
    let transactionCalled = false;
    mockDbTransaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      // user-message transaction
      const r = jest.fn().mockResolvedValue([{ id: 'u-msg-id' }]);
      const v = jest.fn().mockReturnValue({ returning: r });
      const i = jest.fn().mockReturnValue({ values: v });
      const w = jest.fn().mockResolvedValue(undefined);
      const s = jest.fn().mockReturnValue({ where: w });
      const u = jest.fn().mockReturnValue({ set: s });
      return cb({ insert: i, update: u });
    });
    mockDbTransaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      // assistant-message transaction
      transactionCalled = true;
      const r = jest.fn().mockResolvedValue([{ id: 'a-msg-id' }]);
      const v = jest.fn().mockReturnValue({ returning: r });
      const i = jest.fn().mockReturnValue({ values: v });
      const w = jest.fn().mockResolvedValue(undefined);
      const s = jest.fn().mockReturnValue({ where: w });
      const u = jest.fn().mockReturnValue({ set: s });
      return cb({ insert: i, update: u });
    });

    makeStreamOrchestrator(['Great response']);
    await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'hello' });

    expect(transactionCalled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SSE error paths
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /:id/messages — SSE error paths', () => {
  beforeEach(() => {
    mockDbFindFirst.mockResolvedValue(ACTIVE_CONV);
    mockEncrypt.mockReturnValue({ ciphertext: Buffer.from('enc'), iv: Buffer.alloc(12) });
    setupTransactionMock();
  });

  it('emits event:error code:LLM_TIMEOUT on timeout (no tokens produced)', async () => {
    makeStreamOrchestrator([], new LLMTimeoutError());
    const res = await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'hello' });
    const frames = parseSSEFrames(res.body as string);

    const err = frames.find((f) => f.event === 'error');
    expect(err).toBeDefined();
    expect((err?.data as { code: string }).code).toBe('LLM_TIMEOUT');
  });

  it('emits event:error code:LLM_STREAM_ERROR on mid-stream failure', async () => {
    makeStreamOrchestrator(['partial...'], new LLMStreamError('connection reset'));
    const res = await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'hello' });
    const frames = parseSSEFrames(res.body as string);

    const err = frames.find((f) => f.event === 'error');
    expect(err).toBeDefined();
    expect((err?.data as { code: string }).code).toBe('LLM_STREAM_ERROR');
  });

  it('does NOT emit event:done when the stream errors', async () => {
    makeStreamOrchestrator(['partial'], new LLMStreamError('fail'));
    const res = await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'hello' });
    const frames = parseSSEFrames(res.body as string);
    expect(frames.find((f) => f.event === 'done')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Emotion detection
// ─────────────────────────────────────────────────────────────────────────────

describe('emotion detection from user message', () => {
  const cases: Array<[string, string]> = [
    ['I feel so anxious about this',  'anxiety'],
    ['I am really stressed and overwhelmed', 'anxiety'],
    ['feeling sad and depressed today', 'sadness'],
    ['I am so angry about what happened', 'anger'],
    ['I am excited about the new job', 'excitement'],
    ['today was a great and happy day', 'joy'],
    ['I feel calm and peaceful', 'calm'],
    ['just checking in',              'calm'], // default
  ];

  test.each(cases)('"%s" → primary emotion: %s', async (content, expectedEmotion) => {
    mockDbFindFirst.mockResolvedValue(ACTIVE_CONV);
    mockEncrypt.mockReturnValue({ ciphertext: Buffer.from('enc'), iv: Buffer.alloc(12) });
    setupTransactionMock();
    makeStreamOrchestrator(['Ok']);

    const res = await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content });
    const frames = parseSSEFrames(res.body as string);
    const done   = frames.find((f) => f.event === 'done');
    const doneData = done?.data as { emotion_tags: { primary: string } };
    expect(doneData?.emotion_tags?.primary).toBe(expectedEmotion);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T-007 — Crisis sentinel end-to-end
// ─────────────────────────────────────────────────────────────────────────────
//
// messagesStream.test.ts covers stripCrisisSentinel/sentinelPrefixOverlapLength
// as pure unit tests. These verify the sentinel is actually kept out of the
// client stream and the persisted message when driven through the real
// POST /:id/messages handler — not just the helper functions in isolation.

describe('POST /:id/messages — T-007 crisis sentinel', () => {
  beforeEach(() => {
    mockDbFindFirst.mockResolvedValue(ACTIVE_CONV);
    mockEncrypt.mockReturnValue({ ciphertext: Buffer.from('enc'), iv: Buffer.alloc(12) });
    setupTransactionMock();
  });

  it('never sends the sentinel in a token frame, even when it arrives as its own token', async () => {
    makeStreamOrchestrator([
      "I hear how much pain you're in. Please call 988.\n",
      CRISIS_SENTINEL,
    ]);

    const res = await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'I want to hurt myself' });
    const frames = parseSSEFrames(res.body as string);
    const tokens = frames.filter((f) => f.event === 'token');

    for (const t of tokens) {
      expect((t.data as { delta: string }).delta).not.toContain(CRISIS_SENTINEL);
    }
    const joined = tokens.map((t) => (t.data as { delta: string }).delta).join('');
    expect(joined).not.toContain(CRISIS_SENTINEL);
    expect(joined).toContain('988');
  });

  it('never sends the sentinel even when it arrives split across multiple small tokens', async () => {
    // Split the sentinel into arbitrary chunks to exercise the withheld-buffer path.
    const chunks = [CRISIS_SENTINEL.slice(0, 6), CRISIS_SENTINEL.slice(6, 14), CRISIS_SENTINEL.slice(14)];
    makeStreamOrchestrator(['Please call 988.\n', ...chunks]);

    const res = await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'help' });
    const frames = parseSSEFrames(res.body as string);
    const joined = frames
      .filter((f) => f.event === 'token')
      .map((t) => (t.data as { delta: string }).delta)
      .join('');

    expect(joined).not.toContain(CRISIS_SENTINEL);
    expect(joined).toContain('988');
  });

  it('persists the assistant message without the sentinel', async () => {
    makeStreamOrchestrator(['Please call 988.\n', CRISIS_SENTINEL]);

    await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'help' });

    // encrypt() is called once for the user message, once for the assistant
    // message — the second call is the one that must be sentinel-free.
    const assistantEncryptCall = mockEncrypt.mock.calls[1][0] as string;
    expect(assistantEncryptCall).not.toContain(CRISIS_SENTINEL);
    expect(assistantEncryptCall).toBe('Please call 988.');
  });

  it('logs a crisis_flag warning when the sentinel is detected', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    makeStreamOrchestrator(['Please call 988.\n', CRISIS_SENTINEL]);

    await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'help' });

    const logged = warnSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    const flag = logged.find((l) => l.event === 'crisis_flag');
    expect(flag).toBeDefined();
    expect(flag.conversation_id).toBe(CONV_ID);
    expect(flag.user_id).toBe(USER_ID);

    warnSpy.mockRestore();
  });

  it('does NOT log a crisis_flag warning for an ordinary response', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    makeStreamOrchestrator(['Hello', ', ', 'world']);

    await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'hi' });

    const logged = warnSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(logged.find((l) => l.event === 'crisis_flag')).toBeUndefined();

    warnSpy.mockRestore();
  });

  it('still emits token frames in real time for ordinary (non-crisis) responses', async () => {
    // Regression guard: the sentinel-aware buffering must not delay or
    // merge tokens for the common case where no sentinel is ever sent.
    makeStreamOrchestrator(['Hello', ', ', 'world']);

    const res = await collectSSE(`/v1/conversations/${CONV_ID}/messages`, { content: 'hi' });
    const frames = parseSSEFrames(res.body as string);
    const tokens = frames.filter((f) => f.event === 'token');

    expect(tokens).toHaveLength(3);
    expect((tokens[0].data as { delta: string }).delta).toBe('Hello');
    expect((tokens[1].data as { delta: string }).delta).toBe(', ');
    expect((tokens[2].data as { delta: string }).delta).toBe('world');
  });
});
