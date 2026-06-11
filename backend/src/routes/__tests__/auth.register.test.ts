/**
 * src/routes/__tests__/auth.register.test.ts
 *
 * Unit tests for POST /v1/auth/register.
 * The database is mocked — no running Postgres required.
 */

// ── Mocks (hoisted before imports) ───────────────────────────────────────────

jest.mock('../../db', () => ({
  db: {
    query: {
      users: {
        findFirst: jest.fn(),
      },
    },
    insert: jest.fn(),
  },
}));

jest.mock('bcryptjs', () => ({
  __esModule: true,
  default: {
    hash:    jest.fn().mockResolvedValue('$2b$12$hashed'),
    compare: jest.fn(),
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import request from 'supertest';
import { app } from '../../app';
import { db }  from '../../db';

// ── Typed mock handles ────────────────────────────────────────────────────────

const mockFindFirst = db.query.users.findFirst as jest.MockedFunction<
  typeof db.query.users.findFirst
>;

const mockInsert = db.insert as jest.MockedFunction<typeof db.insert>;

// ── Fixture helpers ───────────────────────────────────────────────────────────

const VALID_BODY = {
  email:        'alice@example.com',
  password:     'password123',
  display_name: 'Alice',
};

const INSERTED_USER = {
  id:          'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
  displayName: 'Alice',
};

function setupHappyPath() {
  mockFindFirst.mockResolvedValue(undefined);        // no existing user
  mockInsert.mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([INSERTED_USER]),
    }),
  } as never);
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => jest.clearAllMocks());

// ── Happy path ────────────────────────────────────────────────────────────────

describe('POST /v1/auth/register — success', () => {
  it('returns 201 on valid input', async () => {
    setupHappyPath();
    const res = await request(app).post('/v1/auth/register').send(VALID_BODY);
    expect(res.status).toBe(201);
  });

  it('returns { id, display_name }', async () => {
    setupHappyPath();
    const res = await request(app).post('/v1/auth/register').send(VALID_BODY);
    expect(res.body).toEqual({
      id:           INSERTED_USER.id,
      display_name: INSERTED_USER.displayName,
    });
  });

  it('does NOT return password_hash', async () => {
    setupHappyPath();
    const res = await request(app).post('/v1/auth/register').send(VALID_BODY);
    expect(res.body).not.toHaveProperty('password_hash');
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  it('normalises email to lowercase before DB insert', async () => {
    setupHappyPath();
    await request(app)
      .post('/v1/auth/register')
      .send({ ...VALID_BODY, email: 'ALICE@EXAMPLE.COM' });

    // findFirst should have been called with the lowercased email
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.anything() }),
    );
    // The values() call should have received the lowercased email
    const valuesFn = (mockInsert.mock.results[0].value as { values: jest.Mock }).values;
    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'alice@example.com' }),
    );
  });
});

// ── Conflict ──────────────────────────────────────────────────────────────────

describe('POST /v1/auth/register — duplicate email', () => {
  it('returns 409 when email already exists', async () => {
    mockFindFirst.mockResolvedValue({ id: 'existing-id' } as never);
    const res = await request(app).post('/v1/auth/register').send(VALID_BODY);
    expect(res.status).toBe(409);
  });

  it('returns { error: "EMAIL_ALREADY_EXISTS" }', async () => {
    mockFindFirst.mockResolvedValue({ id: 'existing-id' } as never);
    const res = await request(app).post('/v1/auth/register').send(VALID_BODY);
    expect(res.body).toEqual({ error: 'EMAIL_ALREADY_EXISTS' });
  });

  it('does not call db.insert on duplicate', async () => {
    mockFindFirst.mockResolvedValue({ id: 'existing-id' } as never);
    await request(app).post('/v1/auth/register').send(VALID_BODY);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

// ── Input validation (400) ────────────────────────────────────────────────────

describe('POST /v1/auth/register — validation errors', () => {
  const cases: Array<[string, object, string]> = [
    ['missing email',        { password: 'pass1234', display_name: 'X' }, 'email'],
    ['invalid email format', { email: 'not-an-email', password: 'pass1234', display_name: 'X' }, 'email'],
    ['missing password',     { email: 'a@b.com', display_name: 'X' }, 'password'],
    ['password too short',   { email: 'a@b.com', password: 'short', display_name: 'X' }, 'password'],
    ['missing display_name', { email: 'a@b.com', password: 'pass1234' }, 'display_name'],
    ['empty display_name',   { email: 'a@b.com', password: 'pass1234', display_name: '  ' }, 'display_name'],
    ['empty body',           {}, 'email'],
  ];

  test.each(cases)('%s → 400', async (_label, body, expectedField) => {
    const res = await request(app).post('/v1/auth/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.errors.some((e: { field: string }) => e.field === expectedField)).toBe(true);
  });

  it('does not call the DB on validation failure', async () => {
    await request(app).post('/v1/auth/register').send({});
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

// ── Password hashing ──────────────────────────────────────────────────────────

describe('POST /v1/auth/register — password hashing', () => {
  it('calls bcrypt.hash with the plaintext password', async () => {
    setupHappyPath();
    const bcrypt = jest.requireMock('bcryptjs').default;
    await request(app).post('/v1/auth/register').send(VALID_BODY);
    expect(bcrypt.hash).toHaveBeenCalledWith(VALID_BODY.password, 12);
  });

  it('stores the hashed password, not the plaintext', async () => {
    setupHappyPath();
    await request(app).post('/v1/auth/register').send(VALID_BODY);
    const valuesFn = (mockInsert.mock.results[0].value as { values: jest.Mock }).values;
    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({ passwordHash: '$2b$12$hashed' }),
    );
    expect(valuesFn).not.toHaveBeenCalledWith(
      expect.objectContaining({ password: VALID_BODY.password }),
    );
  });
});
