/**
 * src/jobs/__tests__/enqueueExtractionJob.test.ts
 *
 * Regression test for the startup-race bug (see issue: "Memory extraction
 * job silently dropped on deploy-restart race").
 *
 * pg-boss's boss.send() does NOT throw when the target queue doesn't exist
 * yet in Postgres (e.g. a request lands before startJobQueue()'s
 * createQueue() has committed, right after a deploy/restart) — it resolves
 * with `null` and nothing is inserted. Previously enqueueExtractionJob()
 * treated any non-throwing send() as success and logged
 * 'extraction_job_enqueued' regardless, so the job loss was invisible: the
 * conversation stayed 'closed' forever and no memory was ever extracted,
 * with no error anywhere. This test locks in the fix: a null jobId must be
 * logged as a distinct failure, not celebrated as a success.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockLog      = jest.fn();
const mockWarn     = jest.fn();
const mockLogError = jest.fn();

jest.mock('../../lib/logger', () => ({
  log:      (...args: unknown[]) => mockLog(...args),
  warn:     (...args: unknown[]) => mockWarn(...args),
  logError: (...args: unknown[]) => mockLogError(...args),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import type PgBoss from 'pg-boss';
import { enqueueExtractionJob, JOB_MEMORY_EXTRACTION } from '../index';

// ── Helpers ────────────────────────────────────────────────────────────────────

const PAYLOAD = { conversation_id: 'conv-1', user_id: 'user-1' };

function makeFakeBoss(send: jest.Mock): PgBoss {
  return { send } as unknown as PgBoss;
}

beforeEach(() => jest.clearAllMocks());

// ── Tests ────────────────────────────────────────────────────────────────────

describe('enqueueExtractionJob', () => {
  it('logs extraction_job_enqueued (with the job id) when boss.send() succeeds', async () => {
    const send = jest.fn().mockResolvedValue('real-job-id-123');
    await enqueueExtractionJob(makeFakeBoss(send), PAYLOAD);

    expect(send).toHaveBeenCalledWith(
      JOB_MEMORY_EXTRACTION,
      PAYLOAD,
      expect.objectContaining({ retryLimit: 2, retryDelay: 30, retryBackoff: true }),
    );
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event:           'extraction_job_enqueued',
        conversation_id: PAYLOAD.conversation_id,
        job_id:          'real-job-id-123',
      }),
    );
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('logs a distinct failure — not extraction_job_enqueued — when boss.send() resolves null', async () => {
    // This is what pg-boss actually returns when the queue row doesn't
    // exist yet (see attorney.js / manager.js) — it does not throw.
    const send = jest.fn().mockResolvedValue(null);
    await enqueueExtractionJob(makeFakeBoss(send), PAYLOAD);

    expect(mockLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'extraction_job_enqueued' }),
    );
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({
        event:           'extraction_enqueue_returned_null',
        conversation_id: PAYLOAD.conversation_id,
        user_id:         PAYLOAD.user_id,
      }),
    );
  });

  it('logs extraction_enqueue_failed when boss.send() throws', async () => {
    const send = jest.fn().mockRejectedValue(new Error('connection reset'));
    await enqueueExtractionJob(makeFakeBoss(send), PAYLOAD);

    expect(mockLog).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({
        event:           'extraction_enqueue_failed',
        conversation_id: PAYLOAD.conversation_id,
        error:           'connection reset',
      }),
    );
  });
});
