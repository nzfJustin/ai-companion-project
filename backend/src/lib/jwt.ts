/**
 * src/lib/jwt.ts
 *
 * JWT utilities used by every auth route.
 *
 * Algorithm: RS256 (asymmetric — private key signs, public key verifies)
 *
 * Tokens:
 *   Access token  — short-lived JWT (15 min), returned in response body
 *   Refresh token — opaque 64-char hex, stored in DB + HttpOnly cookie
 *
 * Key setup (run once):
 *   openssl genrsa -out private.pem 2048
 *   openssl rsa    -in private.pem -pubout -out public.pem
 *   # In .env, collapse newlines to \n literals:
 *   JWT_PRIVATE_KEY="$(awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' private.pem)"
 *   JWT_PUBLIC_KEY="$(awk  'NF {sub(/\r/, ""); printf "%s\\n",$0;}' public.pem)"
 */

import jwt                     from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Access token lifetime in seconds (used in JWT exp + response body). */
export const ACCESS_TOKEN_TTL_SEC  = 15 * 60;                    // 15 minutes

/** Refresh token lifetime in milliseconds (cookie maxAge + DB expiresAt). */
export const REFRESH_TOKEN_TTL_MS  = 30 * 24 * 60 * 60 * 1000;  // 30 days

/** Name of the HttpOnly cookie that carries the refresh token. */
export const REFRESH_COOKIE_NAME   = 'refresh_token';

// ─── Payload type ─────────────────────────────────────────────────────────────

export interface AccessTokenPayload {
  /** Subject — the user's UUID */
  sub: string;
  iat: number;
  exp: number;
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

/**
 * PEM keys stored in env vars usually have literal `\n` instead of real
 * newlines.  This normalises both forms so either works.
 */
function normaliseKey(raw: string): string {
  return raw.replace(/\\n/g, '\n');
}

export function getJwtPrivateKey(): string {
  const key = process.env.JWT_PRIVATE_KEY;
  if (!key) throw new Error('JWT_PRIVATE_KEY is not set');
  return normaliseKey(key);
}

export function getJwtPublicKey(): string {
  const key = process.env.JWT_PUBLIC_KEY;
  if (!key) throw new Error('JWT_PUBLIC_KEY is not set');
  return normaliseKey(key);
}

// ─── Token operations ─────────────────────────────────────────────────────────

/**
 * Signs a short-lived RS256 access token for the given user.
 *
 * @param userId  User UUID — becomes the JWT `sub` claim
 */
export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, getJwtPrivateKey(), {
    algorithm: 'RS256',
    expiresIn: ACCESS_TOKEN_TTL_SEC,
  });
}

/**
 * Verifies an RS256 access token and returns the decoded payload.
 *
 * @throws {jwt.JsonWebTokenError}  Token is invalid / tampered
 * @throws {jwt.TokenExpiredError}  Token has expired
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, getJwtPublicKey(), {
    algorithms: ['RS256'],
  }) as AccessTokenPayload;
}

/**
 * Generates a cryptographically random refresh token and its family UUID.
 *
 * The token is a 64-char hex string stored in auth_sessions.
 * The family UUID ties related tokens together for rotation/reuse detection.
 */
export function generateRefreshToken(): { token: string; family: string } {
  return {
    token:  randomBytes(32).toString('hex'),
    family: randomUUID(),
  };
}
