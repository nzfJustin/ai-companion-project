/**
 * src/routes/v1/users.router.ts
 *
 * User profile routes:
 *   GET   /v1/users/me          (P1-08 / TDD P1-005) ✓
 *   PATCH /v1/users/me          (P1-08 / TDD P1-005) ✓
 *   GET   /v1/users/me/streak   (T-008) ✓
 *
 * All routes require authentication (Bearer access token).
 */

import { Router } from 'express';
import { z }      from 'zod';
import { eq }     from 'drizzle-orm';
import { db }     from '../../db';
import { users, userStreaks, commStyleEnum } from '../../db/schema';
import { authenticate }  from '../../middleware/authenticate';
import { globalRateLimit } from '../../middleware/rateLimit';
import { validate, displayNameSchema } from '../../middleware/validate';
import { AppError }      from '../../lib/errors';

export const usersRouter = Router();

// All /v1/users routes require authentication and are globally rate-limited.
usersRouter.use(authenticate);
usersRouter.use(globalRateLimit);

// ─── Shared column selections ─────────────────────────────────────────────────

/** Columns returned by GET — also used as the base for PATCH responses. */
const ME_COLUMNS = {
  id:             true,
  email:          true,
  displayName:    true,
  timezone:       true,
  commStyle:      true,
  onboardingDone: true,
  createdAt:      true,
  deletedAt:      true,   // fetched only to check soft-delete, stripped before response
} as const;

/** Same shape, as column references — for `.returning()` after UPDATE. */
const ME_RETURNING = {
  id:             users.id,
  email:          users.email,
  displayName:    users.displayName,
  timezone:       users.timezone,
  commStyle:      users.commStyle,
  onboardingDone: users.onboardingDone,
  createdAt:      users.createdAt,
  deletedAt:      users.deletedAt,
};

type MeRow = {
  id: string;
  email: string;
  displayName: string;
  timezone: string;
  commStyle: string;
  onboardingDone: boolean;
  createdAt: Date;
  deletedAt: Date | null;
};

/**
 * Shapes a DB row into the wire format.
 *
 * NOTE: `email` is included here per TDD P1-005, but must never be written
 * to application logs (see P1-17 PII redaction list).
 */
function toMeResponse(user: MeRow) {
  return {
    id:              user.id,
    email:           user.email,
    display_name:    user.displayName,
    timezone:        user.timezone,
    comm_style:      user.commStyle,
    onboarding_done: user.onboardingDone,
    created_at:      user.createdAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/users/me
// ─────────────────────────────────────────────────────────────────────────────

usersRouter.get('/me', async (req, res, next) => {
  try {
    const user = await db.query.users.findFirst({
      where:   eq(users.id, req.userId!),
      columns: ME_COLUMNS,
    });

    if (!user || user.deletedAt) {
      return next(new AppError(404, 'USER_NOT_FOUND'));
    }

    return res.status(200).json(toMeResponse(user));
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /v1/users/me
// ─────────────────────────────────────────────────────────────────────────────

const PatchMeSchema = z.object({
  display_name: displayNameSchema.optional(),
  timezone: z
    .string()
    .min(1,   { message: 'timezone cannot be empty' })
    .max(100, { message: 'timezone cannot exceed 100 characters' })
    .optional(),
  // Validated as a generic string here. The TDD-mandated INVALID_COMM_STYLE
  // error code (rather than a generic VALIDATION_ERROR) is produced by an
  // explicit check below, against commStyleEnum.enumValues.
  comm_style: z.string().optional(),
  // Unknown keys — e.g. { role: "admin" } or { onboarding_done: true } —
  // are stripped silently. This is zod's default `.object()` behavior
  // (not `.passthrough()`), satisfying TDD P1-005's requirement that
  // onboarding_done cannot be set via this endpoint.
});

type PatchMeBody = z.infer<typeof PatchMeSchema>;

const VALID_COMM_STYLES = commStyleEnum.enumValues; // ['warm', 'direct', 'reflective']

usersRouter.patch(
  '/me',
  validate(PatchMeSchema),
  async (req, res, next) => {
    const body = req.body as PatchMeBody;

    try {
      // ── Validate comm_style with its own error code ───────────────────────
      if (
        body.comm_style !== undefined &&
        !VALID_COMM_STYLES.includes(body.comm_style as (typeof VALID_COMM_STYLES)[number])
      ) {
        return next(new AppError(400, 'INVALID_COMM_STYLE'));
      }

      // ── Build the update set from only the provided fields ────────────────
      const updates: Partial<{
        displayName: string;
        timezone:    string;
        commStyle:   (typeof VALID_COMM_STYLES)[number];
      }> = {};

      if (body.display_name !== undefined) updates.displayName = body.display_name;
      if (body.timezone !== undefined)     updates.timezone    = body.timezone;
      if (body.comm_style !== undefined) {
        updates.commStyle = body.comm_style as (typeof VALID_COMM_STYLES)[number];
      }

      let user: MeRow | undefined;

      if (Object.keys(updates).length > 0) {
        [user] = await db
          .update(users)
          .set(updates)
          .where(eq(users.id, req.userId!))
          .returning(ME_RETURNING);
      } else {
        // Nothing to update (e.g. body was {} or only unknown fields) —
        // return current state without touching the DB.
        user = await db.query.users.findFirst({
          where:   eq(users.id, req.userId!),
          columns: ME_COLUMNS,
        });
      }

      if (!user || user.deletedAt) {
        return next(new AppError(404, 'USER_NOT_FOUND'));
      }

      return res.status(200).json(toMeResponse(user));
    } catch (err) {
      return next(err);
    }
  },
);

// ─── GET /v1/users/me/streak (T-008) ──────────────────────────────────────────

/**
 * Returns the authenticated user's current streak stats.
 * Gracefully returns zeros if no streak row exists yet (user hasn't
 * completed their first conversation extraction).
 */
usersRouter.get(
  '/me/streak',
  async (req, res, next) => {
    try {
      const [row] = await db
        .select({
          currentStreak:  userStreaks.currentStreak,
          longestStreak:  userStreaks.longestStreak,
          lastActiveDate: userStreaks.lastActiveDate,
        })
        .from(userStreaks)
        .where(eq(userStreaks.userId, req.userId!))
        .limit(1);

      return res.status(200).json({
        current_streak:   row?.currentStreak  ?? 0,
        longest_streak:   row?.longestStreak  ?? 0,
        last_active_date: row?.lastActiveDate ?? null,
      });
    } catch (err) {
      return next(err);
    }
  },
);
