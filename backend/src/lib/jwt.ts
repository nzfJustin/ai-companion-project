/**
 * src/lib/jwt.ts
 *
 * JWT and refresh-token utilities used by every auth route.
 *
 * Algorithm: RS256 (asymmetric — private key signs, public key verifies)
 *
 * Tokens:
 *   Access token  — short-lived JWT (15 min), returned in response body
 *   Refresh token — opaque 64-char hex, sent to the client via HttpOnly
 *                   cookie. The server stores ONLY sha256(token) in
 *                   auth_sessions.refresh_token — never the raw value.
 *                   This means a DB read alone can't be replayed as a
 *                   valid session (TDD P1-003).
 *
 * Key setup (run once):
 *   openssl genrsa -out private.pem 2048
 *   openssl rsa    -in private.pem -pubout -out public.pem
 *   # In .env, collapse newlines to \n literals:
 *   JWT_PRIVATE_KEY="$(awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' private.pem)"
 *   JWT_PUBLIC_KEY="$(awk  'NF {sub(/\r/, ""); printf "%s\\n",$0;}' public.pem)"
 */

import jwt from 'jsonwebtoken';
import {
  randomBytes,
  randomUUID,
  createHash,
} from 'node:crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Access token lifetime in seconds (used in JWT exp + response body). */
export const ACCESS_TOKEN_TTL_SEC  = 15 * 60;                    // 15 minutes

/** Refresh token lifetime in milliseconds (cookie maxAge + DB expiresAt). */
export const REFRESH_TOKEN_TTL_MS  = 30 * 24 * 60 * 60 * 1000;  // 30 days

/** Name of the HttpOnly cookie that carries the raw refresh token. */
export const REFRESH_COOKIE_NAME   = 'refresh_token';

/** Path the refresh cookie is scoped to — only auth endpoints see it. */
export const REFRESH_COOKIE_PATH   = '/v1/auth';

/**
 * Shared cookie options for setting the refresh token.
 * Pass `{ maxAge }` separately since it differs between "set" and "clear".
 */
export function refreshCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path:     REFRESH_COOKIE_PATH,
    maxAge,
  };
}

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

// ─── Access token operations ─────────────────────────────────────────────────

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

// ─── Refresh token operations ────────────────────────────────────────────────

/**
 * Generates a cryptographically random 64-char hex refresh token.
 * This is the value sent to the client — never stored directly.
 */
export function generateRawToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Generates a brand-new refresh token AND a new token family.
 * Used at login — every login starts a fresh rotation chain.
 */
export function generateRefreshToken(): { token: string; family: string } {
  return {
    token:  generateRawToken(),
    family: randomUUID(),
  };
}

/**
 * Deterministically hashes a raw refresh token for DB storage/lookup.
 *
 * SHA-256 (not bcrypt) is used deliberately: refresh tokens are already
 * 256 bits of CSPRNG entropy, so a slow KDF adds no security — only
 * lookup latency. A deterministic hash lets us query by equality.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
