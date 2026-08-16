/**
 * src/routes/v1/conversations.router.ts
 *
 * Conversation lifecycle endpoints, including the SSE message-streaming
 * endpoint (TDD P1-011 through P1-014 / sprint P1-15, P1-18).
 *
 *   POST   /v1/conversations                — create conversation
 *   GET    /v1/conversations                — paginated list
 *   PATCH  /v1/conversations/:id            — close conversation
 *   GET    /v1/conversations/:id            — metadata + last 20 messages
 *   POST   /v1/conversations/:id/messages   — send message, stream AI reply (SSE)
 *
 * SSE frame schema (TDD §6.3):
 *   event: token  data: { "delta": "<token>" }
 *   event: done   data: { "message_id": "<uuid>", "emotion_tags": { "primary": "<str>", "score": <float> }, "onboarding_complete"?: true }
 *   event: error  data: { "code": "LLM_STREAM_ERROR" | "LLM_TIMEOUT" }
 *
 * The streaming mechanics (token-gap timeout, session attachment, the
 * background "AI response job") live in ./messagesStream.ts so they can
 * be unit-tested in isolation. This file owns routing, validation, and
 * conversation/ownership checks.
 */

import { Router }        from 'express';
import { z }             from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import type PgBoss       from 'pg-boss';

import { db }                from '../../db';
import { conversations, messages, users, userContext } from '../../db/schema';
import { authenticate }      from '../../middleware/authenticate';
import { globalRateLimit, aiRateLimit } from '../../middleware/rateLimit';
import { validate }          from '../../middleware/validate';
import { AppError }          from '../../lib/errors';
import { warn }              from '../../lib/logger';
import { EncryptionService } from '../../services/EncryptionService';
import {
  initContextCache,
  getContextWindow,
  repopulateContextCache,
  appendToContextCache,
} from '../../lib/conversationContextCache';
import { createSession, getSession } from '../../lib/streamSessionRegistry';
import {
  setSseHeaders,
  writeSseEvent,
  attachToSession,
  driveOrchestrationStream,
} from './messagesStream';
import { enqueueExtractionJob } from '../../jobs';
import type { Message } from '../../ai/llm/types';

export const conversationsRouter = Router();

// All routes in this router require authentication and are subject to
// the global rate limit (60 req/min). The messages endpoint below adds
// aiRateLimit (20 req/min) on top of this.
conversationsRouter.use(authenticate);
conversationsRouter.use(globalRateLimit);

// ─── pg-boss instance (injected at startup) ────────────────────────────────────
// Set via setJobQueue() once pg-boss.start() completes. Nullable so route
// handlers degrade gracefully (log + skip enqueue) if the queue is not yet
// available rather than crashing.

let _jobQueue: PgBoss | null = null;
export function setJobQueue(boss: PgBoss): void {
  _jobQueue = boss;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PER_PAGE  = 20;
const MAX_PER_PAGE      = 50;
const RECENT_MSG_LIMIT  = 20;
const MAX_CONTENT_LEN   = 2_000;
const MAX_CONTEXT_MSGS  = 20;

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/conversations
// ─────────────────────────────────────────────────────────────────────────────

conversationsRouter.post('/', async (req, res, next) => {
  try {
    // Only one active conversation per user at a time — the client (see
    // ConversationHistoryScreen) pins a single "active" conversation above
    // the history list and has no UI for juggling more than one.
    const existingActive = await db.query.conversations.findFirst({
      where: and(
        eq(conversations.userId, req.userId!),
        eq(conversations.status, 'active'),
      ),
    });

    if (existingActive) {
      return next(new AppError(409, 'ACTIVE_CONVERSATION_EXISTS'));
    }

    const [conv] = await db
      .insert(conversations)
      .values({ userId: req.userId! })
      .returning({
        id:        conversations.id,
        startedAt: conversations.startedAt,
        status:    conversations.status,
      });

    // P1-014: seed an empty context cache so the first message of this
    // conversation reads a cache HIT (an intentionally-empty window)
    // rather than falling back to a (trivially empty anyway) DB query.
    // Fire-and-forget — the cache is an optimisation, not a dependency
    // for conversation creation to succeed.
    void initContextCache(conv.id);

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

      if (!conv)                    return next(new AppError(404, 'NOT_FOUND'));
      if (conv.userId !== req.userId) return next(new AppError(403, 'FORBIDDEN'));
      if (conv.status !== 'active')  return next(new AppError(403, 'CONVERSATION_NOT_ACTIVE'));

      // Close the conversation and increment session_count in one transaction
      // so they are always consistent — if the close fails, the count stays put.
      const updated = await db.transaction(async (tx) => {
        const [closed] = await tx
          .update(conversations)
          .set({ status: 'closed', endedAt: new Date() })
          .where(eq(conversations.id, id))
          .returning();

        // Increment session_count — used by Phase 2 personalization refresh (P2-005)
        // to know when to re-evaluate the user's communication style.
        await tx
          .update(userContext)
          .set({ sessionCount: sql`${userContext.sessionCount} + 1` })
          .where(eq(userContext.userId, req.userId!));

        return closed;
      });

      // Enqueue memory extraction job via pg-boss (P1-19).
      // Fire-and-forget: the close response must not wait on the queue write.
      if (_jobQueue) {
        void enqueueExtractionJob(_jobQueue, { conversation_id: id, user_id: req.userId! });
      } else {
        warn({ event: 'extraction_enqueue_skipped_no_queue', conversation_id: id });
      }

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

conversationsRouter.get('/:id', async (req, res, next) => {
  const { id } = req.params;

  try {
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, id),
    });

    if (!conv || conv.userId !== req.userId) {
      return next(new AppError(404, 'NOT_FOUND'));
    }

    const rawMessages = await db.query.messages.findMany({
      where:   eq(messages.conversationId, id),
      orderBy: [desc(messages.createdAt)],
      limit:   RECENT_MSG_LIMIT,
    });

    // Lazy init — avoids throwing when APP_SECRET is absent and there are no messages
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/conversations/:id/messages   (SSE streaming)
// ─────────────────────────────────────────────────────────────────────────────
//
// Two distinct flows, distinguished by the presence of a Last-Event-ID header:
//
//   FRESH MESSAGE (no Last-Event-ID):
//     1. Validate content (400 VALIDATION_ERROR / 413 CONTENT_TOO_LONG)
//     2. Verify conversation: 404 (not found / not owner), 409 (not active)
//     3. Read prior context window (Redis, DB fallback on miss) — BEFORE
//        storing the new message, to avoid a duplicate-or-missing race
//     4. Encrypt + store the user message, increment message_count
//        (one transaction) — this happens unconditionally, before any LLM
//        call, so a later LLM timeout/failure never loses the message
//     5. Create a StreamSession; attach this response to it; kick off the
//        background driver (NOT awaited) to run the LLM stream to completion
//
//   RECONNECT (Last-Event-ID present):
//     1. Look up the existing session for this conversation
//     2. If found: attach this response, replaying tokens after the given ID
//     3. If not found (session already cleaned up / never existed): send a
//        single event:error LLM_STREAM_ERROR — the job can't be resumed

conversationsRouter.post('/:id/messages', aiRateLimit, async (req, res, next) => {
  const conversationId = req.params.id;
  const userId         = req.userId!;

  // ── Reconnect path ────────────────────────────────────────────────────────
  const lastEventIdHeader = req.headers['last-event-id'];
  if (typeof lastEventIdHeader === 'string') {
    const lastEventId = parseInt(lastEventIdHeader, 10) || 0;
    const session      = getSession(conversationId);

    setSseHeaders(res);

    if (!session) {
      // Nothing to resume — the job already finished and was cleaned up,
      // or this server instance never had it (e.g. restarted mid-stream).
      writeSseEvent(res, 'error', { code: 'LLM_STREAM_ERROR' });
      res.end();
      return;
    }

    attachToSession(res, session, lastEventId);
    return;
  }

  // ── Fresh message path ──────────────────────────────────────────────────────

  // 1. Validate content. Handled manually (not via the generic `validate`
  //    middleware) because 413 can't be expressed through a Zod refinement
  //    alongside the 400 case — both share this one field. Per spec, neither
  //    validation failure is logged beyond the generic HTTP access log.
  const rawContent = (req.body as Record<string, unknown> | undefined)?.content;

  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    return next(new AppError(400, 'VALIDATION_ERROR'));
  }
  if (rawContent.length > MAX_CONTENT_LEN) {
    return next(new AppError(413, 'CONTENT_TOO_LONG'));
  }
  const content = rawContent.trim();

  // 2. Verify conversation ownership + status.
  let conv: typeof conversations.$inferSelect | undefined;
  try {
    conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });
  } catch (err) {
    return next(err);
  }

  if (!conv)                     return next(new AppError(404, 'NOT_FOUND'));
  if (conv.userId !== userId)    return next(new AppError(403, 'FORBIDDEN'));
  if (conv.status !== 'active')  return next(new AppError(409, 'CONVERSATION_CLOSED'));

  const enc = new EncryptionService(userId);

  // 3. Read PRIOR context (cache-first, DB fallback) — before storing the
  //    new message, so neither path can duplicate or omit it.
  let priorContext = await getContextWindow(conversationId);
  if (priorContext === null) {
    try {
      const rawHistory = await db.query.messages.findMany({
        where:   eq(messages.conversationId, conversationId),
        orderBy: [desc(messages.createdAt)],
        limit:   MAX_CONTEXT_MSGS,
      });
      priorContext = rawHistory.reverse().map((m) => ({
        role:    m.role as 'user' | 'assistant',
        content: enc.decrypt(m.content, m.contentIv),
      }));
      void repopulateContextCache(conversationId, priorContext);
    } catch (err) {
      // DB fallback failed too. Proceed with empty context rather than
      // failing the whole request — the AI will just have less history.
      warn({
        event:           'context_fallback_failed',
        conversation_id: conversationId,
        error:           err instanceof Error ? err.message : String(err),
      });
      priorContext = [];
    }
  }

  // 4. Encrypt + store the user message BEFORE the LLM call (TDD P1-012:
  //    a later LLM timeout must never lose the user's message).
  const { ciphertext, iv } = enc.encrypt(content);

  try {
    await db.transaction(async (tx) => {
      await tx.insert(messages).values({
        conversationId,
        userId,
        role:      'user',
        content:   ciphertext,
        contentIv: iv,
      });

      await tx
        .update(conversations)
        .set({ messageCount: sql`${conversations.messageCount} + 1` })
        .where(eq(conversations.id, conversationId));
    });
  } catch (err) {
    return next(err);
  }

  const userMessage: Message = { role: 'user', content };
  void appendToContextCache(conversationId, userMessage); // fire-and-forget

  const fullContext = [...priorContext, userMessage];

  // Load user profile for prompt personalisation.
  const [userRow, contextRow] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId) }).catch(() => undefined),
    db.query.userContext.findFirst({ where: eq(userContext.userId, userId) }).catch(() => undefined),
  ]);

  // 5. Start streaming.
  setSseHeaders(res);

  const session = createSession(conversationId);
  // Attach THIS response synchronously, before any await below can let the
  // background driver push a token — guarantees no token is missed between
  // session creation and subscription.
  attachToSession(res, session, 0);

  const onboardingDone = userRow?.onboardingDone ?? true;

  void driveOrchestrationStream({
    session,
    conversationId,
    userId,
    contextMessages: fullContext,
    userMessageContent: content,
    userProfile: {
      displayName:    userRow?.displayName    ?? '',
      timezone:       userRow?.timezone       ?? 'UTC',
      commStyle:      (userRow?.commStyle     ?? 'warm') as 'warm' | 'direct' | 'reflective',
      onboardingDone,
      contextSummary: contextRow?.contextSummary ?? null,
    },
    encryptionService:     enc,
    conversationStartedAt: conv.startedAt,
    onboardingDone,
    jobQueue:              _jobQueue,
  });
});
