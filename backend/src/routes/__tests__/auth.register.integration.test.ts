/**
 * src/routes/__tests__/auth.register.integration.test.ts
 *
 * Integration tests for POST /v1/auth/register.
 * Requires a running test database:
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/companion_test \
 *     npm run db:migrate
 *
 * In CI this runs automatically after the migration step.
 */

import request   from 'supertest';
import bcrypt    from 'bcryptjs';
import { eq }    from 'drizzle-orm';
import { app }       from '../../app';
import { db, closeDb } from '../../db';
import { users }    from '../../db/schema';
import { closeRedis } from '../../lib/redis';

// ─────────────────────────────────────────────────────────────────────────────

const TEST_EMAIL = 'integration-register@example.com';

// Clean the test user before each test so cases are independent
beforeEach(async () => {
  await db.delete(users).where(eq(users.email, TEST_EMAIL));
});

afterAll(async () => {
  // Final cleanup
  await db.delete(users).where(eq(users.email, TEST_EMAIL));
  await closeDb();
  await closeRedis();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/auth/register (integration)', () => {
  const VALID_BODY = {
    email:        TEST_EMAIL,
    password:     'securepass123',
    display_name: 'Integration Tester',
  };

  it('creates a user and returns 201 with id and display_name', async () => {
    const res = await request(app).post('/v1/auth/register').send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id:           expect.stringMatching(/^[0-9a-f-]{36}$/),
      display_name: VALID_BODY.display_name,
    });
    expect(res.body).not.toHaveProperty('password_hash');
  });

  it('persists the user to the database', async () => {
    await request(app).post('/v1/auth/register').send(VALID_BODY);

    const saved = await db.query.users.findFirst({
      where: eq(users.email, TEST_EMAIL),
    });

    expect(saved).not.toBeUndefined();
    expect(saved!.displayName).toBe(VALID_BODY.display_name);
  });

  it('stores a bcrypt hash — never the plaintext password', async () => {
    await request(app).post('/v1/auth/register').send(VALID_BODY);

    const saved = await db.query.users.findFirst({
      where:   eq(users.email, TEST_EMAIL),
      columns: { passwordHash: true },
    });

    expect(saved!.passwordHash).not.toBe(VALID_BODY.password);
    const valid = await bcrypt.compare(VALID_BODY.password, saved!.passwordHash);
    expect(valid).toBe(true);
  });

  it('stores the email in lowercase', async () => {
    await request(app)
      .post('/v1/auth/register')
      .send({ ...VALID_BODY, email: TEST_EMAIL.toUpperCase() });

    const saved = await db.query.users.findFirst({
      where:   eq(users.email, TEST_EMAIL),
      columns: { email: true },
    });

    expect(saved!.email).toBe(TEST_EMAIL.toLowerCase());
  });

  it('returns 409 EMAIL_ALREADY_EXISTS on duplicate registration', async () => {
    // First registration — should succeed
    await request(app).post('/v1/auth/register').send(VALID_BODY);

    // Second registration — same email
    const res = await request(app).post('/v1/auth/register').send(VALID_BODY);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'EMAIL_ALREADY_EXISTS' });
  });

  it('is case-insensitive for duplicate detection', async () => {
    await request(app).post('/v1/auth/register').send(VALID_BODY);

    const res = await request(app)
      .post('/v1/auth/register')
      .send({ ...VALID_BODY, email: TEST_EMAIL.toUpperCase() });

    expect(res.status).toBe(409);
  });

  it('sets onboarding_done to false by default', async () => {
    await request(app).post('/v1/auth/register').send(VALID_BODY);

    const saved = await db.query.users.findFirst({
      where:   eq(users.email, TEST_EMAIL),
      columns: { onboardingDone: true },
    });

    expect(saved!.onboardingDone).toBe(false);
  });
});
