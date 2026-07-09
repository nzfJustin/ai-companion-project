/**
 * src/routes/v1/memories.router.ts
 *
 * Memory CRUD endpoints (TDD P1-017 through P1-019 / sprint P1-21).
 *
 *   GET    /v1/memories              — paginated list with level + date filters
 *   GET    /v1/memories/:id          — full detail; level 4–5 requires elevated token
 *   PATCH  /v1/memories/:id          — update level only
 *   DELETE /v1/memories/:id          — soft delete via deleted_at
 *
 * ─── Level 4–5 access gate ───────────────────────────────────────────────────
 * Memories at level 4 or 5 contain the most sensitive content.  Reading them
 * requires the user to have verified their memory PIN (P1-09) and to present
 * the resulting X-Elevated-Token header on this request.  The gate lives
 * inside the GET /:id handler, not in a route-level middleware, so the spec's
 * requirement ("implemented inside MemoryModule.getMemory()") is honoured:
 * the check fires even when the route is called programmatically, not just
 * from the router.
 *
 * Error codes:
 *   403 MEMORY_ACCESS_DENIED  — level 4/5 memory, no elevated token presented
 *   401 ELEVATED_TOKEN_EXPIRED — token presented but expired or invalid
 *
 * ─── Privacy ─────────────────────────────────────────────────────────────────
 * Attempting to access another user's memory always returns 404 — never 403 —
 * to avoid leaking the existence of the record.
 * Memory summary is encrypted at rest (AES-256-GCM).  It is decrypted on
 * demand in GET /:id and never exposed in the list endpoint.
 */

import { Router }        from 'express';
import { z }             from 'zod';
import { eq, and, isNull, gte, lte, inArray, desc } from 'drizzle-orm';
import * as jwtLib        from 'jsonwebtoken';

import { db }                from '../../db';
import { memories }          from '../../db/schema';
import { authenticate }      from '../../middleware/authenticate';
import { globalRateLimit }   from '../../middleware/rateLimit';
import { validate }          from '../../middleware/validate';
import { AppError }          from '../../lib/errors';
import { EncryptionService } from '../../services/EncryptionService';
import { verifyElevatedToken } from '../../lib/jwt';

export const memoriesRouter = Router();

memoriesRouter.use(authenticate);
memoriesRouter.use(globalRateLimit);

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PER_PAGE    = 20;
const MAX_PER_PAGE        = 50;
const ELEVATED_LEVEL_MIN  = 4; // levels 4–5 require the PIN step-up token

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/memories
// ─────────────────────────────────────────────────────────────────────────────
// Query params:
//   ?level=1,2,3   — comma-separated level filter (default: all 1–5)
//   ?from=YYYY-MM-DD — include memories with period_start >= from
//   ?to=YYYY-MM-DD   — include memories with period_end   <= to
//
// Returns list (no summary — it would require decrypting every row):
//   { id, title, level, dominant_emotion, created_at, period_start, period_end }

memoriesRouter.get('/', async (req, res, next) => {
  const userId = req.userId!;

  // ── Parse filters ──────────────────────────────────────────────────────────
  const levelParam = req.query.level as string | undefined;
  const fromParam  = req.query.from  as string | undefined;
  const toParam    = req.query.to    as string | undefined;

  const levelFilter: number[] | null = levelParam
    ? levelParam
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n >= 1 && n <= 5)
    : null;

  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const perPage = Math.min(
    MAX_PER_PAGE,
    Math.max(1, parseInt(String(req.query.per_page ?? String(DEFAULT_PER_PAGE)), 10) || DEFAULT_PER_PAGE),
  );
  const offset = (page - 1) * perPage;

  try {
    // Build WHERE conditions
    const conditions = [
      eq(memories.userId, userId),
      isNull(memories.deletedAt),
    ];

    if (levelFilter && levelFilter.length > 0) {
      conditions.push(inArray(memories.level, levelFilter));
    }
    if (fromParam) {
      conditions.push(gte(memories.periodStart, fromParam));
    }
    if (toParam) {
      conditions.push(lte(memories.periodEnd, toParam));
    }

    const rows = await db.query.memories.findMany({
      where:   and(...conditions),
      orderBy: [desc(memories.createdAt)],
      limit:   perPage + 1,
      offset,
      columns: {
        id:              true,
        conversationId:  true,
        title:           true,
        level:           true,
        dominantEmotion: true,
        createdAt:       true,
        periodStart:     true,
        periodEnd:       true,
        // summary and summaryIv intentionally excluded — requires decryption
      },
    });

    const hasMore = rows.length > perPage;
    const items   = hasMore ? rows.slice(0, perPage) : rows;

    return res.status(200).json({
      memories: items.map((m) => ({
        id:               m.id,
        conversation_id:  m.conversationId,
        title:            m.title,
        level:            m.level,
        dominant_emotion: m.dominantEmotion,
        created_at:       m.createdAt,
        period_start:     m.periodStart,
        period_end:       m.periodEnd,
      })),
      page,
      per_page: perPage,
      has_more: hasMore,
    });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/memories/:id
// ─────────────────────────────────────────────────────────────────────────────
// Returns full memory detail including decrypted summary.
// Level 4–5: requires X-Elevated-Token header (issued by POST /v1/auth/memory-pin/verify).
//
// Error contract:
//   404 — not found OR belongs to another user
//   403 MEMORY_ACCESS_DENIED  — level 4/5, no elevated token
//   401 ELEVATED_TOKEN_EXPIRED — level 4/5, expired/invalid token

memoriesRouter.get('/:id', async (req, res, next) => {
  const { id } = req.params;
  const userId  = req.userId!;

  try {
    const memory = await db.query.memories.findFirst({
      where: and(eq(memories.id, id), isNull(memories.deletedAt)),
    });

    // 404 for both "not found" and "belongs to another user"
    if (!memory || memory.userId !== userId) {
      return next(new AppError(404, 'NOT_FOUND'));
    }

    // ── Level 4–5 elevated-token gate ────────────────────────────────────────
    if (memory.level >= ELEVATED_LEVEL_MIN) {
      const elevatedTokenHeader = req.headers['x-elevated-token'] as string | undefined;

      if (!elevatedTokenHeader) {
        return next(new AppError(403, 'MEMORY_ACCESS_DENIED'));
      }

      try {
        const payload = verifyElevatedToken(elevatedTokenHeader);
        // Token must belong to the same user
        if (payload.sub !== userId) {
          return next(new AppError(403, 'MEMORY_ACCESS_DENIED'));
        }
      } catch (err) {
        if (err instanceof jwtLib.TokenExpiredError) {
          return next(new AppError(401, 'ELEVATED_TOKEN_EXPIRED'));
        }
        return next(new AppError(403, 'MEMORY_ACCESS_DENIED'));
      }
    }

    // ── Decrypt summary ───────────────────────────────────────────────────────
    const enc     = new EncryptionService(userId);
    const summary = enc.decrypt(memory.summary, memory.summaryIv);

    return res.status(200).json({
      id:               memory.id,
      title:            memory.title,
      summary,
      key_events:       memory.keyEvents,
      emotional_tags:   memory.emotionalTags,
      level:            memory.level,
      dominant_emotion: memory.dominantEmotion,
      created_at:       memory.createdAt,
      period_start:     memory.periodStart,
      period_end:       memory.periodEnd,
    });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /v1/memories/:id
// ─────────────────────────────────────────────────────────────────────────────
// Accepts { level: 1–5 } only — no other fields can be updated via this API.

const PatchMemorySchema = z.object({
  level: z.number().int().min(1).max(5, { message: 'level must be between 1 and 5' }),
});

memoriesRouter.patch('/:id', validate(PatchMemorySchema), async (req, res, next) => {
  const { id }    = req.params;
  const userId    = req.userId!;
  const { level } = req.body as z.infer<typeof PatchMemorySchema>;

  try {
    const memory = await db.query.memories.findFirst({
      where: and(eq(memories.id, id), isNull(memories.deletedAt)),
      columns: { id: true, userId: true },
    });

    if (!memory || memory.userId !== userId) {
      return next(new AppError(404, 'NOT_FOUND'));
    }

    const [updated] = await db
      .update(memories)
      .set({ level, updatedAt: new Date() })
      .where(eq(memories.id, id))
      .returning({
        id:    memories.id,
        level: memories.level,
      });

    return res.status(200).json({ id: updated.id, level: updated.level });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /v1/memories/:id
// ─────────────────────────────────────────────────────────────────────────────
// Soft delete — sets deleted_at to NOW(). The record stays in the database
// for the hard-delete background job (P4 account deletion flow).

memoriesRouter.delete('/:id', async (req, res, next) => {
  const { id } = req.params;
  const userId  = req.userId!;

  try {
    const memory = await db.query.memories.findFirst({
      where: and(eq(memories.id, id), isNull(memories.deletedAt)),
      columns: { id: true, userId: true },
    });

    if (!memory || memory.userId !== userId) {
      return next(new AppError(404, 'NOT_FOUND'));
    }

    await db
      .update(memories)
      .set({ deletedAt: new Date() })
      .where(eq(memories.id, id));

    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
});
