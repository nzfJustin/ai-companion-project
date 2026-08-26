/**
 * src/routes/v1/messagesStream.ts
 *
 * SSE mechanics for POST /v1/conversations/:id/messages (TDD P1-013).
 * Separated from conversations.router.ts so the streaming/persistence
 * logic can be unit-tested without spinning up Express + supertest.
 *
 * Two responsibilities:
 *   1. driveOrchestrationStream() — runs the LLM stream to completion in
 *      the background, independent of any single HTTP connection. Persists
 *      the assistant message + emotion tag on success; persists nothing on
 *      failure (TDD: "the partial AI response is NOT stored in the DB").
 *   2. attachToSession() — wires a live HTTP response to a StreamSession,
 *      replaying buffered tokens (for Last-Event-ID reconnects) and then
 *      forwarding new tokens/terminal events as they occur.
 */

import { eq, sql }        from 'drizzle-orm';
import type { Response }  from 'express';
import type PgBoss        from 'pg-boss';
import { db }             from '../../db';
import { conversations, messages, userContext } from '../../db/schema';
import type { EncryptionService }  from '../../services/EncryptionService';
import { detectEmotion }           from '../../services/EmotionDetector';
import { appendToContextCache }    from '../../lib/conversationContextCache';
import { aiOrchestrationService }  from '../../ai/instance';
import { enqueueExtractionJob }    from '../../jobs';
import { LLMTimeoutError }         from '../../ai/llm/errors';
import { warn }                    from '../../lib/logger';
import type { Message }            from '../../ai/llm/types';
import type {
  UserProfileForOrchestration,
} from '../../ai/AIOrchestrationService';
import {
  ONBOARDING_COMPLETE_SENTINEL,
  buildOnboardingTransitionBlock,
  buildAutoTransitionBlock,
} from '../../ai/prompts';
import type {
  StreamSession,
  BufferedToken,
  DoneMeta,
  ErrorMeta,
} from '../../lib/streamSessionRegistry';

// Re-exported so callers (and tests) that only care about the transition
// blocks don't need a second import from ai/prompts.
export { ONBOARDING_COMPLETE_SENTINEL, buildOnboardingTransitionBlock, buildAutoTransitionBlock };

// ─── Crisis sentinel (T-007) ──────────────────────────────────────────────────
export const CRISIS_SENTINEL = 'CRISIS_RESOURCE_INJECTED';

const TRAILING_CRISIS_SENTINEL_RE = new RegExp(`\\s*${CRISIS_SENTINEL}\\s*$`);

/**
 * Strips a TRAILING CRISIS_SENTINEL from `text`, along with any surrounding
 * whitespace. Only a sentinel anchored at the very end counts as detected —
 * an incidental mid-response mention of the constant is not a real
 * guardrail trigger and is left untouched.
 *
 * Tests the trailing-anchored regex directly (not a loose `.includes()`
 * pre-check) — a naive `.includes()` gate would report detected: true for
 * any occurrence anywhere in the text, even one nowhere near the end.
 */
export function stripCrisisSentinel(text: string): { text: string; detected: boolean } {
  if (!TRAILING_CRISIS_SENTINEL_RE.test(text)) {
    return { text, detected: false };
  }
  const stripped = text.replace(TRAILING_CRISIS_SENTINEL_RE, '').trimEnd();
  return { text: stripped, detected: true };
}

// ─── Onboarding transition sentinel (onboarding UX fix) ──────────────────────
//
// When the LLM confirms the user wants to jump to the main chat after 3
// minutes of onboarding, it appends ONBOARDING_COMPLETE at the end of its
// response (instructed by buildOnboardingTransitionBlock() in prompts/index.ts).
// We strip it before persistence and emit onboarding_complete: true in the
// SSE done payload so the frontend can navigate to /chat.
//
// The sentinel shares the same streaming-buffer approach as the crisis
// sentinel so it never reaches the client in the raw SSE token stream.

const TRAILING_ONBOARDING_SENTINEL_RE = new RegExp(`\\s*${ONBOARDING_COMPLETE_SENTINEL}\\s*$`);

/** Same trailing-anchored-regex approach as stripCrisisSentinel — see there
 *  for why a loose `.includes()` pre-check would be wrong. */
export function stripOnboardingSentinel(text: string): { text: string; detected: boolean } {
  if (!TRAILING_ONBOARDING_SENTINEL_RE.test(text)) {
    return { text, detected: false };
  }
  const stripped = text.replace(TRAILING_ONBOARDING_SENTINEL_RE, '').trimEnd();
  return { text: stripped, detected: true };
}

/**
 * Two onboarding-transition thresholds, both read lazily (not at module-load
 * time) so tests can set the env var overrides per-case:
 *
 *   ONBOARDING_OFFER_MS — 3 min default: offer the user a choice to jump to
 *     chat or keep going (showTransitionOffer).
 *   ONBOARDING_AUTO_MS  — 6 min default: auto-wrap-up without asking, for a
 *     user who declined (or never responded to) the 3-minute offer
 *     (autoTransition). Takes priority over the offer — see
 *     driveOrchestrationStream below.
 *
 * Number.isFinite (not `||`) so an override of '0' is honoured — `0 || default`
 * would silently fall back to the default since 0 is falsy, defeating tests
 * that use ONBOARDING_*_MS_OVERRIDE=0 to force a threshold instantly.
 */
function onboardingOfferMs(): number {
  const override = parseInt(process.env.ONBOARDING_OFFER_MS_OVERRIDE ?? '', 10);
  return Number.isFinite(override) ? override : 3 * 60 * 1_000; // default: 3 minutes
}

function onboardingAutoMs(): number {
  const override = parseInt(process.env.ONBOARDING_AUTO_MS_OVERRIDE ?? '', 10);
  return Number.isFinite(override) ? override : 6 * 60 * 1_000; // default: 6 minutes
}

/**
 * Returns the length of the longest suffix of `tail` that is also a prefix
 * of `sentinel` — i.e. how much of `tail`'s end could be the start of an
 * in-progress match for that sentinel. 0 means no overlap.
 */
function sentinelPrefixOverlapLength(tail: string, sentinel: string): number {
  // A provider can append trailing whitespace after a complete sentinel
  // despite the prompt instructing "nothing after it" — real models do
  // this, and streaming providers that chunk by word (including
  // MockLLMProvider, word + ' ') always do. Check the overlap against the
  // tail with trailing whitespace trimmed off, then — only if a match is
  // actually found — withhold that trimmed whitespace too, so a sentinel
  // followed by a trailing space/newline is still fully caught. Ordinary
  // text (the vast majority of tokens, which never overlap a sentinel at
  // all) is unaffected: trailingWs is only added on top of a genuine match.
  const trimmedTail = tail.replace(/\s+$/, '');
  const trailingWs  = tail.length - trimmedTail.length;

  const maxLen = Math.min(trimmedTail.length, sentinel.length);
  for (let len = maxLen; len > 0; len--) {
    if (sentinel.startsWith(trimmedTail.slice(-len))) return len + trailingWs;
  }
  return 0;
}

/**
 * The streaming loop in driveOrchestrationStream() doesn't know in advance
 * which sentinel (if either) is coming, so it withholds however much of the
 * tail could be a prefix of EITHER one — the larger of the two overlaps.
 * Used to decide how much of the buffer is safe to flush to the client
 * immediately vs. must wait for the next token to disambiguate.
 */
function maxSentinelPrefixOverlap(tail: string): number {
  return Math.max(
    sentinelPrefixOverlapLength(tail, CRISIS_SENTINEL),
    sentinelPrefixOverlapLength(tail, ONBOARDING_COMPLETE_SENTINEL),
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum time to wait for the NEXT token before declaring the stream
 * timed out. Resets after every token received (it is a gap timeout, not
 * a total-stream timeout) — per TDD P1-013: "A timeout of 20 seconds with
 * no token produced causes the server to send event: error".
 */
export const TOKEN_GAP_TIMEOUT_MS = 20_000;

// ─── Token-gap timeout helper ──────────────────────────────────────────────────

export class TokenTimeoutError extends Error {
  constructor(message = 'No token received within the timeout window') {
    super(message);
    this.name = 'TokenTimeoutError';
  }
}

/**
 * Races a single promise (one gen.next() call) against a timer. Used to
 * enforce the 20-second no-token-produced rule independently for every
 * token, not just the first.
 */
export function withTokenTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TokenTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─── SSE frame writer ───────────────────────────────────────────────────────────

/**
 * Writes a single SSE frame. `id` becomes the frame's `id:` field, which
 * the browser/fetch client echoes back as Last-Event-ID on reconnect.
 */
export function writeSseEvent(
  res:   Response,
  event: 'token' | 'done' | 'error',
  data:  unknown,
  id?:   number,
): void {
  let frame = '';
  if (id !== undefined) frame += `id: ${id}\n`;
  frame += `event: ${event}\n`;
  frame += `data: ${JSON.stringify(data)}\n\n`;
  res.write(frame);
}

export function setSseHeaders(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx proxy buffering
  res.flushHeaders?.();
}

// ─── Background stream driver ──────────────────────────────────────────────────

export interface DriveStreamParams {
  session:        StreamSession;
  conversationId: string;
  userId:         string;
  /** Full message history INCLUDING the just-sent user message, oldest first. */
  contextMessages: Message[];
  userProfile:     UserProfileForOrchestration;
  /**
   * The plaintext of the user's just-sent message — used for emotion
   * detection (detectEmotion() runs on what the USER said, not on the AI's
   * reply). Optional for test convenience; when omitted, falls back to the
   * last role:'user' entry in contextMessages, then '' if none is found.
   */
  userMessageContent?: string;
  /** Pre-constructed for the requesting user — encryption key derivation is per-user. */
  encryptionService: EncryptionService;
  /** When the conversation was created — used to compute the 3-min onboarding
   *  threshold. Omit to skip the transition-offer check entirely. */
  conversationStartedAt?: Date;
  /** True if the user has already completed onboarding — skips the transition
   *  offer. Defaults to true (no offer) when omitted. */
  onboardingDone?: boolean;
  /** pg-boss instance — needed to enqueue extraction when the transition
   *  closes the conversation. Omit/null to skip enqueueing (e.g. queue not
   *  yet started). */
  jobQueue?: PgBoss | null;
}

/**
 * Runs the LLM stream to completion, pushing each token into the session
 * as it arrives, then persists the result. This function is NOT awaited
 * by the request handler — it represents the independent "AI response
 * job" the TDD describes, which keeps running even if the originating
 * HTTP connection drops (supporting Last-Event-ID reconnection).
 */
export async function driveOrchestrationStream(params: DriveStreamParams): Promise<void> {
  const {
    session, conversationId, userId, contextMessages,
    userProfile, encryptionService,
    conversationStartedAt, onboardingDone = true, jobQueue = null,
  } = params;

  const userMessageContent =
    params.userMessageContent
    ?? [...contextMessages].reverse().find((m) => m.role === 'user')?.content
    ?? '';

  // ── Onboarding transition thresholds ──────────────────────────────────────
  // Two thresholds, mutually exclusive (auto takes priority over offer):
  //   < 3 min  → normal onboarding, no transition block
  //   3–6 min  → offer the user a choice (showTransitionOffer)
  //   6 min+   → auto-wrap-up, no choice offered (autoTransition) — covers a
  //              user who declined (or never responded to) the 3-min offer
  // Uses >= rather than > — with an override of 0 (used by tests to force a
  // threshold immediately) a fast round-trip can leave elapsed time at
  // exactly 0ms, and `0 > 0` would wrongly skip it.
  const elapsed = conversationStartedAt !== undefined
    ? Date.now() - conversationStartedAt.getTime()
    : undefined;
  const autoTransition =
    !onboardingDone && elapsed !== undefined && elapsed >= onboardingAutoMs();
  const showTransitionOffer =
    !onboardingDone && !autoTransition &&
    elapsed !== undefined && elapsed >= onboardingOfferMs();

  let rawAccumulated = '';  // full LLM output, may contain a sentinel at end
  // Holds only the portion of the tail that could still be the start of an
  // in-progress sentinel match — see sentinelPrefixOverlapLength() below.
  let pendingBuffer  = '';

  try {
    const gen = aiOrchestrationService.stream({
      mode:        'chat',
      messages:    contextMessages,
      userProfile,
      // Pass the relevant transition flag so the prompt builder can inject
      // the right block — at most one of these is ever true.
      promptOpts: autoTransition
        ? { autoTransition: true }
        : showTransitionOffer
          ? { showTransitionOffer: true }
          : undefined,
    });

    // Pull tokens one at a time, racing each pull against the gap timeout.
    // This correctly resets the timeout window after every token, not just
    // the first — gen.next() is called fresh each iteration.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await withTokenTimeout(gen.next(), TOKEN_GAP_TIMEOUT_MS);
      if (result.done) break;

      const delta = result.value;
      rawAccumulated += delta;
      pendingBuffer  += delta;

      // ── Sentinel-aware flush ────────────────────────────────────────────────
      // Only forward the portion of the buffer that can't possibly be the
      // start of either sentinel — the rest is held back until we know
      // whether it's actually building toward one. For ordinary (non-crisis,
      // non-transition) responses this never withholds more than a few
      // characters, so streaming stays effectively real-time (unlike a naive
      // "always retain the last N chars" buffer, which would needlessly
      // merge/delay every short response).
      const overlap = maxSentinelPrefixOverlap(pendingBuffer);
      const safeLen = pendingBuffer.length - overlap;
      if (safeLen > 0) {
        const safe = pendingBuffer.slice(0, safeLen);
        pendingBuffer = pendingBuffer.slice(safeLen);
        session.pushToken(safe);
      }
    }

    // Flush whatever remains in the buffer, with EITHER sentinel stripped —
    // the leftover tail could end with the crisis sentinel, the onboarding
    // sentinel, or (per stripOnboardingSentinel's own "both at the end" case)
    // both. Stripping only one here would leak the other straight to the
    // live client, even though it's later stripped from the persisted text.
    const { text: bufferAfterCrisis, detected: crisisInBuffer }     = stripCrisisSentinel(pendingBuffer);
    const { text: cleanBuffer,       detected: onboardingInBuffer } = stripOnboardingSentinel(bufferAfterCrisis);
    if (cleanBuffer) session.pushToken(cleanBuffer);

    // ── Strip both sentinels from the full accumulated response ─────────────
    const { text: afterCrisis,      detected: crisisDetected }      = stripCrisisSentinel(rawAccumulated);
    const { text: cleanAccumulated, detected: onboardingComplete }  = stripOnboardingSentinel(afterCrisis);
    void onboardingInBuffer; // computed for symmetry/clarity; onboardingComplete (above) is authoritative

    if (crisisDetected || crisisInBuffer) {
      warn({
        event:           'crisis_flag',
        conversation_id: conversationId,
        user_id:         userId,
      });
    }

    // ── Persist the clean response ────────────────────────────────────────────
    // Emotion is detected from what the USER said, not from the AI's reply.
    const emotionTag = detectEmotion(userMessageContent);
    const { ciphertext, iv } = encryptionService.encrypt(cleanAccumulated);

    const [assistantMsg] = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(messages)
        .values({
          conversationId,
          userId,
          role:        'assistant',
          content:     ciphertext,
          contentIv:   iv,
          emotionTags: emotionTag,
        })
        .returning({ id: messages.id });

      await tx
        .update(conversations)
        .set({ messageCount: sql`${conversations.messageCount} + 1` })
        .where(eq(conversations.id, conversationId));

      return [inserted];
    });

    // Fire-and-forget — does not block finishing the session.
    // Uses cleanAccumulated (sentinel stripped) so the context cache
    // never contains the internal monitoring string.
    void appendToContextCache(conversationId, { role: 'assistant', content: cleanAccumulated });

    // ── Onboarding transition: close the conversation server-side ──────────
    // When the user confirmed "jump to chat", close the onboarding conversation
    // immediately so the extraction job runs and memory is built from the
    // onboarding exchange. The frontend receives onboarding_complete: true in
    // the done event and navigates to /chat.
    if (onboardingComplete) {
      warn({
        event:           'onboarding_transition',
        conversation_id: conversationId,
        user_id:         userId,
      });

      // Close the conversation and enqueue extraction — same logic as PATCH /:id close
      await db.transaction(async (tx) => {
        await tx
          .update(conversations)
          .set({ status: 'closed', endedAt: new Date() })
          .where(eq(conversations.id, conversationId));

        await tx
          .update(userContext)
          .set({ sessionCount: sql`${userContext.sessionCount} + 1` })
          .where(eq(userContext.userId, userId));
      });

      if (jobQueue) {
        await enqueueExtractionJob(jobQueue, { conversation_id: conversationId, user_id: userId });
      }
    }

    const doneMeta: DoneMeta = {
      messageId:   assistantMsg.id,
      emotionTags: emotionTag,
      ...(onboardingComplete ? { onboardingComplete: true } : {}),
    };
    session.finishDone(doneMeta);
  } catch (err) {
    // Mid-stream failure (LLMStreamError re-thrown by the orchestrator),
    // an LLMTimeoutError from the orchestrator/provider itself, or our own
    // token-gap timeout (TokenTimeoutError). Either way: the partial
    // response is intentionally NOT persisted (TDD P1-013).
    const code: ErrorMeta['code'] =
      err instanceof TokenTimeoutError || err instanceof LLMTimeoutError
        ? 'LLM_TIMEOUT'
        : 'LLM_STREAM_ERROR';

    session.finishError({ code });
  }
}

// ─── Attach an HTTP response to a session ──────────────────────────────────────

/**
 * Wires a live SSE response to a StreamSession:
 *   1. Replays every buffered token with id > fromEventId (handles both
 *      a fresh attach, where fromEventId=0 and nothing is buffered yet,
 *      and a Last-Event-ID reconnect, where some tokens were missed).
 *   2. If the session has already reached a terminal state, immediately
 *      sends that terminal event and ends the response.
 *   3. Otherwise subscribes to live 'token' / 'done' / 'error' events
 *      until a terminal event fires, then ends the response.
 *
 * On client disconnect (res 'close'), listeners are detached so this
 * specific dead response stops being written to — the session itself
 * keeps running regardless, allowing a subsequent reconnect to attach.
 */
export function attachToSession(
  res:          Response,
  session:      StreamSession,
  fromEventId:  number,
): void {
  for (const token of session.tokensAfter(fromEventId)) {
    writeSseEvent(res, 'token', { delta: token.delta }, token.id);
  }

  if (session.status === 'done' && session.doneMeta) {
    writeSseEvent(res, 'done', {
      message_id:   session.doneMeta.messageId,
      emotion_tags: session.doneMeta.emotionTags,
      ...(session.doneMeta.onboardingComplete ? { onboarding_complete: true } : {}),
    });
    res.end();
    return;
  }

  if (session.status === 'error' && session.errorMeta) {
    writeSseEvent(res, 'error', { code: session.errorMeta.code });
    res.end();
    return;
  }

  // Still in progress — subscribe for live updates.
  const onToken = (token: BufferedToken) => {
    writeSseEvent(res, 'token', { delta: token.delta }, token.id);
  };
  const onDone = (meta: DoneMeta) => {
    writeSseEvent(res, 'done', {
      message_id:   meta.messageId,
      emotion_tags: meta.emotionTags,
      ...(meta.onboardingComplete ? { onboarding_complete: true } : {}),
    });
    cleanup();
    res.end();
  };
  const onError = (meta: ErrorMeta) => {
    writeSseEvent(res, 'error', { code: meta.code });
    cleanup();
    res.end();
  };

  function cleanup(): void {
    session.off('token', onToken);
    session.off('done',  onDone);
    session.off('error', onError);
  }

  session.on('token', onToken);
  session.on('done',  onDone);
  session.on('error', onError);

  // Client disconnected — stop writing to this dead response. The
  // background driver and the session itself are unaffected, so a
  // reconnect can still attach and resume.
  res.on('close', cleanup);
}
