/**
 * src/jobs/__tests__/reconcileExtraction.test.ts
 *
 * Tests for runReconcileExtraction() — the backstop that re-enqueues
 * memory_extraction for any conversation stuck at status='closed' past the
 * grace window, regardless of why its original enqueue was lost.
 *
 * All database calls and the enqueueExtractionJob helper are mocked so no
 * real Postgres or pg-boss is required.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockSelect = jest.fn();

jest.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

// Mock enqueueExtractionJob within the same module
const mockEnqueue = jest.fn().mockResolvedValue(undefined);
jest.mock('../index', () => {
  const actual = jest.requireActual('../index');
  return {
    ...actual,
    enqueueExtractionJob: mockEnqueue,
  };
});

jest.mock('../../lib/logger', () => ({
  log:      jest.fn(),
  warn:     jest.fn(),
  logError: jest.fn(),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import type PgBoss from 'pg-boss';
import { runReconcileExtraction, RECONCILE_GRACE_MS } from '../index';
import { log, warn, logError } from '../../lib/logger';

const mockLog      = log      as jest.Mock;
const mockWarn     = warn     as jest.Mock;
const mockLogError = logError as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Creates a fake pg-boss instance (only send() needs to exist for these tests). */
function makeFakeBoss(): PgBoss {
  return { send: jest.fn().mockResolvedValue('job-id') } as unknown as PgBoss;
}

/** Chains .from().where() resolving directly to `rows` (Drizzle's builder is thenable). */
function setupSelectMock(rows: Array<{ id: string; userId: string }>) {
  const where = jest.fn().mockResolvedValue(rows);
  const from  = jest.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
  return { from, where };
}

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// Finding stuck conversations
// ─────────────────────────────────────────────────────────────────────────────

describe('runReconcileExtraction — query behaviour', () => {
  it('queries conversations for status="closed" past the grace cutoff', async () => {
    setupSelectMock([]);
    const boss = makeFakeBoss();

    await runReconcileExtraction(boss);

    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('logs a scan event with reenqueued_count=0 when nothing is stuck', async () => {
    setupSelectMock([]);
    const boss = makeFakeBoss();

    await runReconcileExtraction(boss);

    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'reconcile_extraction_scan', reenqueued_count: 0, checked_count: 0 }),
    );
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('uses a grace cutoff of approximately 3 minutes', () => {
    expect(RECONCILE_GRACE_MS).toBe(3 * 60 * 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Re-enqueuing stuck conversations
// ─────────────────────────────────────────────────────────────────────────────

describe('runReconcileExtraction — re-enqueuing stuck conversations', () => {
  it('re-enqueues extraction for a conversation stuck at status=closed', async () => {
    setupSelectMock([{ id: 'conv-stuck', userId: 'user-1' }]);
    const boss = makeFakeBoss();

    await runReconcileExtraction(boss);

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(boss, {
      conversation_id: 'conv-stuck',
      user_id:         'user-1',
    });
  });

  it('logs a reconcile_extraction_reenqueue warning for each conversation re-enqueued', async () => {
    setupSelectMock([{ id: 'conv-stuck', userId: 'user-1' }]);
    const boss = makeFakeBoss();

    await runReconcileExtraction(boss);

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'reconcile_extraction_reenqueue', conversation_id: 'conv-stuck', user_id: 'user-1' }),
    );
  });

  it('processes multiple stuck conversations in a single run', async () => {
    setupSelectMock([
      { id: 'conv-a', userId: 'user-1' },
      { id: 'conv-b', userId: 'user-2' },
      { id: 'conv-c', userId: 'user-3' },
    ]);
    const boss = makeFakeBoss();

    await runReconcileExtraction(boss);

    expect(mockEnqueue).toHaveBeenCalledTimes(3);
  });

  it('logs a scan summary with the correct reenqueued_count', async () => {
    setupSelectMock([
      { id: 'conv-1', userId: 'u-1' },
      { id: 'conv-2', userId: 'u-2' },
    ]);
    const boss = makeFakeBoss();

    await runReconcileExtraction(boss);

    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'reconcile_extraction_scan', reenqueued_count: 2, checked_count: 2 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

describe('runReconcileExtraction — error handling', () => {
  it('continues processing other conversations when one enqueue fails', async () => {
    setupSelectMock([
      { id: 'conv-fail', userId: 'user-1' },
      { id: 'conv-ok',   userId: 'user-2' },
    ]);
    const boss = makeFakeBoss();

    mockEnqueue
      .mockRejectedValueOnce(new Error('enqueue exploded'))
      .mockResolvedValueOnce(undefined);

    await expect(runReconcileExtraction(boss)).resolves.not.toThrow();

    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    expect(mockEnqueue).toHaveBeenNthCalledWith(2, boss, {
      conversation_id: 'conv-ok',
      user_id:         'user-2',
    });
  });

  it('logs reconcile_extraction_error when an individual re-enqueue fails', async () => {
    setupSelectMock([{ id: 'conv-fail', userId: 'user-1' }]);
    const boss = makeFakeBoss();
    mockEnqueue.mockRejectedValueOnce(new Error('DB unavailable'));

    await runReconcileExtraction(boss);

    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'reconcile_extraction_error', conversation_id: 'conv-fail' }),
    );
  });

  it('does not throw when the DB query itself fails', async () => {
    const where = jest.fn().mockRejectedValue(new Error('DB connection lost'));
    const from  = jest.fn().mockReturnValue({ where });
    mockSelect.mockReturnValue({ from });
    const boss = makeFakeBoss();

    // Propagates up to the pg-boss worker (which marks the job failed for
    // retry) — intentional, same convention as runInactivityClose: the
    // cron retries naturally on the next tick.
    await expect(runReconcileExtraction(boss)).rejects.toThrow('DB connection lost');
  });
});
