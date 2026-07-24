/**
 * src/jobs/extractionJob.ts
 *
 * Memory extraction job — runs after a conversation is closed (TDD P1-016
 * / sprint P1-19). Calls AIOrchestrationService in non-streaming mode with
 * the full conversation history, validates the JSON response against
 * MemoryExtractionSchema, and writes the results to two tables:
 *   - memories        (encrypted summary, key events, emotion tags)
 *   - emotional_snapshots (daily emotion scores for trend analysis)
 *
 * On success: sets conversation.status = "summarized".
 * On failure: sets conversation.status = "extraction_failed" and logs the
 *   reason — the conversation is never left in a broken limbo state.
 *
 * ─── Retry policy ────────────────────────────────────────────────────────────
 * The job is driven by pg-boss (see src/jobs/index.ts), which handles
 * scheduling and retry bookkeeping. Inside a single job execution this
 * module runs the extraction once; the outer pg-boss retry schedule is
 * configured to retry up to 3 total attempts with exponential backoff.
 * On the final (3rd) failed attempt the job emits:
 *   { event: "extraction_job", status: "failed", attempt: 3 }
 * and sets the conversation to "extraction_failed".
 *
 * ─── Content security ────────────────────────────────────────────────────────
 * Message content is decrypted for the LLM call (necessary for extraction),
 * then the resulting memory summary is re-encrypted before storage via
 * EncryptionService. The decrypted content is never logged.
 */

import { eq, desc }     from 'drizzle-orm';
import { db }            from '../db';
import {
  conversations,
  messages,
  memories,
  emotionalSnapshots,
} from '../db/schema';
import { EncryptionService }       from '../services/EncryptionService';
import { aiOrchestrationService }  from '../ai/instance';
import { MemoryExtractionSchema }  from '../ai/schemas/extraction';
import type { MemoryExtractionResult } from '../ai/schemas/extraction';
import { log, warn, logError }    from '../lib/logger';
import { updateStreak, getUserTimezone } from '../services/streakService';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExtractionJobPayload {
  conversationId: string;
  userId:         string;
  /** 1-indexed attempt number supplied by pg-boss */
  attempt:        number;
}

export interface ExtractionJobResult {
  success:  boolean;
  memoryId?: string;
  reason?:  'llm_fallback' | 'parse_error' | 'schema_invalid' | 'db_error';
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_CONTEXT_MSGS = 30; // include more history than chat to capture the full arc

// ─── runExtractionJob ─────────────────────────────────────────────────────────

/**
 * Performs a single extraction attempt for the given conversation.
 * The caller (pg-boss worker in src/jobs/index.ts) is responsible for
 * retrying on failure and marking the conversation status.
 */
export async function runExtractionJob(
  payload: ExtractionJobPayload,
): Promise<ExtractionJobResult> {
  const { conversationId, userId, attempt } = payload;

  log({
    event:           'extraction_job_start',
    conversation_id: conversationId,
    user_id:         userId,
    attempt,
  });

  // ── 1. Fetch + decrypt conversation messages ───────────────────────────────
  const enc = new EncryptionService(userId);
  let decryptedMessages: Array<{ role: string; content: string }> = [];

  try {
    const rawMessages = await db.query.messages.findMany({
      where:   eq(messages.conversationId, conversationId),
      orderBy: [desc(messages.createdAt)],
      limit:   MAX_CONTEXT_MSGS,
    });

    decryptedMessages = rawMessages
      .reverse() // oldest first
      .map((m) => ({
        role:    m.role as 'user' | 'assistant',
        content: enc.decrypt(m.content, m.contentIv),
      }));
  } catch (err) {
    logError({
      event:           'extraction_job_fetch_failed',
      conversation_id: conversationId,
      attempt,
      error:           err instanceof Error ? err.message : String(err),
    });
    return { success: false, reason: 'db_error' };
  }

  if (decryptedMessages.length === 0) {
    warn({
      event:           'extraction_job_empty_conversation',
      conversation_id: conversationId,
    });
    // An empty conversation produces no useful memory — mark as summarized
    // with no memory written rather than failing. This avoids infinite retries
    // on genuinely empty conversations.
    await markConversation(conversationId, 'summarized');
    return { success: true };
  }

  // ── 2. Call AIOrchestrationService for extraction ─────────────────────────
  let rawJson: string;
  try {
    const response = await aiOrchestrationService.complete({
      mode:     'extraction',
      messages: decryptedMessages as Array<{ role: 'user' | 'assistant'; content: string }>,
      userProfile: {
        // Extraction prompt is static and ignores these fields, but the
        // type requires them — pass safe neutral defaults.
        displayName:    '',
        timezone:       'UTC',
        commStyle:      'warm',
        onboardingDone: true,
        contextSummary: null,
      },
    });

    if (response.isFallback) {
      warn({
        event:           'extraction_job_llm_fallback',
        conversation_id: conversationId,
        attempt,
      });
      return { success: false, reason: 'llm_fallback' };
    }

    rawJson = response.content;
  } catch (err) {
    logError({
      event:           'extraction_job_llm_error',
      conversation_id: conversationId,
      attempt,
      error:           err instanceof Error ? err.message : String(err),
    });
    return { success: false, reason: 'llm_fallback' };
  }

  // ── 3. Parse + validate JSON ──────────────────────────────────────────────
  let parsed: unknown;
  try {
    const clean = rawJson
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    parsed = JSON.parse(clean);
  } catch {
    warn({
      event:           'extraction_schema_error',
      conversation_id: conversationId,
      attempt,
      reason:          'json_parse_failed',
    });
    return { success: false, reason: 'parse_error' };
  }

  const validation = MemoryExtractionSchema.safeParse(parsed);

  if (!validation.success) {
    warn({
      event:            'extraction_schema_error',
      conversation_id:  conversationId,
      attempt,
      validation_errors: validation.error.flatten(),
      // Explicitly surface memory_level to make out-of-range values easy to spot
      memory_level:     String((parsed as Record<string, unknown>)?.memory_level),
    });
    return { success: false, reason: 'schema_invalid' };
  }

  const result: MemoryExtractionResult = validation.data;

  // ── 4. Write to DB (memories + emotional_snapshots + update conversation) ─
  let memoryId: string;
  try {
    const { ciphertext: summaryCiphertext, iv: summaryIv } = enc.encrypt(result.summary);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Fetch user timezone before opening the transaction (non-blocking fallback to UTC)
    const userTimezone = await getUserTimezone(db, userId);

    await db.transaction(async (tx) => {
      // Insert memory
      const [memory] = await tx
        .insert(memories)
        .values({
          userId,
          conversationId,
          title:           result.title,
          summary:         summaryCiphertext,
          summaryIv,
          keyEvents:       result.key_events,
          emotionalTags:   [result.dominant_emotion],
          dominantEmotion: result.dominant_emotion,
          level:           result.memory_level,
          periodStart:     today,
          periodEnd:       today,
        })
        .returning({ id: memories.id });

      memoryId = memory.id;

      // Insert emotional snapshot
      await tx
        .insert(emotionalSnapshots)
        .values({
          userId,
          conversationId,
          snapshotDate:    today,
          dominantEmotion: result.dominant_emotion,
          emotionScores:   result.emotion_scores,
        })
        .returning();

      // Mark conversation as summarized
      await tx
        .update(conversations)
        .set({ status: 'summarized' })
        .where(eq(conversations.id, conversationId));

      // ── T-008: Update streak (atomic with memory write) ───────────────────
      // If the streak update fails the whole transaction rolls back — memories
      // and emotional_snapshots are never orphaned from the streak counter.
      await updateStreak(tx, userId, userTimezone);
    });

    log({
      event:           'extraction_job',
      status:          'success',
      conversation_id: conversationId,
      user_id:         userId,
      memory_id:       memoryId!,
      memory_level:    result.memory_level,
      dominant_emotion: result.dominant_emotion,
      attempt,
    });

    return { success: true, memoryId: memoryId! };
  } catch (err) {
    logError({
      event:           'extraction_job_db_error',
      conversation_id: conversationId,
      attempt,
      error:           err instanceof Error ? err.message : String(err),
    });
    return { success: false, reason: 'db_error' };
  }
}

// ─── Status helpers ────────────────────────────────────────────────────────────

export async function markConversation(
  conversationId: string,
  status: 'summarized' | 'extraction_failed',
): Promise<void> {
  try {
    await db
      .update(conversations)
      .set({ status })
      .where(eq(conversations.id, conversationId));
  } catch (err) {
    logError({
      event:           'extraction_status_update_failed',
      conversation_id: conversationId,
      target_status:   status,
      error:           err instanceof Error ? err.message : String(err),
    });
  }
}
