/**
 * src/routes/__tests__/auth.memoryPin.test.ts
 *
 * Unit tests for POST /v1/auth/memory-pin/set and
 * POST /v1/auth/memory-pin/verify.
 *
 * DB, Redis, and bcrypt are mocked. JWT is real (generated key pair) so
 * `authenticate` and `signElevatedToken` behave exactly as in production.
 */

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

jest.mock('../../db', () => ({
  db: {
    query:  { userMemoryPins: { findFirst: jest.fn() } },
    insert: jest.fn(),
  },
}));

jest.mock('../../lib/redis', () => ({
  redis: {
    exists: jest.fn(),
    incr:   jest.fn(),
    expire: jest.fn(),
    set:    jest.fn(),
    del:    jest.fn(),
  },
}));

jest.mock('bcryptjs', () => ({
  __esModule: true,
  default: {
    hash:    jest.fn(),
    compare: jest.fn(),
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { generateKeyPairSync } from 'node:crypto';
import jwt     from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../../app';
import { db }  from '../../db';
import { redis } from '../../lib/redis';
import bcrypt  from 'bcryptjs';
import {
  signAccessToken,
  ELEVATED_TOKEN_SCOPE,
  ELEVATED_ACCESS_LEVEL,
  ELEVATED_TOKEN_TTL_SEC,
} from '../../lib/jwt';

// ── Typed mock handles ────────────────────────────────────────────────────────

const mockFindFirst = db.query.userMemoryPins.findFirst as jest.MockedFunction<
  typeof db.query.userMemoryPins.findFirst
>;
const mockInsert  = db.insert as jest.MockedFunction<typeof db.insert>;
const mockExists  = redis.exists as jest.MockedFunction<typeof redis.exists>;
const mockIncr    = redis.incr   as jest.MockedFunction<typeof redis.incr>;
const mockExpire  = redis.expire as jest.MockedFunction<typeof redis.expire>;
const mockSet     = redis.set    as jest.MockedFunction<typeof redis.set>;
const mockDel     = redis.del    as jest.MockedFunction<typeof redis.del>;
const mockHash    = bcrypt.hash    as jest.MockedFunction<typeof bcrypt.hash>;
const mockCompare = bcrypt.compare as jest.MockedFunction<typeof bcrypt.compare>;

// ── Key pair + auth header ─────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
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

afterAll(() => {
  delete process.env.JWT_PRIVATE_KEY;
  delete process.env.JWT_PUBLIC_KEY;
});

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/auth/memory-pin/set
// ─────────────────────────────────────────────────────────────────────────────

function setupInsertMock() {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
  mockInsert.mockReturnValue({ values } as never);
  return { values, onConflictDoUpdate };
}

describe('POST /v1/auth/memory-pin/set', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await request(app).post('/v1/auth/memory-pin/set').send({ pin: '1234' });
    expect(res.status).toBe(401);
  });

  it('returns 200 { success: true } on valid 4-digit pin', async () => {
    mockHash.mockResolvedValue('$2b$12$pinhash' as never);
    setupInsertMock();
    mockDel.mockResolvedValue(1 as never);

    const res = await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', authHeader)
      .send({ pin: '1234' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it.each(['1234', '12345', '123456'])('accepts %s (4-6 digits)', async (pin) => {
    mockHash.mockResolvedValue('$2b$12$pinhash' as never);
    setupInsertMock();
    mockDel.mockResolvedValue(1 as never);

    const res = await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', authHeader)
      .send({ pin });

    expect(res.status).toBe(200);
  });

  it.each(['123', '1234567', 'abcd', '12 34', ''])('rejects invalid pin "%s"', async (pin) => {
    const res = await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', authHeader)
      .send({ pin });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('hashes the pin with bcrypt before storing', async () => {
    mockHash.mockResolvedValue('$2b$12$pinhash' as never);
    const { values } = setupInsertMock();
    mockDel.mockResolvedValue(1 as never);

    await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', authHeader)
      .send({ pin: '1234' });

    expect(mockHash).toHaveBeenCalledWith('1234', 12);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, pinHash: '$2b$12$pinhash' }),
    );
    expect(values).not.toHaveBeenCalledWith(
      expect.objectContaining({ pinHash: '1234' }),
    );
  });

  it('uses onConflictDoUpdate (upsert) so subsequent calls update the existing record', async () => {
    mockHash.mockResolvedValue('$2b$12$pinhash' as never);
    const { onConflictDoUpdate } = setupInsertMock();
    mockDel.mockResolvedValue(1 as never);

    await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', authHeader)
      .send({ pin: '1234' });

    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.anything(),
        set:    expect.objectContaining({ pinHash: '$2b$12$pinhash' }),
      }),
    );
  });

  it('clears any existing lockout state when a new pin is set', async () => {
    mockHash.mockResolvedValue('$2b$12$pinhash' as never);
    setupInsertMock();
    mockDel.mockResolvedValue(1 as never);

    await request(app)
      .post('/v1/auth/memory-pin/set')
      .set('Authorization', authHeader)
      .send({ pin: '1234' });

    expect(mockDel).toHaveBeenCalledWith(`pin_lock:${USER_ID}`, `pin_fail:${USER_ID}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/auth/memory-pin/verify
// ─────────────────────────────────────────────────────────────────────────────

const STORED_PIN_RECORD = {
  id:        'pin-row-1',
  userId:    USER_ID,
  pinHash:   '$2b$12$storedhash',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('POST /v1/auth/memory-pin/verify', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await request(app).post('/v1/auth/memory-pin/verify').send({ pin: '1234' });
    expect(res.status).toBe(401);
  });

  it.each(['123', '1234567', 'abcd', ''])('rejects invalid pin format "%s" (400)', async (pin) => {
    const res = await request(app)
      .post('/v1/auth/memory-pin/verify')
      .set('Authorization', authHeader)
      .send({ pin });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  describe('when locked', () => {
    it('returns 429 PIN_LOCKED without checking the DB', async () => {
      mockExists.mockResolvedValue(1 as never);

      const res = await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', authHeader)
        .send({ pin: '1234' });

      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ error: 'PIN_LOCKED' });
      expect(mockFindFirst).not.toHaveBeenCalled();
    });
  });

  describe('when no pin has been set', () => {
    it('returns 404 PIN_NOT_SET', async () => {
      mockExists.mockResolvedValue(0 as never);
      mockFindFirst.mockResolvedValue(undefined as never);

      const res = await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', authHeader)
        .send({ pin: '1234' });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: 'PIN_NOT_SET' });
    });

    it('does not count toward the failure counter', async () => {
      mockExists.mockResolvedValue(0 as never);
      mockFindFirst.mockResolvedValue(undefined as never);

      await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', authHeader)
        .send({ pin: '1234' });

      expect(mockIncr).not.toHaveBeenCalled();
    });
  });

  describe('correct pin', () => {
    it('returns 200 with an elevated token', async () => {
      mockExists.mockResolvedValue(0 as never);
      mockFindFirst.mockResolvedValue(STORED_PIN_RECORD as never);
      mockCompare.mockResolvedValue(true as never);
      mockDel.mockResolvedValue(1 as never);

      const res = await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', authHeader)
        .send({ pin: '1234' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        elevated_token: expect.any(String),
        token_type:     'Bearer',
        expires_in:     ELEVATED_TOKEN_TTL_SEC,
        scope:          ELEVATED_TOKEN_SCOPE,
      });
    });

    it('the elevated token carries access_level: 5 and scope: memory_elevated', async () => {
      mockExists.mockResolvedValue(0 as never);
      mockFindFirst.mockResolvedValue(STORED_PIN_RECORD as never);
      mockCompare.mockResolvedValue(true as never);
      mockDel.mockResolvedValue(1 as never);

      const res = await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', authHeader)
        .send({ pin: '1234' });

      const decoded = jwt.decode(res.body.elevated_token) as Record<string, unknown>;
      expect(decoded.sub).toBe(USER_ID);
      expect(decoded.access_level).toBe(ELEVATED_ACCESS_LEVEL);
      expect(decoded.scope).toBe(ELEVATED_TOKEN_SCOPE);
    });

    it('resets the failure counter on success', async () => {
      mockExists.mockResolvedValue(0 as never);
      mockFindFirst.mockResolvedValue(STORED_PIN_RECORD as never);
      mockCompare.mockResolvedValue(true as never);
      mockDel.mockResolvedValue(1 as never);

      await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', authHeader)
        .send({ pin: '1234' });

      expect(mockDel).toHaveBeenCalledWith(`pin_fail:${USER_ID}`);
    });
  });

  describe('incorrect pin', () => {
    it('returns 401 INVALID_PIN on the first/second failure', async () => {
      mockExists.mockResolvedValue(0 as never);
      mockFindFirst.mockResolvedValue(STORED_PIN_RECORD as never);
      mockCompare.mockResolvedValue(false as never);
      mockIncr.mockResolvedValue(1 as never);

      const res = await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', authHeader)
        .send({ pin: '9999' });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'INVALID_PIN' });
    });

    it('sets a 10-minute expiry on the failure counter after the first failure', async () => {
      mockExists.mockResolvedValue(0 as never);
      mockFindFirst.mockResolvedValue(STORED_PIN_RECORD as never);
      mockCompare.mockResolvedValue(false as never);
      mockIncr.mockResolvedValue(1 as never); // first failure

      await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', authHeader)
        .send({ pin: '9999' });

      expect(mockExpire).toHaveBeenCalledWith(`pin_fail:${USER_ID}`, 10 * 60);
    });

    it('does NOT reset expiry on the second failure', async () => {
      mockExists.mockResolvedValue(0 as never);
      mockFindFirst.mockResolvedValue(STORED_PIN_RECORD as never);
      mockCompare.mockResolvedValue(false as never);
      mockIncr.mockResolvedValue(2 as never); // second failure

      await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', authHeader)
        .send({ pin: '9999' });

      expect(mockExpire).not.toHaveBeenCalled();
    });

    it('on the 3rd consecutive failure: locks the pin and returns 429 PIN_LOCKED', async () => {
      mockExists.mockResolvedValue(0 as never);
      mockFindFirst.mockResolvedValue(STORED_PIN_RECORD as never);
      mockCompare.mockResolvedValue(false as never);
      mockIncr.mockResolvedValue(3 as never); // third failure
      mockSet.mockResolvedValue('OK' as never);
      mockDel.mockResolvedValue(1 as never);

      const res = await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', authHeader)
        .send({ pin: '9999' });

      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ error: 'PIN_LOCKED' });
    });

    it('sets pin_lock with a 15-minute TTL on the 3rd failure', async () => {
      mockExists.mockResolvedValue(0 as never);
      mockFindFirst.mockResolvedValue(STORED_PIN_RECORD as never);
      mockCompare.mockResolvedValue(false as never);
      mockIncr.mockResolvedValue(3 as never);
      mockSet.mockResolvedValue('OK' as never);
      mockDel.mockResolvedValue(1 as never);

      await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', authHeader)
        .send({ pin: '9999' });

      expect(mockSet).toHaveBeenCalledWith(`pin_lock:${USER_ID}`, '1', 'EX', 15 * 60);
    });

    it('clears the failure counter once locked', async () => {
      mockExists.mockResolvedValue(0 as never);
      mockFindFirst.mockResolvedValue(STORED_PIN_RECORD as never);
      mockCompare.mockResolvedValue(false as never);
      mockIncr.mockResolvedValue(3 as never);
      mockSet.mockResolvedValue('OK' as never);
      mockDel.mockResolvedValue(1 as never);

      await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', authHeader)
        .send({ pin: '9999' });

      expect(mockDel).toHaveBeenCalledWith(`pin_fail:${USER_ID}`);
    });

    it('does not issue an elevated token on failure', async () => {
      mockExists.mockResolvedValue(0 as never);
      mockFindFirst.mockResolvedValue(STORED_PIN_RECORD as never);
      mockCompare.mockResolvedValue(false as never);
      mockIncr.mockResolvedValue(1 as never);

      const res = await request(app)
        .post('/v1/auth/memory-pin/verify')
        .set('Authorization', authHeader)
        .send({ pin: '9999' });

      expect(res.body).not.toHaveProperty('elevated_token');
    });
  });
});
