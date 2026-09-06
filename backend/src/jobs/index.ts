/**
 * src/jobs/index.ts
 *
 * pg-boss job queue — one worker:
 *
 *   inactivity_close — runs on a 5-minute cron, finds all conversations with
 *                       status="active" and no activity in the past 30
 *                       minutes, closes them automatically (P1-15
 *                       criterion 4).
 *
 * Memory extraction used to be a second pg-boss job here (memory_extraction,
 * enqueued fire-and-forget on conversation close, plus a reconcile_extraction
 * cron backstop). Both are gone — see src/jobs/extractionSweep.ts for why
 * and what replaced them (a status='closed'-driven atomic-claim sweep that
 * doesn't depend on pg-boss at all). inactivity_close no longer needs to
 * enqueue extraction itself either: closing a conversation (however it
 * happens) is enough — the sweep picks up any status='closed' row
 * unconditionally.
 */

import type PgBoss from 'pg-boss';
import type { Job } from 'pg-boss';
import { sql, eq, and } from 'drizzle-orm';
import { db }                   from '../db';
import { conversations, userContext } from '../db/schema';
import { log, logError }  from '../lib/logger';

// ─── Job names ────────────────────────────────────────────────────────────────

export const JOB_INACTIVITY_CLOSE = 'inactivity_close';

// ─── Constants ────────────────────────────────────────────────────────────────

const INACTIVITY_CRON = '*/5 * * * *';
export const INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Inactivity auto-close
// ─────────────────────────────────────────────────────────────────────────────

export async function runInactivityClose(_boss: PgBoss): Promise<void> {
  const cutoff = new Date(Date.now() - INACTIVITY_THRESHOLD_MS);

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

      // No extraction enqueue here anymore — status is now 'closed', which
      // is itself what the extraction sweep (extractionSweep.ts) looks for,
      // regardless of which path closed the conversation.
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
  await boss.createQueue(JOB_INACTIVITY_CLOSE);

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
    queues: [JOB_INACTIVITY_CLOSE],
    cron:   INACTIVITY_CRON,
  });
}
