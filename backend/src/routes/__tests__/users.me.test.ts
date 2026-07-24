/**
 * src/routes/__tests__/users.me.test.ts
 *
 * Unit tests for GET/PATCH /v1/users/me.
 * DB is mocked; JWT is real (generated key pair) so `authenticate`
 * behaves exactly as it would in production.
 */

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

jest.mock('../../db', () => ({
  db: {
    query:  { users: { findFirst: jest.fn() } },
    update: jest.fn(),
    select: jest.fn(),
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { app } from '../../app';
import { db }  from '../../db';
import { signAccessToken } from '../../lib/jwt';

// ── Typed mock handles ────────────────────────────────────────────────────────

const mockFindFirst = db.query.users.findFirst as jest.MockedFunction<
  typeof db.query.users.findFirst
>;
const mockUpdate = db.update as jest.MockedFunction<typeof db.update>;

// ─── Key pair + auth header ───────────────────────────────────────────────────

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_USER = {
  id:             USER_ID,
  email:          'alice@example.com',
  displayName:    'Alice',
  timezone:       'UTC',
  commStyle:      'warm',
  onboardingDone: false,
  createdAt:      new Date('2026-01-01T00:00:00Z'),
  deletedAt:      null,
};

function setupUpdateMock(returnedUser: typeof BASE_USER) {
  const returning = jest.fn().mockResolvedValue([returnedUser]);
  const where      = jest.fn().mockReturnValue({ returning });
  const set        = jest.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set } as never);
  return { set, where, returning };
}

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/users/me
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/users/me', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await request(app).get('/v1/users/me');
    expect(res.status).toBe(401);
  });

  it('returns 200 with the expected shape', async () => {
    mockFindFirst.mockResolvedValue(BASE_USER as never);

    const res = await request(app)
      .get('/v1/users/me')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id:              BASE_USER.id,
      email:           BASE_USER.email,
      display_name:    BASE_USER.displayName,
      timezone:        BASE_USER.timezone,
      comm_style:      BASE_USER.commStyle,
      onboarding_done: BASE_USER.onboardingDone,
      created_at:      BASE_USER.createdAt.toISOString(),
    });
  });

  it('includes email in the response', async () => {
    mockFindFirst.mockResolvedValue(BASE_USER as never);
    const res = await request(app).get('/v1/users/me').set('Authorization', authHeader);
    expect(res.body.email).toBe('alice@example.com');
  });

  it('queries by the authenticated userId', async () => {
    mockFindFirst.mockResolvedValue(BASE_USER as never);
    await request(app).get('/v1/users/me').set('Authorization', authHeader);
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.anything() }),
    );
  });

  it('returns 404 if the user no longer exists', async () => {
    mockFindFirst.mockResolvedValue(undefined as never);
    const res = await request(app).get('/v1/users/me').set('Authorization', authHeader);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'USER_NOT_FOUND' });
  });

  it('returns 404 for a soft-deleted user', async () => {
    mockFindFirst.mockResolvedValue({ ...BASE_USER, deletedAt: new Date() } as never);
    const res = await request(app).get('/v1/users/me').set('Authorization', authHeader);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /v1/users/me
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /v1/users/me', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await request(app).patch('/v1/users/me').send({ display_name: 'X' });
    expect(res.status).toBe(401);
  });

  it('updates display_name', async () => {
    setupUpdateMock({ ...BASE_USER, displayName: 'New Name' });

    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', authHeader)
      .send({ display_name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('New Name');
  });

  it('updates timezone', async () => {
    setupUpdateMock({ ...BASE_USER, timezone: 'America/Los_Angeles' });

    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', authHeader)
      .send({ timezone: 'America/Los_Angeles' });

    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe('America/Los_Angeles');
  });

  it.each(['warm', 'direct', 'reflective'])('accepts comm_style=%s', async (style) => {
    setupUpdateMock({ ...BASE_USER, commStyle: style });

    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', authHeader)
      .send({ comm_style: style });

    expect(res.status).toBe(200);
    expect(res.body.comm_style).toBe(style);
  });

  it('returns 400 INVALID_COMM_STYLE for an invalid value', async () => {
    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', authHeader)
      .send({ comm_style: 'sarcastic' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'INVALID_COMM_STYLE' });
  });

  it('does not call db.update when comm_style is invalid', async () => {
    await request(app)
      .patch('/v1/users/me')
      .set('Authorization', authHeader)
      .send({ comm_style: 'sarcastic' });

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('silently strips unknown fields like { role: "admin" }', async () => {
    // No update fields remain after stripping → falls back to findFirst,
    // db.update must NOT be called.
    mockFindFirst.mockResolvedValue(BASE_USER as never);

    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', authHeader)
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(res.body.display_name).toBe(BASE_USER.displayName); // unchanged
  });

  it('cannot set onboarding_done directly', async () => {
    mockFindFirst.mockResolvedValue(BASE_USER as never);

    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', authHeader)
      .send({ onboarding_done: true });

    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(res.body.onboarding_done).toBe(false); // unchanged
  });

  it('returns 200 with current state for an empty body', async () => {
    mockFindFirst.mockResolvedValue(BASE_USER as never);

    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', authHeader)
      .send({});

    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('updates multiple fields at once', async () => {
    setupUpdateMock({ ...BASE_USER, displayName: 'New', timezone: 'Asia/Tokyo', commStyle: 'direct' });

    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', authHeader)
      .send({ display_name: 'New', timezone: 'Asia/Tokyo', comm_style: 'direct' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      display_name: 'New',
      timezone:      'Asia/Tokyo',
      comm_style:    'direct',
    });
  });

  it('rejects empty display_name (400 VALIDATION_ERROR)', async () => {
    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', authHeader)
      .send({ display_name: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T-008 — GET /v1/users/me/streak
// ─────────────────────────────────────────────────────────────────────────────

const mockSelect = db.select as jest.MockedFunction<typeof db.select>;

function setupStreakSelect(row: object | null) {
  const limit = jest.fn().mockResolvedValue(row ? [row] : []);
  const where  = jest.fn().mockReturnValue({ limit });
  const from   = jest.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from } as never);
}

describe('GET /v1/users/me/streak', () => {
  it('returns current_streak, longest_streak, last_active_date when a row exists', async () => {
    setupStreakSelect({
      currentStreak:  5,
      longestStreak:  12,
      lastActiveDate: '2026-01-14',
    });

    const res = await request(app)
      .get('/v1/users/me/streak')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      current_streak:   5,
      longest_streak:   12,
      last_active_date: '2026-01-14',
    });
  });

  it('returns zeros and null when no streak row exists yet', async () => {
    setupStreakSelect(null);

    const res = await request(app)
      .get('/v1/users/me/streak')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      current_streak:   0,
      longest_streak:   0,
      last_active_date: null,
    });
  });

  it('returns 401 without an auth token', async () => {
    const res = await request(app).get('/v1/users/me/streak');
    expect(res.status).toBe(401);
  });
});
