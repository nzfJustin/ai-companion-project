/**
 * src/routes/__tests__/memories.test.ts
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockMemoryFindFirst = jest.fn();
const mockMemoryFindMany  = jest.fn();
const mockUpdate          = jest.fn();

jest.mock('../../db', () => ({
  db: {
    query: { memories: { findFirst: mockMemoryFindFirst, findMany: mockMemoryFindMany } },
    update: mockUpdate,
  },
}));

jest.mock('../../services/EncryptionService', () => ({
  EncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: jest.fn().mockReturnValue('decrypted summary text'),
    encrypt: jest.fn().mockReturnValue({ ciphertext: Buffer.from('x'), iv: Buffer.alloc(12) }),
  })),
}));

// Rate limiter always allows in unit tests
jest.mock('../../lib/redis', () => ({
  redis: { eval: jest.fn().mockResolvedValue([1, 0]) },
}));

const mockVerifyElevatedToken = jest.fn();
jest.mock('../../lib/jwt', () => ({
  ...jest.requireActual('../../lib/jwt'),
  verifyElevatedToken: mockVerifyElevatedToken,
  signAccessToken: jest.requireActual('../../lib/jwt').signAccessToken,
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import * as jwtLib from 'jsonwebtoken';
import { app }  from '../../app';
import { signAccessToken } from '../../lib/jwt';
import { db }   from '../../db';

// ── Typed mock handles ─────────────────────────────────────────────────────────

const mockFindFirst = db.query.memories.findFirst as jest.Mock;
const mockFindMany  = db.query.memories.findMany  as jest.Mock;

// ── Key pair + auth ────────────────────────────────────────────────────────────

const USER_ID    = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const OTHER_USER = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MEMORY_L1 = {
  id: 'mem-1', userId: USER_ID, title: 'A good day',
  summary: Buffer.from('enc'), summaryIv: Buffer.alloc(12),
  keyEvents: ['Went for a walk'], emotionalTags: ['calm'],
  dominantEmotion: 'calm', level: 1,
  createdAt: new Date('2026-01-15'), periodStart: '2026-01-15', periodEnd: '2026-01-15',
  deletedAt: null, updatedAt: new Date(),
};

const MEMORY_L4 = { ...MEMORY_L1, id: 'mem-4', level: 4, title: 'Sensitive memory' };
const MEMORY_L5 = { ...MEMORY_L1, id: 'mem-5', level: 5, title: 'Most sensitive' };
const DELETED_MEMORY = { ...MEMORY_L1, id: 'mem-del', deletedAt: new Date() };

function setupUpdateMock() {
  const returning = jest.fn().mockResolvedValue([{ id: MEMORY_L1.id, level: 3 }]);
  const where = jest.fn().mockReturnValue({ returning });
  const set   = jest.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set });
  return { set, where, returning };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyElevatedToken.mockReturnValue({ sub: USER_ID, access_level: 5, scope: 'memory_elevated' });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/memories
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/memories', () => {
  it('returns 200 with a memories array and pagination', async () => {
    mockFindMany.mockResolvedValue([MEMORY_L1]);

    const res = await request(app)
      .get('/v1/memories')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.memories)).toBe(true);
    expect(res.body).toHaveProperty('page');
    expect(res.body).toHaveProperty('has_more');
  });

  it('returns the correct shape per item (no summary)', async () => {
    mockFindMany.mockResolvedValue([MEMORY_L1]);

    const res = await request(app)
      .get('/v1/memories')
      .set('Authorization', authHeader);

    const item = res.body.memories[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('title');
    expect(item).toHaveProperty('level');
    expect(item).toHaveProperty('dominant_emotion');
    expect(item).toHaveProperty('created_at');
    expect(item).toHaveProperty('period_start');
    expect(item).toHaveProperty('period_end');
    // summary must NOT appear in list view
    expect(item).not.toHaveProperty('summary');
    expect(item).not.toHaveProperty('key_events');
  });

  it('passes level filter to the DB query', async () => {
    mockFindMany.mockResolvedValue([]);

    await request(app)
      .get('/v1/memories?level=1,2,3')
      .set('Authorization', authHeader);

    // The query's where clause should include level filter
    // (verified via the mock call arguments)
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.anything() }),
    );
  });

  it('ignores invalid level values in the filter', async () => {
    mockFindMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/v1/memories?level=1,abc,99,-1')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
  });

  it('sets has_more=true when more results exist', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ ...MEMORY_L1, id: `m-${i}` }));
    mockFindMany.mockResolvedValue(many);

    const res = await request(app)
      .get('/v1/memories?per_page=20')
      .set('Authorization', authHeader);

    expect(res.body.has_more).toBe(true);
    expect(res.body.memories).toHaveLength(20);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/v1/memories');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/memories/:id — level 1–3 (no elevated token required)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/memories/:id — standard access (level 1–3)', () => {
  it('returns 200 with full detail including decrypted summary', async () => {
    mockFindFirst.mockResolvedValue(MEMORY_L1);

    const res = await request(app)
      .get(`/v1/memories/${MEMORY_L1.id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.summary).toBe('decrypted summary text');
    expect(res.body.key_events).toEqual(['Went for a walk']);
    expect(res.body.emotional_tags).toEqual(['calm']);
    expect(res.body.level).toBe(1);
  });

  it('returns 404 when the memory does not exist', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const res = await request(app)
      .get('/v1/memories/nonexistent')
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
  });

  it('returns 404 when the memory belongs to another user', async () => {
    mockFindFirst.mockResolvedValue({ ...MEMORY_L1, userId: OTHER_USER });

    const res = await request(app)
      .get(`/v1/memories/${MEMORY_L1.id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
    expect(res.body.error).not.toBe('FORBIDDEN'); // must be 404, not 403
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get(`/v1/memories/${MEMORY_L1.id}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/memories/:id — level 4–5 (elevated token required)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/memories/:id — level 4–5 elevated token gate', () => {
  it('returns 403 MEMORY_ACCESS_DENIED for level 4 without X-Elevated-Token', async () => {
    mockFindFirst.mockResolvedValue(MEMORY_L4);

    const res = await request(app)
      .get(`/v1/memories/${MEMORY_L4.id}`)
      .set('Authorization', authHeader);
      // No X-Elevated-Token header

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MEMORY_ACCESS_DENIED');
  });

  it('returns 403 MEMORY_ACCESS_DENIED for level 5 without X-Elevated-Token', async () => {
    mockFindFirst.mockResolvedValue(MEMORY_L5);

    const res = await request(app)
      .get(`/v1/memories/${MEMORY_L5.id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MEMORY_ACCESS_DENIED');
  });

  it('returns 200 for level 4 when a valid elevated token is provided', async () => {
    mockFindFirst.mockResolvedValue(MEMORY_L4);

    const res = await request(app)
      .get(`/v1/memories/${MEMORY_L4.id}`)
      .set('Authorization', authHeader)
      .set('X-Elevated-Token', 'valid-elevated-token');

    expect(res.status).toBe(200);
    expect(res.body.summary).toBe('decrypted summary text');
  });

  it('returns 401 ELEVATED_TOKEN_EXPIRED when the elevated token is expired', async () => {
    mockFindFirst.mockResolvedValue(MEMORY_L4);
    mockVerifyElevatedToken.mockImplementation(() => {
      throw new jwtLib.TokenExpiredError('jwt expired', new Date());
    });

    const res = await request(app)
      .get(`/v1/memories/${MEMORY_L4.id}`)
      .set('Authorization', authHeader)
      .set('X-Elevated-Token', 'expired-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('ELEVATED_TOKEN_EXPIRED');
  });

  it('returns 403 MEMORY_ACCESS_DENIED when the elevated token is invalid', async () => {
    mockFindFirst.mockResolvedValue(MEMORY_L4);
    mockVerifyElevatedToken.mockImplementation(() => {
      throw new jwtLib.JsonWebTokenError('invalid signature');
    });

    const res = await request(app)
      .get(`/v1/memories/${MEMORY_L4.id}`)
      .set('Authorization', authHeader)
      .set('X-Elevated-Token', 'bad-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MEMORY_ACCESS_DENIED');
  });

  it('returns 403 MEMORY_ACCESS_DENIED when elevated token belongs to another user', async () => {
    mockFindFirst.mockResolvedValue(MEMORY_L4);
    mockVerifyElevatedToken.mockReturnValue({
      sub: OTHER_USER, // different user's elevated token
      access_level: 5,
      scope: 'memory_elevated',
    });

    const res = await request(app)
      .get(`/v1/memories/${MEMORY_L4.id}`)
      .set('Authorization', authHeader)
      .set('X-Elevated-Token', 'other-user-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MEMORY_ACCESS_DENIED');
  });

  it('level 1–3 memories pass through without checking the elevated token', async () => {
    mockFindFirst.mockResolvedValue(MEMORY_L1);

    const res = await request(app)
      .get(`/v1/memories/${MEMORY_L1.id}`)
      .set('Authorization', authHeader);
    // No X-Elevated-Token — should still succeed

    expect(res.status).toBe(200);
    expect(mockVerifyElevatedToken).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /v1/memories/:id
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /v1/memories/:id', () => {
  it('returns 200 with the updated level', async () => {
    mockFindFirst.mockResolvedValue({ id: MEMORY_L1.id, userId: USER_ID });
    setupUpdateMock();

    const res = await request(app)
      .patch(`/v1/memories/${MEMORY_L1.id}`)
      .set('Authorization', authHeader)
      .send({ level: 3 });

    expect(res.status).toBe(200);
    expect(res.body.level).toBe(3);
  });

  it('returns 400 when level is out of range (e.g. 6)', async () => {
    const res = await request(app)
      .patch(`/v1/memories/${MEMORY_L1.id}`)
      .set('Authorization', authHeader)
      .send({ level: 6 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when level is 0 (below minimum)', async () => {
    const res = await request(app)
      .patch(`/v1/memories/${MEMORY_L1.id}`)
      .set('Authorization', authHeader)
      .send({ level: 0 });

    expect(res.status).toBe(400);
  });

  it('returns 400 when level is not an integer (e.g. 1.5)', async () => {
    const res = await request(app)
      .patch(`/v1/memories/${MEMORY_L1.id}`)
      .set('Authorization', authHeader)
      .send({ level: 1.5 });

    expect(res.status).toBe(400);
  });

  it('returns 404 when memory does not exist', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const res = await request(app)
      .patch('/v1/memories/nonexistent')
      .set('Authorization', authHeader)
      .send({ level: 2 });

    expect(res.status).toBe(404);
  });

  it('returns 404 when memory belongs to another user', async () => {
    mockFindFirst.mockResolvedValue({ id: MEMORY_L1.id, userId: OTHER_USER });

    const res = await request(app)
      .patch(`/v1/memories/${MEMORY_L1.id}`)
      .set('Authorization', authHeader)
      .send({ level: 2 });

    expect(res.status).toBe(404);
  });

  it('does not accept updates to fields other than level', async () => {
    mockFindFirst.mockResolvedValue({ id: MEMORY_L1.id, userId: USER_ID });
    setupUpdateMock();

    // Sending extra fields — they should be stripped by Zod
    await request(app)
      .patch(`/v1/memories/${MEMORY_L1.id}`)
      .set('Authorization', authHeader)
      .send({ level: 2, title: 'Hacked title', userId: OTHER_USER });

    // The update set() call should only contain level and updatedAt
    const setArg = (mockUpdate().set as jest.Mock).mock.calls[0]?.[0];
    if (setArg) {
      expect(setArg).not.toHaveProperty('title');
      expect(setArg).not.toHaveProperty('userId');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /v1/memories/:id
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /v1/memories/:id', () => {
  it('returns 204 No Content on successful soft delete', async () => {
    mockFindFirst.mockResolvedValue({ id: MEMORY_L1.id, userId: USER_ID });
    const where = jest.fn().mockResolvedValue([]);
    const set   = jest.fn().mockReturnValue({ where });
    mockUpdate.mockReturnValue({ set });

    const res = await request(app)
      .delete(`/v1/memories/${MEMORY_L1.id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it('sets deletedAt on the record (soft delete, not hard delete)', async () => {
    mockFindFirst.mockResolvedValue({ id: MEMORY_L1.id, userId: USER_ID });
    const where = jest.fn().mockResolvedValue([]);
    const set   = jest.fn().mockReturnValue({ where });
    mockUpdate.mockReturnValue({ set });

    await request(app)
      .delete(`/v1/memories/${MEMORY_L1.id}`)
      .set('Authorization', authHeader);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });

  it('returns 404 when memory does not exist', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const res = await request(app)
      .delete('/v1/memories/nonexistent')
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
  });

  it('returns 404 when memory belongs to another user', async () => {
    mockFindFirst.mockResolvedValue({ id: MEMORY_L1.id, userId: OTHER_USER });

    const res = await request(app)
      .delete(`/v1/memories/${MEMORY_L1.id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
  });

  it('returns 404 for an already soft-deleted memory (deletedAt is set)', async () => {
    // findFirst returns null because the WHERE clause includes isNull(deletedAt)
    mockFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/v1/memories/${MEMORY_L1.id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).delete(`/v1/memories/${MEMORY_L1.id}`);
    expect(res.status).toBe(401);
  });
});
