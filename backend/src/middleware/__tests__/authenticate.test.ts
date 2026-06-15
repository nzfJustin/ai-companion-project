/**
 * src/middleware/__tests__/authenticate.test.ts
 *
 * Unit tests for the `authenticate` middleware.
 * Uses a real RS256 key pair (generated fresh per run) and real
 * sign/verify from src/lib/jwt — nothing mocked except the route handler.
 */

import { generateKeyPairSync } from 'node:crypto';
import express  from 'express';
import request  from 'supertest';
import jwt      from 'jsonwebtoken';
import { authenticate } from '../authenticate';
import { signAccessToken } from '../../lib/jwt';
import { errorHandler } from '../errorHandler';

// ─── Key pair + test app ──────────────────────────────────────────────────────

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.JWT_PRIVATE_KEY = privateKey;
  process.env.JWT_PUBLIC_KEY  = publicKey;
});

afterAll(() => {
  delete process.env.JWT_PRIVATE_KEY;
  delete process.env.JWT_PUBLIC_KEY;
});

const USER_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';

function buildApp() {
  const app = express();
  app.get('/protected', authenticate, (req, res) => {
    res.status(200).json({ userId: req.userId });
  });
  app.use(errorHandler);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('authenticate middleware', () => {
  it('returns 401 UNAUTHORIZED when Authorization header is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('returns 401 UNAUTHORIZED when header does not start with "Bearer "', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Basic sometoken');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('returns 401 UNAUTHORIZED when "Bearer " has no token', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer ');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('returns 401 UNAUTHORIZED for a malformed token', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('returns 401 UNAUTHORIZED for a token signed with a different key', async () => {
    const app = buildApp();
    const { privateKey: otherKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    });
    const forged = jwt.sign({ sub: USER_ID }, otherKey, { algorithm: 'RS256' });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('returns 401 TOKEN_EXPIRED for an expired token', async () => {
    const app = buildApp();
    const expired = jwt.sign(
      { sub: USER_ID },
      process.env.JWT_PRIVATE_KEY!,
      { algorithm: 'RS256', expiresIn: -1 },
    );

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'TOKEN_EXPIRED' });
  });

  it('calls next() and sets req.userId for a valid token', async () => {
    const app = buildApp();
    const token = signAccessToken(USER_ID);

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: USER_ID });
  });

  it('is case-sensitive about the "Bearer" prefix', async () => {
    const app = buildApp();
    const token = signAccessToken(USER_ID);

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `bearer ${token}`); // lowercase

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
  });
});
