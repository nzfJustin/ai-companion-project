/**
 * src/jobs/index.ts
 *
 * pg-boss job queue — three workers:
 *
 *   memory_extraction   — triggered on explicit PATCH /conversations/:id close,
 *                        runs the LLM extraction pipeline (P1-19)
 *
 *   inactivity_close    — runs on a 5-minute cron, finds all conversations with
 *                        status="active" and no activity in the past 30 minutes,
 *                        closes them automatically (P1-15 criterion 4)
 *
 *   reconcile_extraction — runs on a 2-minute cron. Backstop for the case
 *                        where a conversation reached status="closed" but
 *                        memory_extraction never actually ran for it — e.g.
 *                        the fire-and-forget enqueue call at close time was
 *                        lost to a deploy cutover, a transient DB blip, or
 *                        any other cause we haven't seen yet. Re-enqueues
 *                        extraction for any such conversation so "closing a
 *                        conversation eventually produces a memory" holds
 *                        even when the primary enqueue path fails silently,
 *                        not just when it works.
 */

import type PgBoss from 'pg-boss';
import type { Job } from 'pg-boss';
import { sql, eq, and, lt } from 'drizzle-orm';
import { db }                   from '../db';
import { conversations, userContext } from '../db/schema';
import { runExtractionJob, markConversation } from './extractionJob';
import { log, warn, logError }  from '../lib/logger';

// ─── Job names ────────────────────────────────────────────────────────────────

export const JOB_MEMORY_EXTRACTION    = 'memory_extraction';
export const JOB_INACTIVITY_CLOSE     = 'inactivity_close';
export const JOB_RECONCILE_EXTRACTION = 'reconcile_extraction';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_EXTRACTION_ATTEMPTS = 3;
const INACTIVITY_CRON = '*/5 * * * *';
export const INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

const RECONCILE_CRON = '*/2 * * * *';
// A normal extraction takes ~15-20s end to end (measured). 3 minutes gives
// a wide safety margin so this never races a legitimately still-running
// extraction and double-enqueues it.
export const RECONCILE_GRACE_MS = 3 * 60 * 1000; // 3 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Memory extraction job
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractionJobEnqueuePayload {
  conversation_id: string;
  user_id:         string;
}

export async function enqueueExtractionJob(
  boss:    PgBoss,
  payload: ExtractionJobEnqueuePayload,
): Promise<void> {
  try {
    const jobId = await boss.send(JOB_MEMORY_EXTRACTION, payload, {
      retryLimit:   MAX_EXTRACTION_ATTEMPTS - 1,
      retryDelay:   30,
      retryBackoff: true,
      // At most one outstanding memory_extraction job per conversation at a
      // time. Without this, runReconcileExtraction() re-enqueuing a
      // conversation that's still status='closed' only because its
      // original job is legitimately slow (not lost) would race that job
      // and could produce two memories for the same conversation. With it,
      // the second boss.send() for the same conversation_id is a safe
      // no-op while the first is still outstanding.
      singletonKey: payload.conversation_id,
    });

    // boss.send() resolves null (rather than throwing) in two legitimate-
    // but-very-different cases: (1) the target queue didn't exist yet in
    // Postgres — e.g. a request landing before startJobQueue()'s
    // createQueue() has committed — and nothing was inserted, or (2) the
    // singletonKey dedup above found a still-outstanding job for this
    // conversation and correctly skipped a duplicate insert. (1) used to
    // look identical to success (this log line fired regardless) and the
    // conversation would silently never get a memory; (2) is expected and
    // harmless — mainly seen when runReconcileExtraction() re-enqueues a
    // conversation whose original job just hasn't finished yet. Can't
    // distinguish the two from the return value alone, so log both as a
    // visible warning rather than silence — worst case or a case-1 job is
    // now impossible to miss, at the cost of an occasional benign log line
    // for case 2.
    if (!jobId) {
      logError({
        event:           'extraction_enqueue_returned_null',
        conversation_id: payload.conversation_id,
        user_id:         payload.user_id,
        note:             'boss.send() resolved with no job id — either the queue was not ready, or a job for this conversation was already outstanding (singletonKey dedup)',
      });
      return;
    }

    log({
      event:           'extraction_job_enqueued',
      conversation_id: payload.conversation_id,
      user_id:         payload.user_id,
      job_id:          jobId,
    });
  } catch (err) {
    logError({
      event:           'extraction_enqueue_failed',
      conversation_id: payload.conversation_id,
      error:           err instanceof Error ? err.message : String(err),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inactivity auto-close
// ─────────────────────────────────────────────────────────────────────────────

export async function runInactivityClose(boss: PgBoss): Promise<void> {
  const cutoff = new Date(Date.now() - INACTIVITY_THRESHOLD_MS);

  // Late-bound so Jest can mock enqueueExtractionJob in unit tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { enqueueExtractionJob: enqueue } = require('./index') as { enqueueExtractionJob: typeof enqueueExtractionJob };

  // Note: conversations has no deleted_at column (only users/memories/
  // auth_sessions do) — a prior version of this query filtered on
  // `deleted_at IS NULL` here, which does not exist on this table. That
  // made every single run of this query throw "column deleted_at does not
  // exist" — pg-boss treats the rejection as a failed job run rather than
  // crashing the process, so it failed silently on every 5-minute tick:
  // inactivity auto-close has never actually run in production. Removed.
  const result = await db.execute(sql`
    SELECT id, user_id
    FROM   conversations
    WHERE  status = 'active'
    AND    (
      (
        SELECT MAX(created_at)
        FROM   messages
        WHERE  conversation_id = conversations.id
      ) < ${cutoff}
      OR
      (
        NOT EXISTS (
          SELECT 1 FROM messages WHERE conversation_id = conversations.id
        )
        AND started_at < ${cutoff}
      )
    )
  `);

  const stale = result.rows as Array<{ id: string; user_id: string }>;

  if (stale.length === 0) {
    log({ event: 'inactivity_close_scan', closed_count: 0, checked_count: 0 });
    return;
  }

  let closedCount = 0;

  for (const row of stale) {
    const { id: conversationId, user_id: userId } = row;

    try {
      const [updated] = await db
        .update(conversations)
        .set({ status: 'closed', endedAt: new Date() })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.status, 'active'),
          ),
        )
        .returning({ id: conversations.id });

      if (!updated) {
        log({ event: 'inactivity_close_skipped', conversation_id: conversationId });
        continue;
      }

      // Increment session_count — same as explicit PATCH close (T-006).
      // Kept outside the UPDATE above to avoid coupling the race-guard
      // returning() clause; a failed increment here is non-fatal and logged.
      await db
        .update(userContext)
        .set({ sessionCount: sql`${userContext.sessionCount} + 1` })
        .where(eq(userContext.userId, userId))
        .catch((err: unknown) => {
          logError({
            event:           'inactivity_close_session_count_error',
            conversation_id: conversationId,
            error:           err instanceof Error ? err.message : String(err),
          });
        });

      await enqueue(boss, {
        conversation_id: conversationId,
        user_id:         userId,
      });

      closedCount++;
      log({ event: 'inactivity_close', conversation_id: conversationId, user_id: userId });
    } catch (err) {
      logError({
        event:           'inactivity_close_error',
        conversation_id: conversationId,
        error:           err instanceof Error ? err.message : String(err),
      });
    }
  }

  log({
    event:         'inactivity_close_scan',
    closed_count:  closedCount,
    checked_count: stale.length,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction reconciliation — backstop for a lost enqueue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds conversations that have been status='closed' for longer than
 * RECONCILE_GRACE_MS and re-enqueues extraction for them.
 *
 * runExtractionJob() always moves a conversation off 'closed' when it
 * actually runs — to 'summarized' on success, or 'extraction_failed' after
 * MAX_EXTRACTION_ATTEMPTS failed attempts (see extractionJob.ts). So a
 * conversation still sitting at 'closed' past the grace window means
 * extraction never ran for it at all — the enqueue call at close time was
 * lost somewhere (deploy cutover, a transient DB blip, or anything else),
 * not that it's failing and retrying. This is the backstop that makes
 * "closing a conversation eventually produces a memory" hold regardless of
 * why any single enqueue attempt failed.
 *
 * Safe against re-enqueuing a conversation whose original job is merely
 * slow (not lost): enqueueExtractionJob() sets singletonKey to the
 * conversation id, so a second send() while the first job is still
 * outstanding is a harmless no-op, not a duplicate run.
 */
export async function runReconcileExtraction(boss: PgBoss): Promise<void> {
  const cutoff = new Date(Date.now() - RECONCILE_GRACE_MS);

  // Late-bound so Jest can mock enqueueExtractionJob in unit tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { enqueueExtractionJob: enqueue } = require('./index') as { enqueueExtractionJob: typeof enqueueExtractionJob };

  const stuck = await db
    .select({ id: conversations.id, userId: conversations.userId })
    .from(conversations)
    .where(
      and(
        eq(conversations.status, 'closed'),
        lt(conversations.endedAt, cutoff),
      ),
    );

  if (stuck.length === 0) {
    log({ event: 'reconcile_extraction_scan', reenqueued_count: 0, checked_count: 0 });
    return;
  }

  for (const row of stuck) {
    try {
      warn({
        event:           'reconcile_extraction_reenqueue',
        conversation_id: row.id,
        user_id:         row.userId,
        note:            'conversation past status=closed grace window with no extraction result — re-enqueuing',
      });
      await enqueue(boss, { conversation_id: row.id, user_id: row.userId });
    } catch (err) {
      logError({
        event:           'reconcile_extraction_error',
        conversation_id: row.id,
        error:           err instanceof Error ? err.message : String(err),
      });
    }
  }

  log({
    event:            'reconcile_extraction_scan',
    reenqueued_count: stuck.length,
    checked_count:    stuck.length,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// startJobQueue — call once at startup
// ─────────────────────────────────────────────────────────────────────────────



export async function startJobQueue(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_MEMORY_EXTRACTION);
  await boss.createQueue(JOB_INACTIVITY_CLOSE);
  await boss.createQueue(JOB_RECONCILE_EXTRACTION);
  await boss.work<ExtractionJobEnqueuePayload>(
    JOB_MEMORY_EXTRACTION,
    { batchSize: 5 },
    async (jobs: Job<ExtractionJobEnqueuePayload>[]) => {
      await Promise.all(jobs.map(async (job) => {
        const { conversation_id, user_id } = job.data;
        const attempt = ((job as Job<ExtractionJobEnqueuePayload> & { retryCount?: number }).retryCount ?? 0) + 1;

        const result = await runExtractionJob({
          conversationId: conversation_id,
          userId:         user_id,
          attempt,
        });

        if (!result.success) {
          const isFinalAttempt = attempt >= MAX_EXTRACTION_ATTEMPTS;

          if (isFinalAttempt) {
            warn({
              event:           'extraction_job',
              status:          'failed',
              conversation_id,
              attempt,
              reason:          result.reason,
            });
            await markConversation(conversation_id, 'extraction_failed');
          } else {
            warn({
              event:           'extraction_job_retry',
              conversation_id,
              attempt,
              reason:          result.reason,
            });
            throw new Error(`Extraction failed on attempt ${attempt}: ${result.reason}`);
          }
        }
      }));
    },
  );

  await boss.schedule(
    JOB_INACTIVITY_CLOSE,
    INACTIVITY_CRON,
    {},
    { tz: 'UTC' },
  );

  await boss.work(
    JOB_INACTIVITY_CLOSE,
    { batchSize: 1 },
    async (_jobs: Job[]) => {
      await runInactivityClose(boss);
    },
  );

  await boss.schedule(
    JOB_RECONCILE_EXTRACTION,
    RECONCILE_CRON,
    {},
    { tz: 'UTC' },
  );

  await boss.work(
    JOB_RECONCILE_EXTRACTION,
    { batchSize: 1 },
    async (_jobs: Job[]) => {
      await runReconcileExtraction(boss);
    },
  );

  log({
    event:  'job_queue_started',
    queues: [JOB_MEMORY_EXTRACTION, JOB_INACTIVITY_CLOSE, JOB_RECONCILE_EXTRACTION],
    cron:   INACTIVITY_CRON,
    reconcile_cron: RECONCILE_CRON,
  });
}
