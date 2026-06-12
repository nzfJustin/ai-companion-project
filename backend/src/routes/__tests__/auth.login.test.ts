/**
 * src/routes/__tests__/auth.login.test.ts
 *
 * Unit tests for POST /v1/auth/login.
 * DB, bcrypt, and JWT are all mocked — no running services required.
 */

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

jest.mock('../../db', () => ({
  db: {
    query:  { users: { findFirst: jest.fn() } },
    insert: jest.fn(),
  },
}));

jest.mock('bcryptjs', () => ({
  __esModule: true,
  default: { hash: jest.fn(), compare: jest.fn() },
}));

jest.mock('../../lib/jwt', () => ({
  signAccessToken:      jest.fn().mockReturnValue('mock.access.token'),
  generateRefreshToken: jest.fn().mockReturnValue({ token: 'mock-refresh-hex', family: 'mock-family-uuid' }),
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

const mockFindFirst = db.query.users.findFirst as jest.MockedFunction<
  typeof db.query.users.findFirst
>;
const mockInsert    = db.insert as jest.MockedFunction<typeof db.insert>;
const mockCompare   = bcrypt.compare as jest.MockedFunction<typeof bcrypt.compare>;

// ── Fixture helpers ───────────────────────────────────────────────────────────

const VALID_BODY = { email: 'alice@example.com', password: 'password123' };

const EXISTING_USER = {
  id:           'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
  passwordHash: '$2b$12$hashedpassword',
  deletedAt:    null,
};

function setupHappyPath() {
  mockFindFirst.mockResolvedValue(EXISTING_USER as never);
  mockCompare.mockResolvedValue(true as never);
  mockInsert.mockReturnValue({
    values: jest.fn().mockResolvedValue(undefined),
  } as never);
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => jest.clearAllMocks());

// ── Happy path ────────────────────────────────────────────────────────────────

describe('POST /v1/auth/login — success', () => {
  it('returns 200', async () => {
    setupHappyPath();
    const res = await request(app).post('/v1/auth/login').send(VALID_BODY);
    expect(res.status).toBe(200);
  });

  it('returns access_token, token_type, and expires_in', async () => {
    setupHappyPath();
    const res = await request(app).post('/v1/auth/login').send(VALID_BODY);
    expect(res.body).toEqual({
      access_token: 'mock.access.token',
      token_type:   'Bearer',
      expires_in:   900,
    });
  });

  it('sets an HttpOnly refresh_token cookie', async () => {
    setupHappyPath();
    const res = await request(app).post('/v1/auth/login').send(VALID_BODY);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const rtCookie = cookies.find((c) => c.startsWith('refresh_token='));
    expect(rtCookie).toBeDefined();
    expect(rtCookie).toMatch(/HttpOnly/i);
  });

  it('cookie is scoped to /v1/auth path', async () => {
    setupHappyPath();
    const res = await request(app).post('/v1/auth/login').send(VALID_BODY);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const rtCookie = cookies.find((c) => c.startsWith('refresh_token='));
    expect(rtCookie).toMatch(/Path=\/v1\/auth/i);
  });

  it('response does not expose the refresh token in the body', async () => {
    setupHappyPath();
    const res = await request(app).post('/v1/auth/login').send(VALID_BODY);
    expect(res.body).not.toHaveProperty('refresh_token');
  });

  it('persists a session row via db.insert', async () => {
    setupHappyPath();
    await request(app).post('/v1/auth/login').send(VALID_BODY);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const valuesFn = (mockInsert.mock.results[0].value as { values: jest.Mock }).values;
    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId:       EXISTING_USER.id,
        refreshToken: 'mock-refresh-hex',
        tokenFamily:  'mock-family-uuid',
      }),
    );
  });
});

// ── Invalid credentials ───────────────────────────────────────────────────────

describe('POST /v1/auth/login — invalid credentials', () => {
  it('returns 401 when user does not exist', async () => {
    mockFindFirst.mockResolvedValue(undefined as never);
    const res = await request(app).post('/v1/auth/login').send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'INVALID_CREDENTIALS' });
  });

  it('returns 401 when password is wrong', async () => {
    mockFindFirst.mockResolvedValue(EXISTING_USER as never);
    mockCompare.mockResolvedValue(false as never);
    const res = await request(app).post('/v1/auth/login').send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'INVALID_CREDENTIALS' });
  });

  it('returns 401 for a soft-deleted user', async () => {
    mockFindFirst.mockResolvedValue({
      ...EXISTING_USER,
      deletedAt: new Date(),
    } as never);
    const res = await request(app).post('/v1/auth/login').send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('gives same error for wrong email and wrong password (no enumeration)', async () => {
    // Wrong email
    mockFindFirst.mockResolvedValue(undefined as never);
    const r1 = await request(app).post('/v1/auth/login').send(VALID_BODY);

    // Wrong password
    mockFindFirst.mockResolvedValue(EXISTING_USER as never);
    mockCompare.mockResolvedValue(false as never);
    const r2 = await request(app).post('/v1/auth/login').send(VALID_BODY);

    expect(r1.body.error).toBe(r2.body.error);
    expect(r1.status).toBe(r2.status);
  });

  it('does not call db.insert when credentials are invalid', async () => {
    mockFindFirst.mockResolvedValue(undefined as never);
    await request(app).post('/v1/auth/login').send(VALID_BODY);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

// ── Input validation ──────────────────────────────────────────────────────────

describe('POST /v1/auth/login — validation errors', () => {
  const cases: Array<[string, object, string]> = [
    ['missing email',        { password: 'pass' },             'email'],
    ['invalid email format', { email: 'notanemail', password: 'pass' }, 'email'],
    ['missing password',     { email: 'a@b.com' },             'password'],
    ['empty body',           {},                                'email'],
  ];

  test.each(cases)('%s → 400', async (_label, body, field) => {
    const res = await request(app).post('/v1/auth/login').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.errors.some((e: { field: string }) => e.field === field)).toBe(true);
  });

  it('does not call the DB on validation failure', async () => {
    await request(app).post('/v1/auth/login').send({});
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});
