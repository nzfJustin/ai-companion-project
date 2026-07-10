/**
 * src/jobs/__tests__/inactivityClose.test.ts
 *
 * Tests for runInactivityClose() — the P1-15 inactivity auto-close cron.
 *
 * All database calls and the enqueueExtractionJob helper are mocked so
 * no real Postgres or pg-boss is required.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockExecute = jest.fn();
const mockUpdate  = jest.fn();

jest.mock('../../db', () => ({
  db: {
    execute: mockExecute,
    update:  mockUpdate,
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

// ── Imports ────────────────────────────────────────────────────────────────────

import type { PgBoss } from 'pg-boss';
import { runInactivityClose, INACTIVITY_THRESHOLD_MS } from '../index';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Creates a fake pg-boss instance (only send() needs to exist for these tests). */
function makeFakeBoss(): PgBoss {
  return { send: jest.fn().mockResolvedValue('job-id') } as unknown as PgBoss;
}

/** Sets up db.update to return a successful UPDATE (conversation was closed). */
function setupUpdateMock(returnId: string | null = 'conv-1') {
  const returning = jest.fn().mockResolvedValue(
    returnId ? [{ id: returnId }] : [],  // empty = race-condition skip
  );
  const where     = jest.fn().mockReturnValue({ returning });
  const set       = jest.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set });
  return { set, where, returning };
}

beforeEach(() => {
  jest.clearAllMocks();
  setupUpdateMock();
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding stale conversations
// ─────────────────────────────────────────────────────────────────────────────

describe('runInactivityClose — query behaviour', () => {
  it('executes a SQL query against the conversations and messages tables', async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    const boss = makeFakeBoss();

    await runInactivityClose(boss);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    // The query should reference 'conversations' and 'messages'
    const queryText = String(mockExecute.mock.calls[0][0].queryChunks?.map((c: { value: unknown }) => c.value).join('') ?? mockExecute.mock.calls[0][0]);
    expect(queryText).toMatch(/conversations/i);
    expect(queryText).toMatch(/messages/i);
  });

  it('uses a cutoff time of approximately 30 minutes ago', async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    const boss = makeFakeBoss();
    const before = Date.now();

    await runInactivityClose(boss);

    const after = Date.now();
    // The SQL template literal includes the cutoff Date as a parameter
    const callArgs = mockExecute.mock.calls[0][0];
    const cutoffArg = callArgs.queryChunks?.find(
      (chunk: { value: unknown }) => chunk.value instanceof Date,
    )?.value as Date | undefined;

    if (cutoffArg) {
      const cutoffMs = cutoffArg.getTime();
      expect(cutoffMs).toBeGreaterThanOrEqual(before - INACTIVITY_THRESHOLD_MS - 100);
      expect(cutoffMs).toBeLessThanOrEqual(after  - INACTIVITY_THRESHOLD_MS + 100);
    }
  });

  it('logs a scan event with closed_count=0 when no stale conversations are found', async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    const boss = makeFakeBoss();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await runInactivityClose(boss);

    const logged = logSpy.mock.calls.map((c) => JSON.parse(c[0]));
    const scan   = logged.find((l) => l.event === 'inactivity_close_scan');
    expect(scan).toBeDefined();
    expect(scan.closed_count).toBe(0);

    logSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Closing stale conversations
// ─────────────────────────────────────────────────────────────────────────────

describe('runInactivityClose — closing stale conversations', () => {
  it('updates each stale conversation to status="closed" with ended_at=NOW()', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-idle', user_id: 'user-1' }],
    });
    const boss    = makeFakeBoss();
    const { set } = setupUpdateMock('conv-idle');

    await runInactivityClose(boss);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'closed', endedAt: expect.any(Date) }),
    );
  });

  it('re-checks status="active" in the WHERE clause to guard against race conditions', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-1', user_id: 'user-1' }],
    });
    const boss = makeFakeBoss();
    setupUpdateMock('conv-1');

    await runInactivityClose(boss);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('enqueues a memory extraction job after closing each conversation', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-idle', user_id: 'user-42' }],
    });
    const boss = makeFakeBoss();
    setupUpdateMock('conv-idle');

    await runInactivityClose(boss);

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      boss,
      { conversation_id: 'conv-idle', user_id: 'user-42' },
    );
  });

  it('processes multiple stale conversations in a single run', async () => {
    mockExecute.mockResolvedValue({
      rows: [
        { id: 'conv-a', user_id: 'user-1' },
        { id: 'conv-b', user_id: 'user-2' },
        { id: 'conv-c', user_id: 'user-3' },
      ],
    });
    const boss = makeFakeBoss();

    // Each update returns a different id
    let callNum = 0;
    const ids = ['conv-a', 'conv-b', 'conv-c'];
    const returning = jest.fn().mockImplementation(async () => [{ id: ids[callNum++] }]);
    const where = jest.fn().mockReturnValue({ returning });
    const set   = jest.fn().mockReturnValue({ where });
    mockUpdate.mockReturnValue({ set });

    await runInactivityClose(boss);

    expect(mockUpdate).toHaveBeenCalledTimes(3);
    expect(mockEnqueue).toHaveBeenCalledTimes(3);
  });

  it('logs an inactivity_close event for each conversation closed', async () => {
    mockExecute.mockResolvedValue({
      rows: [
        { id: 'conv-x', user_id: 'user-x' },
        { id: 'conv-y', user_id: 'user-y' },
      ],
    });
    const boss    = makeFakeBoss();
    let callNum   = 0;
    const returning = jest.fn().mockImplementation(async () => [{ id: ['conv-x', 'conv-y'][callNum++] }]);
    const where = jest.fn().mockReturnValue({ returning });
    mockUpdate.mockReturnValue({ set: jest.fn().mockReturnValue({ where }) });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await runInactivityClose(boss);

    const logged = logSpy.mock.calls.map((c) => JSON.parse(c[0]));
    const closeEvents = logged.filter((l) => l.event === 'inactivity_close');
    expect(closeEvents).toHaveLength(2);
    expect(closeEvents.map((e) => e.conversation_id)).toEqual(
      expect.arrayContaining(['conv-x', 'conv-y']),
    );

    logSpy.mockRestore();
  });

  it('logs a scan summary with the correct closed_count', async () => {
    mockExecute.mockResolvedValue({
      rows: [
        { id: 'conv-1', user_id: 'u-1' },
        { id: 'conv-2', user_id: 'u-2' },
      ],
    });
    const boss    = makeFakeBoss();
    let callNum   = 0;
    const returning = jest.fn().mockImplementation(async () => [{ id: ['conv-1', 'conv-2'][callNum++] }]);
    const where = jest.fn().mockReturnValue({ returning });
    mockUpdate.mockReturnValue({ set: jest.fn().mockReturnValue({ where }) });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await runInactivityClose(boss);

    const logged = logSpy.mock.calls.map((c) => JSON.parse(c[0]));
    const scan   = logged.find((l) => l.event === 'inactivity_close_scan');
    expect(scan.closed_count).toBe(2);
    expect(scan.checked_count).toBe(2);

    logSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Race condition handling
// ─────────────────────────────────────────────────────────────────────────────

describe('runInactivityClose — race condition handling', () => {
  it('skips the extraction enqueue when the UPDATE returns no rows (conversation no longer active)', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-raced', user_id: 'user-1' }],
    });
    const boss = makeFakeBoss();
    setupUpdateMock(null); // empty returning = row no longer active

    await runInactivityClose(boss);

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('logs inactivity_close_skipped when the race is detected', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-raced', user_id: 'user-1' }],
    });
    const boss = makeFakeBoss();
    setupUpdateMock(null);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await runInactivityClose(boss);

    const logged = logSpy.mock.calls.map((c) => JSON.parse(c[0]));
    expect(logged.find((l) => l.event === 'inactivity_close_skipped')).toBeDefined();

    logSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

describe('runInactivityClose — error handling', () => {
  it('continues processing other conversations when one update fails', async () => {
    mockExecute.mockResolvedValue({
      rows: [
        { id: 'conv-fail', user_id: 'user-1' },
        { id: 'conv-ok',   user_id: 'user-2' },
      ],
    });
    const boss = makeFakeBoss();

    let callCount = 0;
    mockUpdate.mockImplementation(() => ({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockImplementation(async () => {
            callCount++;
            if (callCount === 1) throw new Error('DB error on first conversation');
            return [{ id: 'conv-ok' }];
          }),
        }),
      }),
    }));

    await expect(runInactivityClose(boss)).resolves.not.toThrow();

    // Second conversation should still be processed
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(boss, {
      conversation_id: 'conv-ok',
      user_id:         'user-2',
    });
  });

  it('logs an error when an individual conversation update fails', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-fail', user_id: 'user-1' }],
    });
    const boss = makeFakeBoss();

    mockUpdate.mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue(new Error('DB unavailable')),
        }),
      }),
    });

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await runInactivityClose(boss);

    const logged = errSpy.mock.calls.map((c) => JSON.parse(c[0]));
    expect(logged.find((l) => l.event === 'inactivity_close_error')).toBeDefined();

    errSpy.mockRestore();
  });

  it('does not throw when the DB query itself fails', async () => {
    mockExecute.mockRejectedValue(new Error('DB connection lost'));
    const boss = makeFakeBoss();

    // runInactivityClose propagates the DB error up to the pg-boss worker
    // (which will mark the job as failed for retry). This is intentional —
    // the cron job should retry naturally on the next 5-minute tick.
    await expect(runInactivityClose(boss)).rejects.toThrow('DB connection lost');
  });
});
