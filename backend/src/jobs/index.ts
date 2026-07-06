/**
 * src/jobs/index.ts
 *
 * pg-boss job queue configuration (TDD P1-016 / sprint P1-19).
 *
 * pg-boss persists jobs in a Postgres schema alongside the application
 * tables, giving us durable queuing, scheduled retries, and dead-letter
 * tracking without an external queue service.
 *
 * Retry policy:
 *   The memory_extraction job retries up to 3 total attempts with exponential
 *   backoff (30 s, 120 s). On the third failure pg-boss routes the job to its
 *   dead-letter archive and the conversation status is set to
 *   "extraction_failed" -- the app is never in a broken state.
 */

import { PgBoss } from 'pg-boss';
import type { Job } from 'pg-boss';
import { runExtractionJob, markConversation } from './extractionJob';
import { log, warn, logError } from '../lib/logger';

export const JOB_MEMORY_EXTRACTION = 'memory_extraction';

const MAX_ATTEMPTS = 3;

export interface ExtractionJobEnqueuePayload {
  conversation_id: string;
  user_id:         string;
}

/**
 * Enqueues a memory extraction job. Safe to call fire-and-forget -- all
 * errors are logged, never re-thrown.
 */
export async function enqueueExtractionJob(
  boss:    PgBoss,
  payload: ExtractionJobEnqueuePayload,
): Promise<void> {
  try {
    await boss.send(JOB_MEMORY_EXTRACTION, payload, {
      retryLimit:   MAX_ATTEMPTS - 1,
      retryDelay:   30,
      retryBackoff: true,
    });
    log({ event: 'extraction_job_enqueued', conversation_id: payload.conversation_id, user_id: payload.user_id });
  } catch (err) {
    logError({ event: 'extraction_enqueue_failed', conversation_id: payload.conversation_id, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Registers the memory_extraction worker and starts the pg-boss scheduler.
 * Call once at application startup after boss.start().
 */
export async function startJobQueue(boss: PgBoss): Promise<void> {
  await boss.work<ExtractionJobEnqueuePayload>(
    JOB_MEMORY_EXTRACTION,
    { batchSize: 5 },
    async (jobs: Job<ExtractionJobEnqueuePayload>[]) => {
      await Promise.all(jobs.map(async (job) => {
        const { conversation_id, user_id } = job.data;
        const attempt = ((job as Job<ExtractionJobEnqueuePayload> & { retryCount?: number }).retryCount ?? 0) + 1;

        const result = await runExtractionJob({ conversationId: conversation_id, userId: user_id, attempt });

        if (!result.success) {
          const isFinalAttempt = attempt >= MAX_ATTEMPTS;

          if (isFinalAttempt) {
            // TDD-required log: { event: "extraction_job", status: "failed", attempt: 3 }
            warn({ event: 'extraction_job', status: 'failed', conversation_id, attempt, reason: result.reason });
            await markConversation(conversation_id, 'extraction_failed');
          } else {
            warn({ event: 'extraction_job_retry', conversation_id, attempt, reason: result.reason });
            throw new Error(`Extraction failed on attempt ${attempt}: ${result.reason}`);
          }
        }
      }));
    },
  );

  log({ event: 'job_queue_started', queue: JOB_MEMORY_EXTRACTION });
}
