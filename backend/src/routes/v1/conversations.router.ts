/**
 * src/routes/v1/conversations.router.ts
 *
 * Conversation lifecycle endpoints (TDD P1-011 / sprint P1-15):
 *
 *   POST   /v1/conversations          — create a new conversation
 *   GET    /v1/conversations          — paginated list (started_at DESC)
 *   PATCH  /v1/conversations/:id      — close a conversation
 *   GET    /v1/conversations/:id      — metadata + last 20 decrypted messages
 *
 * Security notes:
 *   - All routes require a valid Bearer access token (authenticate middleware)
 *   - PATCH/:id returns 403 for wrong owner OR already-closed status
 *   - GET/:id returns 404 (not 403) for another user's conversation, to avoid
 *     leaking whether the conversation exists at all
 *
 * pg-boss extraction job:
 *   PATCH (close) stubs the extraction enqueue with a TODO comment.
 *   P1-19 (Memory Extraction Job) will replace the stub with a real
 *   pg-boss.send('memory_extraction', { conversationId, userId }) call.
 */

import { Router }    from 'express';
import { z }         from 'zod';
import { eq, desc } from 'drizzle-orm';
import { db }        from '../../db';
import { conversations, messages } from '../../db/schema';
import { authenticate }  from '../../middleware/authenticate';
import { globalRateLimit } from '../../middleware/rateLimit'; // aiRateLimit added in P1-18
import { validate }      from '../../middleware/validate';
import { AppError }      from '../../lib/errors';
import { EncryptionService } from '../../services/EncryptionService';

export const conversationsRouter = Router();

// ─── Router-level middleware ───────────────────────────────────────────────────
// All routes in this router require authentication and are subject to the
// global rate limit (60 req/min).  The messages endpoint (P1-18) will add
// aiRateLimit (20 req/min) on top of this.
conversationsRouter.use(authenticate);
conversationsRouter.use(globalRateLimit);

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PER_PAGE   = 20;
const MAX_PER_PAGE       = 50;
const RECENT_MSGS_LIMIT  = 20;

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/conversations
// ─────────────────────────────────────────────────────────────────────────────

conversationsRouter.post('/', async (req, res, next) => {
  try {
    const [conv] = await db
      .insert(conversations)
      .values({ userId: req.userId! })
      .returning({
        id:        conversations.id,
        startedAt: conversations.startedAt,
        status:    conversations.status,
      });

    return res.status(201).json({
      id:         conv.id,
      started_at: conv.startedAt,
      status:     conv.status,
    });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/conversations
// ─────────────────────────────────────────────────────────────────────────────

conversationsRouter.get('/', async (req, res, next) => {
  const page = Math.max(
    1,
    parseInt(String(req.query.page ?? '1'), 10) || 1,
  );
  const perPage = Math.min(
    MAX_PER_PAGE,
    Math.max(1, parseInt(String(req.query.per_page ?? String(DEFAULT_PER_PAGE)), 10) || DEFAULT_PER_PAGE),
  );
  const offset = (page - 1) * perPage;

  try {
    // Fetch one extra to determine whether a next page exists without a
    // separate COUNT(*) query.
    const rows = await db.query.conversations.findMany({
      where:   eq(conversations.userId, req.userId!),
      orderBy: [desc(conversations.startedAt)],
      limit:   perPage + 1,
      offset,
    });

    const hasMore = rows.length > perPage;
    const items   = hasMore ? rows.slice(0, perPage) : rows;

    return res.status(200).json({
      conversations: items.map((c) => ({
        id:            c.id,
        started_at:    c.startedAt,
        ended_at:      c.endedAt,
        status:        c.status,
        message_count: c.messageCount,
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
// PATCH /v1/conversations/:id
// ─────────────────────────────────────────────────────────────────────────────
// Only accepts { status: "closed" } — any other value returns 400.

const PatchConversationSchema = z.object({
  status: z.literal('closed', {
    errorMap: () => ({ message: 'status must be "closed"' }),
  }),
});

conversationsRouter.patch(
  '/:id',
  validate(PatchConversationSchema),
  async (req, res, next) => {
    const { id } = req.params;

    try {
      const conv = await db.query.conversations.findFirst({
        where: eq(conversations.id, id),
      });

      if (!conv) {
        return next(new AppError(404, 'NOT_FOUND'));
      }

      // Only the owner may close their own conversation
      if (conv.userId !== req.userId) {
        return next(new AppError(403, 'FORBIDDEN'));
      }

      // Can only close an active conversation
      if (conv.status !== 'active') {
        return next(new AppError(403, 'CONVERSATION_NOT_ACTIVE'));
      }

      const [updated] = await db
        .update(conversations)
        .set({ status: 'closed', endedAt: new Date() })
        .where(eq(conversations.id, id))
        .returning();

      // ── TODO (P1-19): enqueue memory extraction job via pg-boss ─────────────
      // await jobQueue.send('memory_extraction', {
      //   conversationId: id,
      //   userId:         req.userId!,
      // });
      // ────────────────────────────────────────────────────────────────────────

      return res.status(200).json({
        id:         updated.id,
        started_at: updated.startedAt,
        ended_at:   updated.endedAt,
        status:     updated.status,
      });
    } catch (err) {
      return next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/conversations/:id
// ─────────────────────────────────────────────────────────────────────────────
// Returns conversation metadata + the 20 most recent decrypted messages in
// chronological order.
//
// Returns 404 (not 403) when the conversation belongs to another user, to
// avoid leaking the existence of other users' conversations.

conversationsRouter.get('/:id', async (req, res, next) => {
  const { id } = req.params;

  try {
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, id),
    });

    // Both "not found" and "belongs to another user" return 404
    if (!conv || conv.userId !== req.userId) {
      return next(new AppError(404, 'NOT_FOUND'));
    }

    // Fetch the most recent messages (DESC), then reverse for chronological output
    const rawMessages = await db.query.messages.findMany({
      where:   eq(messages.conversationId, id),
      orderBy: [desc(messages.createdAt)],
      limit:   RECENT_MSGS_LIMIT,
    });

    // Lazily construct EncryptionService so GET/:id works even when there are
    // no messages (avoids throwing if APP_SECRET is absent in test envs).
    let enc: EncryptionService | null = null;
    const decryptedMessages = rawMessages.reverse().map((m) => {
      if (!enc) enc = new EncryptionService(req.userId!);
      return {
        id:           m.id,
        role:         m.role,
        content:      enc.decrypt(m.content, m.contentIv),
        emotion_tags: m.emotionTags ?? null,
        created_at:   m.createdAt,
      };
    });

    return res.status(200).json({
      id:            conv.id,
      started_at:    conv.startedAt,
      ended_at:      conv.endedAt,
      status:        conv.status,
      message_count: conv.messageCount,
      messages:      decryptedMessages,
    });
  } catch (err) {
    return next(err);
  }
});

// ─── POST /v1/conversations/:id/messages ──────────────────────────────────────
// Implemented in P1-18. Will apply aiRateLimit in addition to globalRateLimit:
//
//   conversationsRouter.post(
//     "/:id/messages",
//     aiRateLimit,      ← 20 req/min (AI cost guard)
//     validate(MessageSchema),
//     messagesHandler,
//   );

