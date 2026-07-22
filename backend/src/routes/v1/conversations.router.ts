/**
 * src/routes/v1/conversations.router.ts
 *
 * Conversation endpoints including the SSE message-streaming endpoint
 * (TDD P1-011, P1-012, P1-013, P1-014 / sprint P1-15, P1-18).
 *
 * POST   /v1/conversations                — create conversation
 * GET    /v1/conversations                — paginated list
 * PATCH  /v1/conversations/:id            — close conversation
 * GET    /v1/conversations/:id            — metadata + last 20 messages
 * POST   /v1/conversations/:id/messages   — send message, stream AI response (SSE)
 *
 * SSE frame schema (TDD §6.3):
 *   event: token  data: { "delta": "<token>" }
 *   event: done   data: { "message_id": "<uuid>", "emotion_tags": { "primary": "<str>", "score": <float> } }
 *   event: error  data: { "code": "LLM_STREAM_ERROR" | "LLM_TIMEOUT" }
 *
 * Redis context cache (TDD §6.4 / P1-014):
 *   Key:  conv_ctx:{conversationId}
 *   Type: Redis LIST of JSON strings — { role, content (decrypted) }
 *   TTL:  30 minutes, reset on every write
 *   Size: trimmed to most recent 20 entries after each append
 *   Miss: fall back to DB query, repopulate cache
 */

import { Router }           from 'express';
import { z }                from 'zod';
import { eq, desc, sql }    from 'drizzle-orm';
import type { Response }    from 'express';

import { db }                from '../../db';
import {
  conversations,
  messages,
  users,
  userContext,
}                            from '../../db/schema';
import { redis }             from '../../lib/redis';
import { authenticate }      from '../../middleware/authenticate';
import { globalRateLimit, aiRateLimit } from '../../middleware/rateLimit';
import { validate }          from '../../middleware/validate';
import { AppError }          from '../../lib/errors';
import { EncryptionService } from '../../services/EncryptionService';
import { AIOrchestrationService } from '../../ai/AIOrchestrationService';
import { AnthropicProvider } from '../../ai/llm/AnthropicProvider';
import { LLMTimeoutError } from '../../ai/llm/errors';
import type { Message }      from '../../ai/llm/types';
import { warn }              from '../../lib/logger';
import { enqueueExtractionJob } from '../../jobs';
import type { PgBoss } from 'pg-boss';

// ─── Router + global middleware ────────────────────────────────────────────────

export const conversationsRouter = Router();

conversationsRouter.use(authenticate);
conversationsRouter.use(globalRateLimit);

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_PER_PAGE  = 20;
const MAX_PER_PAGE      = 50;
const RECENT_MSG_LIMIT  = 20;
const MAX_CONTENT_LEN   = 2_000;
const CONTEXT_TTL_SEC   = 30 * 60;   // 30 minutes
const MAX_CONTEXT_MSGS  = 20;
const FIRST_TOKEN_TIMEOUT_MS = 20_000; // 20 seconds

// ─── Singleton orchestrator ─────────────────────────────────────────────────────

let _orchestrator: AIOrchestrationService | null = null;
function getOrchestrator(): AIOrchestrationService {
  if (!_orchestrator) _orchestrator = new AIOrchestrationService(new AnthropicProvider());
  return _orchestrator;
}

// Allow injection in tests
export function setOrchestrator(o: AIOrchestrationService): void {
  _orchestrator = o;
}

// ─── pg-boss job queue (injected at startup) ───────────────────────────────────

let _jobQueue: PgBoss | null = null;
export function setJobQueue(boss: PgBoss): void {
  _jobQueue = boss;
}

// ─── In-memory SSE buffer for Last-Event-ID reconnection ──────────────────────

interface StreamState { tokens: string[]; done: boolean; }
const activeStreams = new Map<string, StreamState>();

// ─── Redis context cache helpers ───────────────────────────────────────────────

const ctxKey = (id: string) => `conv_ctx:${id}`;

async function getContextMessages(
  convId: string,
  userId: string,
  enc:    EncryptionService,
): Promise<Message[]> {
  // Try Redis first
  try {
    const entries = await redis.lrange(ctxKey(convId), 0, -1);
    if (entries.length > 0) {
      return entries.map((e) => JSON.parse(e) as Message);
    }
  } catch (err) {
    warn({ event: 'context_cache_miss', conversation_id: convId,
           error: err instanceof Error ? err.message : String(err) });
  }

  // DB fallback — fetch most recent messages and repopulate
  const rawMsgs = await db.query.messages.findMany({
    where:   eq(messages.conversationId, convId),
    orderBy: [desc(messages.createdAt)],
    limit:   MAX_CONTEXT_MSGS,
  });

  const contextMsgs: Message[] = rawMsgs.reverse().map((m) => ({
    role:    m.role as 'user' | 'assistant',
    content: enc.decrypt(m.content, m.contentIv),
  }));

  // Repopulate cache (fire-and-forget — non-fatal)
  if (contextMsgs.length > 0) {
    const pipe = redis.pipeline().del(ctxKey(convId));
    for (const m of contextMsgs) {
      pipe.rpush(ctxKey(convId), JSON.stringify(m));
    }
    pipe.expire(ctxKey(convId), CONTEXT_TTL_SEC).exec().catch(() => { /* non-fatal */ });
  }

  return contextMsgs;
}

async function appendToContextCache(
  convId:  string,
  entry:   { role: string; content: string },
): Promise<void> {
  redis
    .pipeline()
    .rpush(ctxKey(convId), JSON.stringify(entry))
    .ltrim(ctxKey(convId), -MAX_CONTEXT_MSGS, -1)
    .expire(ctxKey(convId), CONTEXT_TTL_SEC)
    .exec()
    .catch(() => { /* non-fatal */ });
}

// ─── Emotion detection (lightweight heuristic from user message) ───────────────

function detectEmotion(text: string): { primary: string; score: number } {
  const t = text.toLowerCase();
  if (/anxious|anxiety|worried|worry|stress|panic|nervous|overwhelm/.test(t))
    return { primary: 'anxiety',    score: 0.75 };
  if (/sad|depress|unhappy|cry|grief|lonely|lost|hopeless/.test(t))
    return { primary: 'sadness',    score: 0.75 };
  if (/angry|anger|furious|frustrated|mad|annoyed|rage/.test(t))
    return { primary: 'anger',      score: 0.75 };
  if (/excit|thrilled|pumped|energetic|enthusiastic|eager/.test(t))
    return { primary: 'excitement', score: 0.75 };
  if (/happy|joy|great|wonderful|amazing|grateful|love/.test(t))
    return { primary: 'joy',        score: 0.75 };
  if (/calm|peace|relax|serene|content|okay|fine|good/.test(t))
    return { primary: 'calm',       score: 0.70 };
  return { primary: 'calm', score: 0.5 };
}

// ─── SSE helpers ───────────────────────────────────────────────────────────────

function writeSseEvent(
  res:   Response,
  event: string,
  data:  unknown,
  id?:   number,
): void {
  let frame = '';
  if (id !== undefined) frame += `id: ${id}\n`;
  frame += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  res.write(frame);
}

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

    // P1-014: initialise the Redis context list so the first-message read
    // hits an empty-but-existing key instead of a DB fallback.
    // Note: Redis auto-deletes empty lists, so we initialise with a
    // placeholder that is trimmed away on first real append.
    redis.pipeline()
      .rpush(ctxKey(conv.id), JSON.stringify({ _init: true }))
      .ltrim(ctxKey(conv.id), 1, 0)   // immediately empty the list; sets TTL on next op
      .expire(ctxKey(conv.id), CONTEXT_TTL_SEC)
      .exec()
      .catch(() => { /* non-fatal */ });

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
// POST /v1/conversations/:id/messages  (SSE streaming)
// ─────────────────────────────────────────────────────────────────────────────
//
// Flow:
//   1. Validate content (400 empty / 413 > 2000)
//   2. Verify conversation (404 / 403 / 409)
//   3. Encrypt + save user message in DB (BEFORE LLM call — prevents message loss)
//   4. Assemble context window from Redis (or DB fallback)
//   5. Set SSE response headers
//   6. Handle Last-Event-ID reconnection (replay in-memory buffer)
//   7. Stream AI tokens → event:token frames
//   8. 20s timeout for first token → event:error code:LLM_TIMEOUT
//   9. On stream complete → save assistant message + increment message_count (transaction)
//  10. Send event:done with message_id + emotion_tags
//  11. On any stream error → event:error, partial response NOT saved

conversationsRouter.post('/:id/messages', aiRateLimit, async (req, res, next) => {
  const convId = req.params.id;
  const userId = req.userId!;

  // ── 1. Validate content ────────────────────────────────────────────────────
  // Handle these directly (not via validate middleware) because the 413
  // status code can't be expressed in a standard Zod refinement.
  // Per spec, neither case is logged to structured logs — we return early
  // before any logging or DB interaction.
  const rawContent = (req.body as Record<string, unknown>).content;

  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      meta:  { request_id: req.requestId ?? null },
    });
  }

  if (rawContent.length > MAX_CONTENT_LEN) {
    return res.status(413).json({
      error: 'CONTENT_TOO_LONG',
      meta:  { request_id: req.requestId ?? null },
    });
  }

  const content = rawContent.trim();

  // ── 2. Verify conversation ─────────────────────────────────────────────────
  let conv: typeof conversations.$inferSelect | undefined;
  try {
    conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, convId),
    });
  } catch (err) {
    return next(err);
  }

  if (!conv)                     return next(new AppError(404, 'NOT_FOUND'));
  if (conv.userId !== userId)    return next(new AppError(403, 'FORBIDDEN'));
  if (conv.status !== 'active')  return next(new AppError(409, 'CONVERSATION_CLOSED'));

  // ── 3. Encrypt + save user message BEFORE the LLM call ────────────────────
  // This guarantees the user's message is persisted even if the LLM times out
  // or the connection drops mid-stream (TDD P1-012 unit-test criterion).
  const enc = new EncryptionService(userId);
  const { ciphertext, iv } = enc.encrypt(content);

  let userMsgId: string;
  try {
    const [userMsg] = await db.transaction(async (tx) => {
      const [msg] = await tx
        .insert(messages)
        .values({
          conversationId: convId,
          userId,
          role:      'user',
          content:   ciphertext,
          contentIv: iv,
        })
        .returning({ id: messages.id });

      await tx
        .update(conversations)
        .set({ messageCount: sql`${conversations.messageCount} + 1` })
        .where(eq(conversations.id, convId));

      return [msg];
    });
    userMsgId = userMsg.id;
  } catch (err) {
    return next(err);
  }

  // ── 4. Assemble context window ─────────────────────────────────────────────
  let contextMsgs: Message[] = [];
  try {
    contextMsgs = await getContextMessages(convId, userId, enc);
  } catch { /* non-fatal — empty context is worse than no context */ }

  // Append the new user message to both in-memory context and cache
  const userMsgEntry: Message = { role: 'user', content };
  contextMsgs.push(userMsgEntry);
  appendToContextCache(convId, userMsgEntry); // fire-and-forget

  // Load user profile for prompt personalisation
  const [user, ctx] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId) }).catch(() => null),
    db.query.userContext.findFirst({ where: eq(userContext.userId, userId) }).catch(() => null),
  ]);

  // ── 5. Set SSE response headers ────────────────────────────────────────────
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx proxy buffering

  // ── 6. Handle Last-Event-ID reconnection ───────────────────────────────────
  const lastEventIdHeader = req.headers['last-event-id'];
  const lastEventId = lastEventIdHeader ? parseInt(String(lastEventIdHeader), 10) : -1;
  let tokenIndex = 0;

  const existingStream = activeStreams.get(convId);
  if (existingStream && !existingStream.done && lastEventId >= 0) {
    // Replay tokens the client missed (from lastEventId + 1 onward)
    const missedTokens = existingStream.tokens.slice(lastEventId + 1);
    for (const token of missedTokens) {
      writeSseEvent(res, 'token', { delta: token }, lastEventId + 1 + tokenIndex);
      tokenIndex++;
    }
  }

  // Initialise or reset the stream buffer for this conversation
  const streamState: StreamState = existingStream ?? { tokens: [], done: false };
  activeStreams.set(convId, streamState);

  // ── 7. Stream AI response ──────────────────────────────────────────────────
  let firstTokenReceived = false;
  let accumulated        = '';
  const timeoutHandle    = setTimeout(() => {
    if (!firstTokenReceived) {
      writeSseEvent(res, 'error', { code: 'LLM_TIMEOUT' });
      res.end();
      activeStreams.delete(convId);
    }
  }, FIRST_TOKEN_TIMEOUT_MS);

  // Clean up on client disconnect
  req.on('close', () => {
    clearTimeout(timeoutHandle);
    // Leave stream buffer in place — client may reconnect with Last-Event-ID
  });

  const orchestrator = getOrchestrator();

  try {
    const gen = orchestrator.stream({
      mode:     'chat',
      messages: contextMsgs,
      userProfile: {
        displayName:    user?.displayName    ?? '',
        timezone:       user?.timezone       ?? 'UTC',
        commStyle:      (user?.commStyle     ?? 'warm') as 'warm' | 'direct' | 'reflective',
        onboardingDone: user?.onboardingDone ?? true,
        contextSummary: ctx?.contextSummary  ?? null,
      },
    });

    for await (const token of gen) {
      if (!firstTokenReceived) {
        firstTokenReceived = true;
        clearTimeout(timeoutHandle);
      }

      writeSseEvent(res, 'token', { delta: token }, tokenIndex);
      streamState.tokens.push(token);
      accumulated += token;
      tokenIndex++;
    }

    // ── 8. Save assistant message + increment message_count (atomic) ─────────
    const emotion = detectEmotion(content);
    const aiEnc   = enc.encrypt(accumulated);

    const [assistantMsg] = await db.transaction(async (tx) => {
      const [msg] = await tx
        .insert(messages)
        .values({
          conversationId: convId,
          userId,
          role:       'assistant',
          content:    aiEnc.ciphertext,
          contentIv:  aiEnc.iv,
          emotionTags: emotion,
        })
        .returning({ id: messages.id });

      await tx
        .update(conversations)
        .set({ messageCount: sql`${conversations.messageCount} + 1` })
        .where(eq(conversations.id, convId));

      return [msg];
    });

    // Append assistant message to context cache
    appendToContextCache(convId, { role: 'assistant', content: accumulated });

    // ── 9. Send event:done ───────────────────────────────────────────────────
    writeSseEvent(res, 'done', {
      message_id:   assistantMsg.id,
      emotion_tags: emotion,
    });

    streamState.done = true;
    activeStreams.delete(convId);
    res.end();
  } catch (err) {
    clearTimeout(timeoutHandle);
    activeStreams.delete(convId);

    const isTimeout   = err instanceof LLMTimeoutError;
    const errorCode   = isTimeout ? 'LLM_TIMEOUT' : 'LLM_STREAM_ERROR';

    writeSseEvent(res, 'error', { code: errorCode });
    res.end();
    // Do NOT call next(err) — the SSE connection is already closed.
    // The user message (saved in step 3) is preserved in the DB.
  }

  // Satisfy TS exhaustive return path requirement
  return userMsgId as unknown as void;
});
