/**
 * src/routes/__tests__/auth.refresh.test.ts
 *
 * Unit tests for POST /v1/auth/refresh.
 * DB is mocked — no running services required.
 */

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

const mockTxUpdate = jest.fn();
const mockTxInsert = jest.fn();

jest.mock('../../db', () => ({
  db: {
    query: { authSessions: { findFirst: jest.fn() } },
    update: jest.fn(),
    insert: jest.fn(),
    transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
      cb({ update: mockTxUpdate, insert: mockTxInsert }),
    ),
  },
}));

jest.mock('../../lib/jwt', () => ({
  signAccessToken:      jest.fn().mockReturnValue('mock.access.token'),
  generateRefreshToken: jest.fn().mockReturnValue({ token: 'login-token', family: 'login-family' }),
  generateRawToken:     jest.fn().mockReturnValue('new-raw-token'),
  hashRefreshToken:     jest.fn((t: string) => `hashed(${t})`),
  refreshCookieOptions: jest.fn((maxAge: number) => ({
    httpOnly: true,
    secure:   false,
    sameSite: 'strict',
    path:     '/v1/auth',
    maxAge,
  })),
  ACCESS_TOKEN_TTL_SEC: 900,
  REFRESH_TOKEN_TTL_MS: 2_592_000_000,
  REFRESH_COOKIE_NAME:  'refresh_token',
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import request from 'supertest';
import { app } from '../../app';
import { db }  from '../../db';

// ── Typed mock handles ────────────────────────────────────────────────────────

const mockFindFirst = db.query.authSessions.findFirst as jest.MockedFunction<
  typeof db.query.authSessions.findFirst
>;
const mockUpdate = db.update as jest.MockedFunction<typeof db.update>;

// ── Fixtures ───────────────────────────────────────────────────────────────────

const NOW = Date.now();
const USER_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const FAMILY  = 'family-uuid-123';

const VALID_SESSION = {
  id:           'session-1',
  userId:       USER_ID,
  refreshToken: 'hashed(valid-raw-token)',
  tokenFamily:  FAMILY,
  expiresAt:    new Date(NOW + 1000 * 60 * 60 * 24),  // 1 day from now
  revokedAt:    null,
  createdAt:    new Date(),
};

function withCookie(token: string) {
  return request(app)
    .post('/v1/auth/refresh')
    .set('Cookie', `refresh_token=${token}`);
}

function setupUpdateMock() {
  const where = jest.fn().mockResolvedValue(undefined);
  const set   = jest.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set } as never);
  return { set, where };
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockTxUpdate.mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) });
  mockTxInsert.mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });
});

// ── No cookie ─────────────────────────────────────────────────────────────────

describe('POST /v1/auth/refresh — no cookie', () => {
  it('returns 401 TOKEN_EXPIRED when no refresh_token cookie is present', async () => {
    const res = await request(app).post('/v1/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'TOKEN_EXPIRED' });
  });

  it('does not query the DB', async () => {
    await request(app).post('/v1/auth/refresh');
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

// ── Unknown token ─────────────────────────────────────────────────────────────

describe('POST /v1/auth/refresh — unknown token', () => {
  it('returns 401 TOKEN_EXPIRED when no session matches the hash', async () => {
    mockFindFirst.mockResolvedValue(undefined as never);
    const res = await withCookie('garbage-token');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'TOKEN_EXPIRED' });
  });

  it('clears the cookie', async () => {
    mockFindFirst.mockResolvedValue(undefined as never);
    const res = await withCookie('garbage-token');
    const cookies: string[] = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.some((c) => c.startsWith('refresh_token=;') || c.includes('refresh_token=;'))).toBe(true);
  });

  it('looks up the session by the HASH, not the raw token', async () => {
    mockFindFirst.mockResolvedValue(undefined as never);
    await withCookie('garbage-token');
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.anything() }),
    );
  });
});

// ── Reuse detection ────────────────────────────────────────────────────────────

describe('POST /v1/auth/refresh — reuse detection', () => {
  it('returns 401 TOKEN_REUSE_DETECTED when the token was already revoked', async () => {
    mockFindFirst.mockResolvedValue({ ...VALID_SESSION, revokedAt: new Date() } as never);
    setupUpdateMock();

    const res = await withCookie('reused-token');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'TOKEN_REUSE_DETECTED' });
  });

  it('revokes the entire token family', async () => {
    mockFindFirst.mockResolvedValue({ ...VALID_SESSION, revokedAt: new Date() } as never);
    const { set, where } = setupUpdateMock();

    await withCookie('reused-token');

    expect(mockUpdate).toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ revokedAt: expect.any(Date) }));
    expect(where).toHaveBeenCalled(); // family + isNull(revokedAt) condition
  });

  it('does not start a rotation transaction on reuse', async () => {
    mockFindFirst.mockResolvedValue({ ...VALID_SESSION, revokedAt: new Date() } as never);
    setupUpdateMock();

    await withCookie('reused-token');

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('clears the cookie on reuse detection', async () => {
    mockFindFirst.mockResolvedValue({ ...VALID_SESSION, revokedAt: new Date() } as never);
    setupUpdateMock();

    const res = await withCookie('reused-token');
    const cookies: string[] = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.some((c) => c.includes('refresh_token=;'))).toBe(true);
  });
});

// ── Expiry ────────────────────────────────────────────────────────────────────

describe('POST /v1/auth/refresh — expired token', () => {
  it('returns 401 TOKEN_EXPIRED for a past expiresAt', async () => {
    mockFindFirst.mockResolvedValue({
      ...VALID_SESSION,
      expiresAt: new Date(NOW - 1000),
    } as never);

    const res = await withCookie('expired-token');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'TOKEN_EXPIRED' });
  });

  it('does not start a rotation transaction on expiry', async () => {
    mockFindFirst.mockResolvedValue({
      ...VALID_SESSION,
      expiresAt: new Date(NOW - 1000),
    } as never);

    await withCookie('expired-token');

    expect(db.transaction).not.toHaveBeenCalled();
  });
});

// ── Happy path: rotation ──────────────────────────────────────────────────────

describe('POST /v1/auth/refresh — success (rotation)', () => {
  it('returns 200 with a new access token', async () => {
    mockFindFirst.mockResolvedValue(VALID_SESSION as never);
    const res = await withCookie('valid-raw-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      access_token: 'mock.access.token',
      token_type:   'Bearer',
      expires_in:   900,
    });
  });

  it('runs the rotation inside db.transaction', async () => {
    mockFindFirst.mockResolvedValue(VALID_SESSION as never);
    await withCookie('valid-raw-token');
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('revokes the old session row inside the transaction', async () => {
    mockFindFirst.mockResolvedValue(VALID_SESSION as never);
    await withCookie('valid-raw-token');
    expect(mockTxUpdate).toHaveBeenCalled();
  });

  it('inserts a new session row with the SAME token_family', async () => {
    mockFindFirst.mockResolvedValue(VALID_SESSION as never);
    await withCookie('valid-raw-token');

    expect(mockTxInsert).toHaveBeenCalled();
    const valuesFn = (mockTxInsert.mock.results[0].value as { values: jest.Mock }).values;
    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId:       USER_ID,
        tokenFamily:  FAMILY,                       // unchanged — rotation, not new chain
        refreshToken: 'hashed(new-raw-token)',       // new hash
      }),
    );
  });

  it('sets a new raw refresh token cookie', async () => {
    mockFindFirst.mockResolvedValue(VALID_SESSION as never);
    const res = await withCookie('valid-raw-token');

    const cookies: string[] = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const rtCookie = cookies.find((c) => c.startsWith('refresh_token='));
    expect(rtCookie).toMatch(/refresh_token=new-raw-token/);
    expect(rtCookie).toMatch(/HttpOnly/i);
  });
});
