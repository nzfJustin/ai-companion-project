/**
 * src/routes/v1/auth.router.ts
 *
 * Auth routes:
 *   POST /v1/auth/register          (P1-04) ✓
 *   POST /v1/auth/login             (P1-05) ✓
 *   POST /v1/auth/refresh           (P1-06)
 *   POST /v1/auth/logout            (P1-07)
 *   POST /v1/auth/memory-pin/set    (P1-09)
 *   POST /v1/auth/memory-pin/verify (P1-09)
 */

import { Router }  from 'express';
import { z }       from 'zod';
import bcrypt      from 'bcryptjs';
import { eq }      from 'drizzle-orm';
import { db }      from '../../db';
import { users, authSessions } from '../../db/schema';
import { validate }  from '../../middleware/validate';
import { AppError }  from '../../lib/errors';
import {
  signAccessToken,
  generateRefreshToken,
  ACCESS_TOKEN_TTL_SEC,
  REFRESH_TOKEN_TTL_MS,
  REFRESH_COOKIE_NAME,
} from '../../lib/jwt';

export const authRouter = Router();

const BCRYPT_ROUNDS = 12;

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
  display_name: z
    .string({ required_error: 'display_name is required' })
    .trim()
    .min(1,   { message: 'display_name cannot be empty' })
    .max(100, { message: 'display_name cannot exceed 100 characters' }),
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

      const [user] = await db
        .insert(users)
        .values({ email, passwordHash, displayName: display_name })
        .returning({ id: users.id, displayName: users.displayName });

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

      // Return the same error for "not found" and "wrong password" to
      // prevent email-enumeration attacks.
      if (!user || user.deletedAt) {
        return next(new AppError(401, 'INVALID_CREDENTIALS'));
      }

      // ── 2. Verify password ───────────────────────────────────────────────
      const passwordMatch = await bcrypt.compare(password, user.passwordHash);
      if (!passwordMatch) {
        return next(new AppError(401, 'INVALID_CREDENTIALS'));
      }

      // ── 3. Issue tokens ──────────────────────────────────────────────────
      const accessToken               = signAccessToken(user.id);
      const { token: refreshToken, family: tokenFamily } = generateRefreshToken();

      // ── 4. Persist session ───────────────────────────────────────────────
      await db.insert(authSessions).values({
        userId:       user.id,
        refreshToken,
        tokenFamily,
        expiresAt:    new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      });

      // ── 5. Set HttpOnly cookie + respond ─────────────────────────────────
      res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge:   REFRESH_TOKEN_TTL_MS,
        path:     '/v1/auth',         // only sent to auth endpoints
      });

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
