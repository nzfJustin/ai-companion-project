/**
 * src/routes/__tests__/auth.native.test.ts
 *
 * Unit tests for the native-client refresh-token transport (#62):
 * login with `client: "native"` returns the refresh token in the body, and
 * /refresh + /logout accept it back as `refresh_token` in the body.
 * DB, bcrypt, and JWT are all mocked — no running services required.
 */

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

const mockTxUpdate = jest.fn();
const mockTxInsert = jest.fn();

jest.mock('../../db', () => ({
  db: {
    query: {
      users:        { findFirst: jest.fn() },
      authSessions: { findFirst: jest.fn() },
    },
    update: jest.fn(),
    insert: jest.fn(),
    transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
      cb({ update: mockTxUpdate, insert: mockTxInsert }),
    ),
  },
}));

jest.mock('bcryptjs', () => ({
  __esModule: true,
  default: {
    hash:    jest.fn().mockResolvedValue('$2b$12$dummyhash'),
    compare: jest.fn(),
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
import bcrypt  from 'bcryptjs';

// ── Typed mock handles ────────────────────────────────────────────────────────

const mockUserFind    = db.query.users.findFirst as jest.MockedFunction<typeof db.query.users.findFirst>;
const mockSessionFind = db.query.authSessions.findFirst as jest.MockedFunction<
  typeof db.query.authSessions.findFirst
>;
const mockInsert  = db.insert as jest.MockedFunction<typeof db.insert>;
const mockUpdate  = db.update as jest.MockedFunction<typeof db.update>;
const mockCompare = bcrypt.compare as jest.MockedFunction<typeof bcrypt.compare>;

// ── Fixtures ───────────────────────────────────────────────────────────────────

const NOW     = Date.now();
const USER_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';

const LOGIN_BODY = { email: 'alice@example.com', password: 'password123' };

const ACTIVE_SESSION = {
  id:           'session-1',
  userId:       USER_ID,
  refreshToken: 'hashed(native-raw-token)',
  tokenFamily:  'family-uuid-123',
  expiresAt:    new Date(NOW + 1000 * 60 * 60 * 24),
  revokedAt:    null,
  createdAt:    new Date(),
};

function setCookies(res: request.Response): string[] {
  return (res.headers['set-cookie'] as unknown as string[]) ?? [];
}

function setupUpdateMock() {
  const where = jest.fn().mockResolvedValue(undefined);
  const set   = jest.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set } as never);
  return { set, where };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTxUpdate.mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) });
  mockTxInsert.mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });
});

// ── Login ─────────────────────────────────────────────────────────────────────

describe('POST /v1/auth/login — client: "native"', () => {
  beforeEach(() => {
    mockUserFind.mockResolvedValue({ id: USER_ID, passwordHash: '$2b$12$x', deletedAt: null } as never);
    mockCompare.mockResolvedValue(true as never);
    mockInsert.mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) } as never);
  });

  it('returns the refresh token in the body', async () => {
    const res = await request(app).post('/v1/auth/login').send({ ...LOGIN_BODY, client: 'native' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      access_token:  'mock.access.token',
      token_type:    'Bearer',
      expires_in:    900,
      refresh_token: 'login-token',
    });
  });

  it('does not set a refresh_token cookie', async () => {
    const res = await request(app).post('/v1/auth/login').send({ ...LOGIN_BODY, client: 'native' });
    expect(setCookies(res).some((c) => c.startsWith('refresh_token='))).toBe(false);
  });

  it('still stores only the hash of the token', async () => {
    const values = jest.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values } as never);
    await request(app).post('/v1/auth/login').send({ ...LOGIN_BODY, client: 'native' });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'hashed(login-token)' }));
  });

  it('keeps the token out of the body for web logins', async () => {
    const res = await request(app).post('/v1/auth/login').send({ ...LOGIN_BODY, client: 'web' });
    expect(res.body.refresh_token).toBeUndefined();
    expect(setCookies(res).some((c) => c.startsWith('refresh_token=login-token'))).toBe(true);
  });

  it('rejects an unknown client value with 400', async () => {
    const res = await request(app).post('/v1/auth/login').send({ ...LOGIN_BODY, client: 'android-tv' });
    expect(res.status).toBe(400);
  });
});

// ── Refresh ───────────────────────────────────────────────────────────────────

describe('POST /v1/auth/refresh — refresh_token in body', () => {
  const refreshWithBody = (token: string) =>
    request(app).post('/v1/auth/refresh').send({ refresh_token: token });

  it('rotates and returns the new refresh token in the body', async () => {
    mockSessionFind.mockResolvedValue(ACTIVE_SESSION as never);
    const res = await refreshWithBody('native-raw-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      access_token:  'mock.access.token',
      token_type:    'Bearer',
      expires_in:    900,
      refresh_token: 'new-raw-token',
    });
    expect(db.transaction).toHaveBeenCalled();
  });

  it('does not set a cookie', async () => {
    mockSessionFind.mockResolvedValue(ACTIVE_SESSION as never);
    const res = await refreshWithBody('native-raw-token');
    expect(setCookies(res).some((c) => c.startsWith('refresh_token='))).toBe(false);
  });

  it('prefers the body token over a cookie', async () => {
    mockSessionFind.mockResolvedValue(ACTIVE_SESSION as never);
    const res = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', 'refresh_token=cookie-token')
      .send({ refresh_token: 'native-raw-token' });
    expect(res.body.refresh_token).toBe('new-raw-token');
    expect(setCookies(res).some((c) => c.startsWith('refresh_token='))).toBe(false);
  });

  it('never returns a cookie-supplied token in the body', async () => {
    mockSessionFind.mockResolvedValue(ACTIVE_SESSION as never);
    const res = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', 'refresh_token=native-raw-token')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.refresh_token).toBeUndefined();
  });

  it('returns 401 TOKEN_EXPIRED for an unknown token', async () => {
    mockSessionFind.mockResolvedValue(undefined as never);
    const res = await refreshWithBody('garbage');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'TOKEN_EXPIRED' });
  });

  it('returns 401 TOKEN_EXPIRED for an expired session', async () => {
    mockSessionFind.mockResolvedValue({ ...ACTIVE_SESSION, expiresAt: new Date(NOW - 1000) } as never);
    const res = await refreshWithBody('native-raw-token');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'TOKEN_EXPIRED' });
  });

  it('detects reuse and revokes the whole family', async () => {
    mockSessionFind.mockResolvedValue({ ...ACTIVE_SESSION, revokedAt: new Date() } as never);
    const { set } = setupUpdateMock();
    const res = await refreshWithBody('native-raw-token');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'TOKEN_REUSE_DETECTED' });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ revokedAt: expect.any(Date) }));
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('ignores a non-string refresh_token and falls back to the cookie', async () => {
    const res = await request(app).post('/v1/auth/refresh').send({ refresh_token: 123 });
    expect(res.status).toBe(401);
    expect(mockSessionFind).not.toHaveBeenCalled();
  });
});

// ── Logout ────────────────────────────────────────────────────────────────────

describe('POST /v1/auth/logout — refresh_token in body', () => {
  it('revokes the session and returns 200', async () => {
    mockSessionFind.mockResolvedValue(ACTIVE_SESSION as never);
    const { set } = setupUpdateMock();
    const res = await request(app).post('/v1/auth/logout').send({ refresh_token: 'native-raw-token' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ revokedAt: expect.any(Date) }));
  });

  it('does not touch cookies', async () => {
    mockSessionFind.mockResolvedValue(ACTIVE_SESSION as never);
    setupUpdateMock();
    const res = await request(app).post('/v1/auth/logout').send({ refresh_token: 'native-raw-token' });
    expect(setCookies(res)).toHaveLength(0);
  });

  it('returns 401 TOKEN_EXPIRED for an unknown token', async () => {
    mockSessionFind.mockResolvedValue(undefined as never);
    const res = await request(app).post('/v1/auth/logout').send({ refresh_token: 'garbage' });
    expect(res.status).toBe(401);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
