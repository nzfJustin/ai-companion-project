/**
 * src/routes/__tests__/auth.logout.test.ts
 *
 * Unit tests for POST /v1/auth/logout.
 * DB is mocked — no running services required.
 */

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

jest.mock('../../db', () => ({
  db: {
    query:  { authSessions: { findFirst: jest.fn() } },
    update: jest.fn(),
    insert: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('../../lib/jwt', () => ({
  signAccessToken:      jest.fn(),
  generateRefreshToken: jest.fn(),
  generateRawToken:     jest.fn(),
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

const ACTIVE_SESSION = {
  id:           'session-1',
  userId:       'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
  refreshToken: 'hashed(valid-raw-token)',
  tokenFamily:  'family-uuid-123',
  expiresAt:    new Date(NOW + 1000 * 60 * 60 * 24),
  revokedAt:    null,
  createdAt:    new Date(),
};

function withCookie(token: string) {
  return request(app)
    .post('/v1/auth/logout')
    .set('Cookie', `refresh_token=${token}`);
}

function setupUpdateMock() {
  const where = jest.fn().mockResolvedValue(undefined);
  const set   = jest.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set } as never);
  return { set, where };
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => jest.clearAllMocks());

// ── No cookie ─────────────────────────────────────────────────────────────────

describe('POST /v1/auth/logout — no cookie', () => {
  it('returns 401 TOKEN_EXPIRED when no refresh_token cookie is present', async () => {
    const res = await request(app).post('/v1/auth/logout');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'TOKEN_EXPIRED' });
  });
});

// ── Unknown / expired token ───────────────────────────────────────────────────

describe('POST /v1/auth/logout — unknown or expired token', () => {
  it('returns 401 TOKEN_EXPIRED when no session matches', async () => {
    mockFindFirst.mockResolvedValue(undefined as never);
    const res = await withCookie('garbage-token');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'TOKEN_EXPIRED' });
  });

  it('returns 401 TOKEN_EXPIRED for an already-expired session', async () => {
    mockFindFirst.mockResolvedValue({
      ...ACTIVE_SESSION,
      expiresAt: new Date(NOW - 1000),
    } as never);

    const res = await withCookie('expired-token');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'TOKEN_EXPIRED' });
  });

  it('does not call db.update for an unknown token', async () => {
    mockFindFirst.mockResolvedValue(undefined as never);
    await withCookie('garbage-token');
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('POST /v1/auth/logout — success', () => {
  it('returns 200 { success: true }', async () => {
    mockFindFirst.mockResolvedValue(ACTIVE_SESSION as never);
    setupUpdateMock();

    const res = await withCookie('valid-raw-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('revokes the session in the DB', async () => {
    mockFindFirst.mockResolvedValue(ACTIVE_SESSION as never);
    const { set, where } = setupUpdateMock();

    await withCookie('valid-raw-token');

    expect(mockUpdate).toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ revokedAt: expect.any(Date) }));
    expect(where).toHaveBeenCalled();
  });

  it('sets Set-Cookie with max-age=0', async () => {
    mockFindFirst.mockResolvedValue(ACTIVE_SESSION as never);
    setupUpdateMock();

    const res = await withCookie('valid-raw-token');
    const cookies: string[] = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const rtCookie = cookies.find((c) => c.startsWith('refresh_token='));

    expect(rtCookie).toMatch(/Max-Age=0/i);
  });

  it('is idempotent — does not error when called on an already-revoked session', async () => {
    mockFindFirst.mockResolvedValue({ ...ACTIVE_SESSION, revokedAt: new Date() } as never);
    setupUpdateMock();

    const res = await withCookie('valid-raw-token');

    expect(res.status).toBe(200);
    // Already revoked — should NOT call update again
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
