/**
 * src/routes/__tests__/conversations.test.ts
 *
 * Unit tests for POST, GET (list), PATCH, GET/:id.
 * DB and EncryptionService are mocked; JWT is real.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../../db', () => ({
  db: {
    query: {
      conversations: { findFirst: jest.fn(), findMany: jest.fn() },
      messages:      { findMany: jest.fn() },
    },
    insert:      jest.fn(),
    update:      jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('../../services/EncryptionService', () => ({
  EncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: jest.fn().mockReturnValue('decrypted content'),
    encrypt: jest.fn().mockReturnValue({ ciphertext: Buffer.from('x'), iv: Buffer.alloc(12) }),
  })),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { app } from '../../app';
import { db }  from '../../db';
import { signAccessToken } from '../../lib/jwt';

// ── Typed mock handles ────────────────────────────────────────────────────────

const mockConvFindFirst = db.query.conversations.findFirst as jest.MockedFunction<typeof db.query.conversations.findFirst>;
const mockConvFindMany  = db.query.conversations.findMany  as jest.MockedFunction<typeof db.query.conversations.findMany>;
const mockMsgFindMany   = db.query.messages.findMany       as jest.MockedFunction<typeof db.query.messages.findMany>;
const mockInsert        = db.insert as jest.MockedFunction<typeof db.insert>;
const mockUpdate        = db.update as jest.MockedFunction<typeof db.update>;

// ── Key pair + auth ────────────────────────────────────────────────────────────

const USER_ID     = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const OTHER_USER  = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
let authHeader: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.JWT_PRIVATE_KEY = privateKey;
  process.env.JWT_PUBLIC_KEY  = publicKey;
  authHeader = `Bearer ${signAccessToken(USER_ID)}`;
});

// ── Fixtures ───────────────────────────────────────────────────────────────────

const ACTIVE_CONV = {
  id:           'conv-1111',
  userId:       USER_ID,
  status:       'active' as const,
  messageCount: 3,
  startedAt:    new Date('2026-01-01T10:00:00Z'),
  endedAt:      null,
};

const CLOSED_CONV = { ...ACTIVE_CONV, status: 'closed' as const, endedAt: new Date('2026-01-01T11:00:00Z') };

const SAMPLE_MESSAGES = [
  {
    id:           'msg-1',
    conversationId: 'conv-1111',
    userId:       USER_ID,
    role:         'user' as const,
    content:      Buffer.from('encrypted'),
    contentIv:    Buffer.alloc(12),
    emotionTags:  null,
    createdAt:    new Date('2026-01-01T10:01:00Z'),
  },
  {
    id:           'msg-2',
    conversationId: 'conv-1111',
    userId:       USER_ID,
    role:         'assistant' as const,
    content:      Buffer.from('encrypted'),
    contentIv:    Buffer.alloc(12),
    emotionTags:  { primary: 'calm', score: 0.8 },
    createdAt:    new Date('2026-01-01T10:02:00Z'),
  },
];

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/conversations
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/conversations', () => {
  it('returns 201 with { id, started_at, status }', async () => {
    const returning = jest.fn().mockResolvedValue([{
      id:        ACTIVE_CONV.id,
      startedAt: ACTIVE_CONV.startedAt,
      status:    'active',
    }]);
    const values = jest.fn().mockReturnValue({ returning });
    mockInsert.mockReturnValue({ values } as never);

    const res = await request(app)
      .post('/v1/conversations')
      .set('Authorization', authHeader);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: ACTIVE_CONV.id, status: 'active' });
    expect(res.body).toHaveProperty('started_at');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).post('/v1/conversations');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/conversations
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/conversations', () => {
  it('returns 200 with conversations array and pagination fields', async () => {
    mockConvFindMany.mockResolvedValue([ACTIVE_CONV] as never);

    const res = await request(app)
      .get('/v1/conversations')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.conversations)).toBe(true);
    expect(res.body).toHaveProperty('page');
    expect(res.body).toHaveProperty('per_page');
    expect(res.body).toHaveProperty('has_more');
  });

  it('returns conversations in the expected shape', async () => {
    mockConvFindMany.mockResolvedValue([ACTIVE_CONV] as never);

    const res = await request(app)
      .get('/v1/conversations')
      .set('Authorization', authHeader);

    const c = res.body.conversations[0];
    expect(c).toMatchObject({
      id:            ACTIVE_CONV.id,
      status:        'active',
      message_count: 3,
    });
    expect(c).toHaveProperty('started_at');
  });

  it('uses default per_page=20 and page=1', async () => {
    mockConvFindMany.mockResolvedValue([] as never);

    await request(app)
      .get('/v1/conversations')
      .set('Authorization', authHeader);

    expect(mockConvFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 21, offset: 0 }), // perPage+1 for has_more check
    );
  });

  it('respects page and per_page query params', async () => {
    mockConvFindMany.mockResolvedValue([] as never);

    await request(app)
      .get('/v1/conversations?page=2&per_page=5')
      .set('Authorization', authHeader);

    expect(mockConvFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 6, offset: 5 }),
    );
  });

  it('sets has_more=true when more results exist', async () => {
    // Return perPage+1 items to trigger has_more
    const manyConvs = Array.from({ length: 21 }, (_, i) => ({ ...ACTIVE_CONV, id: `conv-${i}` }));
    mockConvFindMany.mockResolvedValue(manyConvs as never);

    const res = await request(app)
      .get('/v1/conversations?per_page=20')
      .set('Authorization', authHeader);

    expect(res.body.has_more).toBe(true);
    expect(res.body.conversations).toHaveLength(20); // sliced to perPage
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/v1/conversations');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /v1/conversations/:id
// ─────────────────────────────────────────────────────────────────────────────

function setupUpdateMock(returnConv: typeof CLOSED_CONV) {
  const returning = jest.fn().mockResolvedValue([returnConv]);
  const where     = jest.fn().mockReturnValue({ returning });
  const set       = jest.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set } as never);
  return { set, where, returning };
}

describe('PATCH /v1/conversations/:id', () => {
  it('returns 200 with closed conversation when owner patches active conv', async () => {
    mockConvFindFirst.mockResolvedValue(ACTIVE_CONV as never);
    setupUpdateMock(CLOSED_CONV);

    const res = await request(app)
      .patch(`/v1/conversations/${ACTIVE_CONV.id}`)
      .set('Authorization', authHeader)
      .send({ status: 'closed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
    expect(res.body).toHaveProperty('ended_at');
  });

  it('sets ended_at in the DB update', async () => {
    mockConvFindFirst.mockResolvedValue(ACTIVE_CONV as never);
    const { set } = setupUpdateMock(CLOSED_CONV);

    await request(app)
      .patch(`/v1/conversations/${ACTIVE_CONV.id}`)
      .set('Authorization', authHeader)
      .send({ status: 'closed' });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'closed', endedAt: expect.any(Date) }),
    );
  });

  it('returns 404 when conversation does not exist', async () => {
    mockConvFindFirst.mockResolvedValue(undefined as never);

    const res = await request(app)
      .patch('/v1/conversations/non-existent')
      .set('Authorization', authHeader)
      .send({ status: 'closed' });

    expect(res.status).toBe(404);
  });

  it('returns 403 FORBIDDEN when conversation belongs to another user', async () => {
    mockConvFindFirst.mockResolvedValue({ ...ACTIVE_CONV, userId: OTHER_USER } as never);

    const res = await request(app)
      .patch(`/v1/conversations/${ACTIVE_CONV.id}`)
      .set('Authorization', authHeader)
      .send({ status: 'closed' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('returns 403 CONVERSATION_NOT_ACTIVE when conversation is already closed', async () => {
    mockConvFindFirst.mockResolvedValue(CLOSED_CONV as never);

    const res = await request(app)
      .patch(`/v1/conversations/${ACTIVE_CONV.id}`)
      .set('Authorization', authHeader)
      .send({ status: 'closed' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CONVERSATION_NOT_ACTIVE');
  });

  it('returns 403 CONVERSATION_NOT_ACTIVE when status is summarized', async () => {
    mockConvFindFirst.mockResolvedValue({ ...ACTIVE_CONV, status: 'summarized' } as never);

    const res = await request(app)
      .patch(`/v1/conversations/${ACTIVE_CONV.id}`)
      .set('Authorization', authHeader)
      .send({ status: 'closed' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CONVERSATION_NOT_ACTIVE');
  });

  it('returns 400 VALIDATION_ERROR when status is not "closed"', async () => {
    const res = await request(app)
      .patch(`/v1/conversations/${ACTIVE_CONV.id}`)
      .set('Authorization', authHeader)
      .send({ status: 'active' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR when status is missing', async () => {
    const res = await request(app)
      .patch(`/v1/conversations/${ACTIVE_CONV.id}`)
      .set('Authorization', authHeader)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .patch(`/v1/conversations/${ACTIVE_CONV.id}`)
      .send({ status: 'closed' });
    expect(res.status).toBe(401);
  });

  it('does not call db.update when the request is invalid', async () => {
    await request(app)
      .patch(`/v1/conversations/${ACTIVE_CONV.id}`)
      .set('Authorization', authHeader)
      .send({ status: 'active' });

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/conversations/:id
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/conversations/:id', () => {
  it('returns 200 with conversation metadata and messages', async () => {
    mockConvFindFirst.mockResolvedValue(ACTIVE_CONV as never);
    mockMsgFindMany.mockResolvedValue(SAMPLE_MESSAGES as never);

    const res = await request(app)
      .get(`/v1/conversations/${ACTIVE_CONV.id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id:            ACTIVE_CONV.id,
      status:        'active',
      message_count: 3,
    });
    expect(Array.isArray(res.body.messages)).toBe(true);
  });

  it('returns decrypted message content', async () => {
    mockConvFindFirst.mockResolvedValue(ACTIVE_CONV as never);
    mockMsgFindMany.mockResolvedValue(SAMPLE_MESSAGES as never);

    const res = await request(app)
      .get(`/v1/conversations/${ACTIVE_CONV.id}`)
      .set('Authorization', authHeader);

    expect(res.body.messages[0].content).toBe('decrypted content');
  });

  it('returns messages in chronological order (oldest first)', async () => {
    // Messages are fetched DESC then reversed — so the result should be
    // in ascending createdAt order
    mockConvFindFirst.mockResolvedValue(ACTIVE_CONV as never);
    mockMsgFindMany.mockResolvedValue(SAMPLE_MESSAGES as never); // already DESC from mock

    const res = await request(app)
      .get(`/v1/conversations/${ACTIVE_CONV.id}`)
      .set('Authorization', authHeader);

    // After .reverse(), msg-2 (newer) should come last
    expect(res.body.messages[0].id).toBe('msg-2');
    expect(res.body.messages[1].id).toBe('msg-1');
  });

  it('returns 404 when conversation does not exist', async () => {
    mockConvFindFirst.mockResolvedValue(undefined as never);

    const res = await request(app)
      .get('/v1/conversations/non-existent')
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
  });

  it('returns 404 (NOT 403) when conversation belongs to another user', async () => {
    mockConvFindFirst.mockResolvedValue({ ...ACTIVE_CONV, userId: OTHER_USER } as never);

    const res = await request(app)
      .get(`/v1/conversations/${ACTIVE_CONV.id}`)
      .set('Authorization', authHeader);

    // Must be 404, not 403 — avoids revealing that the conversation exists
    expect(res.status).toBe(404);
    expect(res.body.error).not.toBe('FORBIDDEN');
  });

  it('returns an empty messages array when the conversation has no messages yet', async () => {
    mockConvFindFirst.mockResolvedValue(ACTIVE_CONV as never);
    mockMsgFindMany.mockResolvedValue([] as never);

    const res = await request(app)
      .get(`/v1/conversations/${ACTIVE_CONV.id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });

  it('limits messages to 20 most recent', async () => {
    mockConvFindFirst.mockResolvedValue(ACTIVE_CONV as never);
    mockMsgFindMany.mockResolvedValue([] as never);

    await request(app)
      .get(`/v1/conversations/${ACTIVE_CONV.id}`)
      .set('Authorization', authHeader);

    expect(mockMsgFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get(`/v1/conversations/${ACTIVE_CONV.id}`);
    expect(res.status).toBe(401);
  });
});
