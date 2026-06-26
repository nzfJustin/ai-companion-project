/**
 * src/routes/v1/auth.router.ts
 *
 * Auth routes:
 *   POST /v1/auth/register          (P1-04 / TDD P1-002) ✓
 *   POST /v1/auth/login              (P1-05 / TDD P1-002) ✓
 *   POST /v1/auth/refresh            (P1-06 / TDD P1-003) ✓
 *   POST /v1/auth/logout              (P1-07 / TDD P1-003) ✓
 *   POST /v1/auth/memory-pin/set     (P1-09 / TDD P1-004) ✓
 *   POST /v1/auth/memory-pin/verify  (P1-09 / TDD P1-004) ✓
 */

import { Router }  from 'express';
import { z }       from 'zod';
import bcrypt      from 'bcryptjs';
import { eq, and, isNull } from 'drizzle-orm';
import { db }      from '../../db';
import { users, authSessions, userContext, userMemoryPins } from '../../db/schema';
import { validate, displayNameSchema } from '../../middleware/validate';
import { authenticate } from '../../middleware/authenticate';
import { AppError }     from '../../lib/errors';
import { redis }        from '../../lib/redis';
import {
  signAccessToken,
  generateRefreshToken,
  generateRawToken,
  hashRefreshToken,
  refreshCookieOptions,
  signElevatedToken,
  ACCESS_TOKEN_TTL_SEC,
  REFRESH_TOKEN_TTL_MS,
  REFRESH_COOKIE_NAME,
  ELEVATED_TOKEN_TTL_SEC,
  ELEVATED_TOKEN_SCOPE,
} from '../../lib/jwt';

export const authRouter = Router();

const BCRYPT_ROUNDS = 12;

/**
 * Precomputed dummy hash, used to keep login's response time constant
 * whether or not the user exists (TDD P1-002: "identical response time
 * ... within 50ms variance via constant-time comparison").
 *
 * Computed once at module load — bcrypt.hash is ~80-100ms, so doing this
 * lazily on every "user not found" request would itself be a timing tell
 * if it ever needed to be computed fresh.
 */
const DUMMY_HASH_PROMISE = bcrypt.hash('dummy-password-for-timing-safety', BCRYPT_ROUNDS);

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/auth/register
// ─────────────────────────────────────────────────────────────────────────────

const RegisterSchema = z.object({
  email: z
    .string({ required_error: 'email is required' })
    .email({ message: 'Must be a valid email address' })
    .toLowerCase(),
  password: z
    .string({ required_error: 'password is required' })
    .min(8, { message: 'Password must be at least 8 characters' }),
  display_name: displayNameSchema,
});

type RegisterBody = z.infer<typeof RegisterSchema>;

authRouter.post(
  '/register',
  validate(RegisterSchema),
  async (req, res, next) => {
    const { email, password, display_name } = req.body as RegisterBody;

    try {
      const existing = await db.query.users.findFirst({
        where:   eq(users.email, email),
        columns: { id: true },
      });

      if (existing) {
        return next(new AppError(409, 'EMAIL_ALREADY_EXISTS'));
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      // Insert the user AND seed an empty user_context row atomically, so
      // downstream queries (P1-13+) never need to handle a missing
      // user_context row (TDD P1-005: context_summary: null,
      // stated_goals: [], session_count: 0 — all schema defaults).
      const user = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(users)
          .values({ email, passwordHash, displayName: display_name })
          .returning({ id: users.id, displayName: users.displayName });

        await tx.insert(userContext).values({ userId: inserted.id });

        return inserted;
      });

      return res.status(201).json({
        id:           user.id,
        display_name: user.displayName,
      });
    } catch (err) {
      return next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/auth/login
// ─────────────────────────────────────────────────────────────────────────────

const LoginSchema = z.object({
  email: z
    .string({ required_error: 'email is required' })
    .email({ message: 'Must be a valid email address' })
    .toLowerCase(),
  password: z
    .string({ required_error: 'password is required' })
    .min(1, { message: 'password is required' }),
});

type LoginBody = z.infer<typeof LoginSchema>;

authRouter.post(
  '/login',
  validate(LoginSchema),
  async (req, res, next) => {
    const { email, password } = req.body as LoginBody;

    try {
      // ── 1. Look up user ──────────────────────────────────────────────────
      const user = await db.query.users.findFirst({
        where:   eq(users.email, email),
        columns: {
          id:           true,
          passwordHash: true,
          deletedAt:    true,
        },
      });

      // ── 2. Verify password — ALWAYS call bcrypt.compare ────────────────────
      // Whether or not the user exists, we compare against *some* hash so
      // the response time is the same in both cases. This is the fix for
      // TDD P1-002's "identical response time ... for both 'user not
      // found' and 'wrong password'" requirement — early-returning on a
      // missing user would skip the ~80-100ms bcrypt cost and leak which
      // case occurred via timing.
      const hashToCompare = user?.passwordHash ?? (await DUMMY_HASH_PROMISE);
      const passwordMatch = await bcrypt.compare(password, hashToCompare);

      if (!user || user.deletedAt || !passwordMatch) {
        return next(new AppError(401, 'INVALID_CREDENTIALS'));
      }

      // ── 3. Issue tokens ──────────────────────────────────────────────────
      const accessToken = signAccessToken(user.id);
      const { token: refreshToken, family: tokenFamily } = generateRefreshToken();

      // ── 4. Persist session — store HASH only, never the raw token ────────
      await db.insert(authSessions).values({
        userId:       user.id,
        refreshToken: hashRefreshToken(refreshToken),
        tokenFamily,
        expiresAt:    new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      });

      // ── 5. Set HttpOnly cookie (raw token) + respond ──────────────────────
      res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions(REFRESH_TOKEN_TTL_MS));

      return res.status(200).json({
        access_token: accessToken,
        token_type:   'Bearer',
        expires_in:   ACCESS_TOKEN_TTL_SEC,
      });
    } catch (err) {
      return next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/auth/refresh
// ─────────────────────────────────────────────────────────────────────────────
//
// Rotation scheme (TDD P1-003):
//   1. Read raw refresh_token from cookie, hash it, look up auth_sessions.
//   2. If no row matches → 401 TOKEN_EXPIRED (unknown/garbage token).
//   3. If the matched row is already revoked → this token has been used
//      before (reuse). Revoke the ENTIRE token_family and return
//      401 TOKEN_REUSE_DETECTED.
//   4. If the row is expired → 401 TOKEN_EXPIRED.
//   5. Otherwise: in one atomic transaction, revoke the current row and
//      insert a new row (same family, new hash, new expiry). Issue a new
//      access token and set the new raw token as the cookie.

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const rawToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;

    if (!rawToken) {
      return next(new AppError(401, 'TOKEN_EXPIRED'));
    }

    const tokenHash = hashRefreshToken(rawToken);

    const session = await db.query.authSessions.findFirst({
      where: eq(authSessions.refreshToken, tokenHash),
    });

    // Unknown token — never issued, or already pruned
    if (!session) {
      res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions(0));
      return next(new AppError(401, 'TOKEN_EXPIRED'));
    }

    // ── Reuse detection ────────────────────────────────────────────────────
    // This exact token hash has already been consumed by a previous
    // refresh (or logout). Someone is replaying an old token — revoke the
    // whole family so every descendant token is invalidated too.
    if (session.revokedAt) {
      await db
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(authSessions.tokenFamily, session.tokenFamily),
            isNull(authSessions.revokedAt),
          ),
        );

      res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions(0));
      return next(new AppError(401, 'TOKEN_REUSE_DETECTED'));
    }

    // ── Expiry check ───────────────────────────────────────────────────────
    if (session.expiresAt.getTime() < Date.now()) {
      res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions(0));
      return next(new AppError(401, 'TOKEN_EXPIRED'));
    }

    // ── Rotate: revoke old + insert new, atomically ───────────────────────
    const newRawToken = generateRawToken();
    const newTokenHash = hashRefreshToken(newRawToken);

    await db.transaction(async (tx) => {
      await tx
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(eq(authSessions.id, session.id));

      await tx.insert(authSessions).values({
        userId:       session.userId,
        refreshToken: newTokenHash,
        tokenFamily:  session.tokenFamily,   // same family — rotation, not a new chain
        expiresAt:    new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      });
    });

    const accessToken = signAccessToken(session.userId);

    res.cookie(REFRESH_COOKIE_NAME, newRawToken, refreshCookieOptions(REFRESH_TOKEN_TTL_MS));

    return res.status(200).json({
      access_token: accessToken,
      token_type:   'Bearer',
      expires_in:   ACCESS_TOKEN_TTL_SEC,
    });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/auth/logout
// ─────────────────────────────────────────────────────────────────────────────
//
// Revokes the session tied to the current refresh token and clears the
// cookie (Set-Cookie with max-age=0, per TDD P1-003).

authRouter.post('/logout', async (req, res, next) => {
  try {
    const rawToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;

    if (!rawToken) {
      return next(new AppError(401, 'TOKEN_EXPIRED'));
    }

    const tokenHash = hashRefreshToken(rawToken);

    const session = await db.query.authSessions.findFirst({
      where: eq(authSessions.refreshToken, tokenHash),
    });

    if (!session || session.expiresAt.getTime() < Date.now()) {
      res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions(0));
      return next(new AppError(401, 'TOKEN_EXPIRED'));
    }

    if (!session.revokedAt) {
      await db
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(eq(authSessions.id, session.id));
    }

    // Explicit max-age=0 — clears the cookie immediately
    res.cookie(REFRESH_COOKIE_NAME, '', refreshCookieOptions(0));

    return res.status(200).json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory Step-Up PIN  (P1-09 / TDD P1-004)
// ─────────────────────────────────────────────────────────────────────────────
//
// Memories at level 4-5 require a second factor (a 4-6 digit PIN, separate
// from the account password). Verifying it issues a short-lived elevated
// JWT (see lib/jwt.ts signElevatedToken). Both endpoints require a normal
// authenticated session.

const MAX_PIN_ATTEMPTS    = 3;
const PIN_FAIL_WINDOW_SEC = 10 * 60; // 10 minutes
const PIN_LOCK_TTL_SEC    = 15 * 60; // 15 minutes

const pinLockKey = (userId: string) => `pin_lock:${userId}`;
const pinFailKey = (userId: string) => `pin_fail:${userId}`;

const MemoryPinSchema = z.object({
  pin: z
    .string({ required_error: 'pin is required' })
    .regex(/^\d{4,6}$/, { message: 'pin must be 4-6 digits' }),
});

type MemoryPinBody = z.infer<typeof MemoryPinSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/auth/memory-pin/set
// ─────────────────────────────────────────────────────────────────────────────
//
// Upserts the user's memory PIN. Setting a new PIN also clears any
// existing lockout state — a fresh PIN deserves a fresh attempt counter.

authRouter.post(
  '/memory-pin/set',
  authenticate,
  validate(MemoryPinSchema),
  async (req, res, next) => {
    const { pin } = req.body as MemoryPinBody;
    const userId = req.userId!;

    try {
      const pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);

      await db
        .insert(userMemoryPins)
        .values({ userId, pinHash })
        .onConflictDoUpdate({
          target: userMemoryPins.userId,
          set:    { pinHash, updatedAt: new Date() },
        });

      // Clear any prior lockout/attempt state for this user.
      await redis.del(pinLockKey(userId), pinFailKey(userId));

      return res.status(200).json({ success: true });
    } catch (err) {
      return next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/auth/memory-pin/verify
// ─────────────────────────────────────────────────────────────────────────────
//
// Flow (TDD P1-004):
//   1. If pin_lock:{user_id} exists in Redis → 429 PIN_LOCKED.
//   2. If the user has never set a PIN → 404 PIN_NOT_SET.
//   3. bcrypt.compare against the stored hash.
//      - Match: reset the failure counter, issue an elevated JWT.
//      - No match: increment pin_fail:{user_id} (10-min window). On the
//        3rd consecutive failure, set pin_lock:{user_id} (15-min TTL) and
//        return 429 PIN_LOCKED; otherwise 401 INVALID_PIN.

authRouter.post(
  '/memory-pin/verify',
  authenticate,
  validate(MemoryPinSchema),
  async (req, res, next) => {
    const { pin } = req.body as MemoryPinBody;
    const userId = req.userId!;

    try {
      // ── 1. Lockout check ───────────────────────────────────────────────────
      const locked = await redis.exists(pinLockKey(userId));
      if (locked) {
        return next(new AppError(429, 'PIN_LOCKED'));
      }

      // ── 2. PIN must have been set ────────────────────────────────────────────
      const record = await db.query.userMemoryPins.findFirst({
        where: eq(userMemoryPins.userId, userId),
      });

      if (!record) {
        return next(new AppError(404, 'PIN_NOT_SET'));
      }

      // ── 3. Verify ─────────────────────────────────────────────────────────
      const match = await bcrypt.compare(pin, record.pinHash);

      if (!match) {
        const fails = await redis.incr(pinFailKey(userId));
        if (fails === 1) {
          await redis.expire(pinFailKey(userId), PIN_FAIL_WINDOW_SEC);
        }

        if (fails >= MAX_PIN_ATTEMPTS) {
          await redis.set(pinLockKey(userId), '1', 'EX', PIN_LOCK_TTL_SEC);
          await redis.del(pinFailKey(userId));
          return next(new AppError(429, 'PIN_LOCKED'));
        }

        return next(new AppError(401, 'INVALID_PIN'));
      }

      // ── 4. Success — reset attempts, issue elevated token ────────────────────
      await redis.del(pinFailKey(userId));

      const elevatedToken = signElevatedToken(userId);

      return res.status(200).json({
        elevated_token: elevatedToken,
        token_type:     'Bearer',
        expires_in:     ELEVATED_TOKEN_TTL_SEC,
        scope:          ELEVATED_TOKEN_SCOPE,
      });
    } catch (err) {
      return next(err);
    }
  },
);
