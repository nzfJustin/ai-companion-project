/**
 * src/jobs/index.ts
 *
 * pg-boss job queue — two workers:
 *
 *   memory_extraction  — triggered on explicit PATCH /conversations/:id close,
 *                        runs the LLM extraction pipeline (P1-19)
 *
 *   inactivity_close   — runs on a 5-minute cron, finds all conversations with
 *                        status="active" and no activity in the past 30 minutes,
 *                        closes them automatically (P1-15 criterion 4)
 */

import type { PgBoss, Job } from 'pg-boss';
import { sql, eq, and } from 'drizzle-orm';
import { db }                   from '../db';
import { conversations }        from '../db/schema';
import { runExtractionJob, markConversation } from './extractionJob';
import { log, warn, logError }  from '../lib/logger';

// ─── Job names ────────────────────────────────────────────────────────────────

export const JOB_MEMORY_EXTRACTION = 'memory_extraction';
export const JOB_INACTIVITY_CLOSE  = 'inactivity_close';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_EXTRACTION_ATTEMPTS = 3;
const INACTIVITY_CRON = '*/5 * * * *';
export const INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

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
    await boss.send(JOB_MEMORY_EXTRACTION, payload, {
      retryLimit:   MAX_EXTRACTION_ATTEMPTS - 1,
      retryDelay:   30,
      retryBackoff: true,
    });
    log({
      event:           'extraction_job_enqueued',
      conversation_id: payload.conversation_id,
      user_id:         payload.user_id,
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

  const result = await db.execute(sql`
    SELECT id, user_id
    FROM   conversations
    WHERE  status = 'active'
    AND    deleted_at IS NULL
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
// startJobQueue — call once at startup
// ─────────────────────────────────────────────────────────────────────────────

export async function startJobQueue(boss: PgBoss): Promise<void> {
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

  log({
    event:  'job_queue_started',
    queues: [JOB_MEMORY_EXTRACTION, JOB_INACTIVITY_CLOSE],
    cron:   INACTIVITY_CRON,
  });
}
