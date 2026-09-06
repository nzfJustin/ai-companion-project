/**
 * src/jobs/extractionSweep.ts
 *
 * Replaces the previous pg-boss-based memory_extraction job + reconciler.
 *
 * Why: the pg-boss approach depended on (a) a fire-and-forget enqueue call
 * at close time succeeding, and (b) a reconciler re-enqueue being correctly
 * deduplicated via pg-boss's singletonKey — which turned out to require
 * declaring the queue with policy: 'singleton' (or a singletonSeconds
 * window) to actually take effect. It didn't have either, so the
 * reconciler produced duplicate memories instead of preventing them, while
 * the underlying "was the enqueue lost" problem was still unsolved.
 *
 * This replaces both with one mechanism: a conversation's own
 * status='closed' IS the trigger — no separate message to lose. A sweep
 * tick runs every SWEEP_INTERVAL_MS and atomically claims closed (or
 * stuck-in-progress) conversations via a single
 *   UPDATE ... WHERE status='closed' ... RETURNING
 * Postgres's row locking on that statement makes it structurally
 * impossible for two ticks (or two process replicas) to both claim the
 * same conversation — this isn't a policy that can be misconfigured, it's
 * how UPDATE works. That's what actually prevents duplicates.
 *
 * A conversation whose extraction crashed mid-run (process killed,
 * uncaught exception before the status update) would otherwise be stuck
 * at 'extracting' forever — the claim query also picks up any
 * 'extracting' row whose extraction_claimed_at is older than
 * STUCK_CLAIM_MS, so it gets retried automatically instead of orphaned.
 */

import { eq, sql } from 'drizzle-orm';
import { db }        from '../db';
import { conversations } from '../db/schema';
import { runExtractionJob } from './extractionJob';
import { log, warn, logError } from '../lib/logger';

// ─── Constants ────────────────────────────────────────────────────────────────

export const SWEEP_INTERVAL_MS      = 20_000;      // 20 seconds
export const STUCK_CLAIM_MS         = 5 * 60_000;   // 5 minutes
export const MAX_EXTRACTION_ATTEMPTS = 3;
const BATCH_SIZE = 10;

interface ClaimedConversation {
  id:                  string;
  userId:              string;
  extractionAttempts:  number;
}

// ─── Claim ────────────────────────────────────────────────────────────────────

/**
 * Atomically claims up to BATCH_SIZE eligible conversations, flipping them
 * to status='extracting'. Uses FOR UPDATE SKIP LOCKED so concurrent ticks
 * (or replicas) never contend on the same rows — each just takes whatever
 * is still unclaimed.
 */
async function claimBatch(): Promise<ClaimedConversation[]> {
  const stuckCutoff = new Date(Date.now() - STUCK_CLAIM_MS);

  const result = await db.execute(sql`
    UPDATE conversations
    SET    status = 'extracting', extraction_claimed_at = NOW()
    WHERE  id IN (
      SELECT id
      FROM   conversations
      WHERE  (
               status = 'closed'
               OR (status = 'extracting' AND extraction_claimed_at < ${stuckCutoff})
             )
      AND    extraction_attempts < ${MAX_EXTRACTION_ATTEMPTS}
      ORDER BY ended_at ASC NULLS LAST
      LIMIT  ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, user_id AS "userId", extraction_attempts AS "extractionAttempts"
  `);

  return result.rows as unknown as ClaimedConversation[];
}

// ─── Process one claimed conversation ────────────────────────────────────────

async function processClaimed(row: ClaimedConversation): Promise<void> {
  const attempt = row.extractionAttempts + 1;

  const result = await runExtractionJob({
    conversationId: row.id,
    userId:         row.userId,
    attempt,
  });

  if (result.success) {
    // runExtractionJob() already moved status to 'summarized' on success.
    log({ event: 'extraction_sweep_success', conversation_id: row.id, attempt });
    return;
  }

  const isFinalAttempt = attempt >= MAX_EXTRACTION_ATTEMPTS;

  if (isFinalAttempt) {
    await db
      .update(conversations)
      .set({ status: 'extraction_failed', extractionAttempts: attempt })
      .where(eq(conversations.id, row.id));
    warn({
      event:           'extraction_sweep_failed_final',
      conversation_id: row.id,
      attempt,
      reason:          result.reason,
    });
  } else {
    // Back to 'closed' — the tick interval itself acts as a simple retry
    // backoff (next attempt happens on a later sweep tick, not immediately).
    await db
      .update(conversations)
      .set({ status: 'closed', extractionAttempts: attempt })
      .where(eq(conversations.id, row.id));
    warn({
      event:           'extraction_sweep_retry',
      conversation_id: row.id,
      attempt,
      reason:          result.reason,
    });
  }
}

// ─── One sweep tick ───────────────────────────────────────────────────────────

export async function runExtractionSweepTick(): Promise<void> {
  let claimed: ClaimedConversation[];
  try {
    claimed = await claimBatch();
  } catch (err) {
    logError({
      event: 'extraction_sweep_claim_error',
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (claimed.length === 0) return;

  log({ event: 'extraction_sweep_claimed', count: claimed.length });

  for (const row of claimed) {
    try {
      await processClaimed(row);
    } catch (err) {
      logError({
        event:           'extraction_sweep_process_error',
        conversation_id: row.id,
        error:           err instanceof Error ? err.message : String(err),
      });
      // Best-effort: put it back to 'closed' (without counting an attempt —
      // this was an unexpected throw in the sweep itself, not a real
      // extraction failure) so it isn't left stranded at 'extracting'.
      await db
        .update(conversations)
        .set({ status: 'closed' })
        .where(eq(conversations.id, row.id))
        .catch(() => {});
    }
  }
}

// ─── Interval control — call once at startup / shutdown ─────────────────────

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startExtractionSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { void runExtractionSweepTick(); }, SWEEP_INTERVAL_MS);
  // Don't let this timer alone keep the process alive during shutdown.
  sweepTimer.unref?.();
  log({ event: 'extraction_sweep_started', interval_ms: SWEEP_INTERVAL_MS });
}

export function stopExtractionSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
