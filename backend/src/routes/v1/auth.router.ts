/**
 * src/routes/v1/auth.router.ts
 *
 * Auth routes.  Currently implements:
 *   POST /v1/auth/register  (P1-04)
 *
 * Upcoming (added as each P1 task lands):
 *   POST /v1/auth/login           (P1-05)
 *   POST /v1/auth/refresh         (P1-06)
 *   POST /v1/auth/logout          (P1-07)
 *   POST /v1/auth/memory-pin/set  (P1-09)
 *   POST /v1/auth/memory-pin/verify (P1-09)
 */

import { Router }  from 'express';
import { z }       from 'zod';
import bcrypt      from 'bcryptjs';
import { eq }      from 'drizzle-orm';
import { db }      from '../../db';
import { users }   from '../../db/schema';
import { validate }   from '../../middleware/validate';
import { AppError }   from '../../lib/errors';

export const authRouter = Router();

const BCRYPT_ROUNDS = 12;

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/auth/register
// ─────────────────────────────────────────────────────────────────────────────

const RegisterSchema = z.object({
  email: z
    .string({ required_error: 'email is required' })
    .email({ message: 'Must be a valid email address' })
    .toLowerCase(),            // normalise before hitting the DB
  password: z
    .string({ required_error: 'password is required' })
    .min(8, { message: 'Password must be at least 8 characters' }),
  display_name: z
    .string({ required_error: 'display_name is required' })
    .min(1,  { message: 'display_name cannot be empty' })
    .max(100, { message: 'display_name cannot exceed 100 characters' })
    .trim(),
});

type RegisterBody = z.infer<typeof RegisterSchema>;

authRouter.post(
  '/register',
  validate(RegisterSchema),
  async (req, res, next) => {
    const { email, password, display_name } = req.body as RegisterBody;

    try {
      // ── 1. Reject duplicate emails ───────────────────────────────────────
      const existing = await db.query.users.findFirst({
        where:   eq(users.email, email),
        columns: { id: true },          // only fetch what we need
      });

      if (existing) {
        return next(new AppError(409, 'EMAIL_ALREADY_EXISTS'));
      }

      // ── 2. Hash password ─────────────────────────────────────────────────
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      // ── 3. Insert user ───────────────────────────────────────────────────
      const [user] = await db
        .insert(users)
        .values({
          email,
          passwordHash,
          displayName: display_name,
        })
        .returning({
          id:          users.id,
          displayName: users.displayName,
        });

      // ── 4. Respond ───────────────────────────────────────────────────────
      return res.status(201).json({
        id:           user.id,
        display_name: user.displayName,
      });

    } catch (err) {
      return next(err);
    }
  },
);
