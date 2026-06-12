/**
 * src/lib/__tests__/jwt.test.ts
 *
 * Unit tests for JWT utilities.
 * Generates a fresh RSA key pair per test run — no env var setup needed.
 */

import { generateKeyPairSync } from 'node:crypto';
import jwt                     from 'jsonwebtoken';
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  ACCESS_TOKEN_TTL_SEC,
} from '../jwt';

// ─── Setup: generate a fresh RSA-2048 key pair ────────────────────────────────

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',   format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8',  format: 'pem' },
  });
  process.env.JWT_PRIVATE_KEY = privateKey;
  process.env.JWT_PUBLIC_KEY  = publicKey;
});

afterAll(() => {
  delete process.env.JWT_PRIVATE_KEY;
  delete process.env.JWT_PUBLIC_KEY;
});

// ─────────────────────────────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';

// ── signAccessToken ───────────────────────────────────────────────────────────

describe('signAccessToken', () => {
  it('returns a non-empty string', () => {
    expect(typeof signAccessToken(USER_ID)).toBe('string');
    expect(signAccessToken(USER_ID).length).toBeGreaterThan(0);
  });

  it('produces a valid three-part JWT', () => {
    const token = signAccessToken(USER_ID);
    expect(token.split('.')).toHaveLength(3);
  });

  it('uses RS256', () => {
    const token = signAccessToken(USER_ID);
    const header = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64').toString('utf8'),
    );
    expect(header.alg).toBe('RS256');
  });

  it('sets sub to the userId', () => {
    const token = signAccessToken(USER_ID);
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.sub).toBe(USER_ID);
  });

  it(`expires in ${ACCESS_TOKEN_TTL_SEC} seconds`, () => {
    const before = Math.floor(Date.now() / 1000);
    const token  = signAccessToken(USER_ID);
    const decoded = jwt.decode(token) as Record<string, number>;
    expect(decoded.exp - decoded.iat).toBe(ACCESS_TOKEN_TTL_SEC);
    expect(decoded.iat).toBeGreaterThanOrEqual(before);
  });
});

// ── verifyAccessToken ─────────────────────────────────────────────────────────

describe('verifyAccessToken', () => {
  it('round-trips: verify(sign(userId)).sub === userId', () => {
    const token   = signAccessToken(USER_ID);
    const payload = verifyAccessToken(token);
    expect(payload.sub).toBe(USER_ID);
  });

  it('returns iat and exp', () => {
    const token   = signAccessToken(USER_ID);
    const payload = verifyAccessToken(token);
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
  });

  it('throws on a tampered token', () => {
    const token  = signAccessToken(USER_ID);
    const parts  = token.split('.');
    parts[1]     = Buffer.from('{"sub":"hacker"}').toString('base64url');
    const forged = parts.join('.');
    expect(() => verifyAccessToken(forged)).toThrow();
  });

  it('throws on a token signed with a different key', () => {
    const { privateKey: otherKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    });
    const wrongToken = jwt.sign({ sub: USER_ID }, otherKey, { algorithm: 'RS256' });
    expect(() => verifyAccessToken(wrongToken)).toThrow();
  });

  it('throws on an expired token', () => {
    const expired = jwt.sign(
      { sub: USER_ID },
      process.env.JWT_PRIVATE_KEY!,
      { algorithm: 'RS256', expiresIn: -1 },
    );
    expect(() => verifyAccessToken(expired)).toThrow(jwt.TokenExpiredError);
  });

  it('throws on a plain string (not a JWT)', () => {
    expect(() => verifyAccessToken('not.a.token')).toThrow();
  });
});

// ── generateRefreshToken ──────────────────────────────────────────────────────

describe('generateRefreshToken', () => {
  it('returns { token, family }', () => {
    const result = generateRefreshToken();
    expect(result).toHaveProperty('token');
    expect(result).toHaveProperty('family');
  });

  it('token is a 64-char hex string', () => {
    const { token } = generateRefreshToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('family is a valid UUID v4', () => {
    const { family } = generateRefreshToken();
    expect(family).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('generates unique tokens on each call', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.family).not.toBe(b.family);
  });
});
