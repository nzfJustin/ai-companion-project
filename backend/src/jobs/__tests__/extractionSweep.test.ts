/**
 * src/jobs/__tests__/extractionSweep.test.ts
 *
 * Tests for the extraction sweep that replaced the pg-boss
 * memory_extraction job + reconcile_extraction cron — see
 * src/jobs/extractionSweep.ts for the design rationale (atomic DB claim
 * instead of a pg-boss queue option that turned out not to do what it
 * looked like it did).
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockExecute = jest.fn();
const mockUpdate  = jest.fn();

jest.mock('../../db', () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
    update:  (...args: unknown[]) => mockUpdate(...args),
  },
}));

const mockRunExtractionJob = jest.fn();
jest.mock('../extractionJob', () => ({
  runExtractionJob: (...args: unknown[]) => mockRunExtractionJob(...args),
}));

jest.mock('../../lib/logger', () => ({
  log:      jest.fn(),
  warn:     jest.fn(),
  logError: jest.fn(),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import {
  runExtractionSweepTick,
  startExtractionSweep,
  stopExtractionSweep,
  SWEEP_INTERVAL_MS,
  MAX_EXTRACTION_ATTEMPTS,
} from '../extractionSweep';
import { log, warn, logError } from '../../lib/logger';

const mockLog      = log      as jest.Mock;
const mockWarn     = warn     as jest.Mock;
const mockLogError = logError as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────────

function setupUpdateMock() {
  const where = jest.fn().mockResolvedValue(undefined);
  const set   = jest.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set });
  return { set, where };
}

beforeEach(() => {
  jest.clearAllMocks();
  setupUpdateMock();
});

afterEach(() => {
  stopExtractionSweep();
});

// ─────────────────────────────────────────────────────────────────────────────
// Claiming
// ─────────────────────────────────────────────────────────────────────────────

describe('runExtractionSweepTick — claiming', () => {
  it('does nothing when nothing is claimed', async () => {
    mockExecute.mockResolvedValue({ rows: [] });

    await runExtractionSweepTick();

    expect(mockRunExtractionJob).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalled();
  });

  it('runs extraction for each claimed conversation', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-1', userId: 'user-1', extractionAttempts: 0 }],
    });
    mockRunExtractionJob.mockResolvedValue({ success: true, memoryId: 'mem-1' });

    await runExtractionSweepTick();

    expect(mockRunExtractionJob).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId:         'user-1',
      attempt:        1,
    });
  });

  it('processes multiple claimed conversations in one tick', async () => {
    mockExecute.mockResolvedValue({
      rows: [
        { id: 'conv-a', userId: 'user-1', extractionAttempts: 0 },
        { id: 'conv-b', userId: 'user-2', extractionAttempts: 0 },
      ],
    });
    mockRunExtractionJob.mockResolvedValue({ success: true, memoryId: 'mem-x' });

    await runExtractionSweepTick();

    expect(mockRunExtractionJob).toHaveBeenCalledTimes(2);
  });

  it('logs extraction_sweep_claimed with the batch count', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-1', userId: 'user-1', extractionAttempts: 0 }],
    });
    mockRunExtractionJob.mockResolvedValue({ success: true });

    await runExtractionSweepTick();

    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'extraction_sweep_claimed', count: 1 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Success path
// ─────────────────────────────────────────────────────────────────────────────

describe('runExtractionSweepTick — success', () => {
  it('does not issue an extra status update on success (runExtractionJob already set it)', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-1', userId: 'user-1', extractionAttempts: 0 }],
    });
    mockRunExtractionJob.mockResolvedValue({ success: true, memoryId: 'mem-1' });

    await runExtractionSweepTick();

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('logs extraction_sweep_success', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-1', userId: 'user-1', extractionAttempts: 2 }],
    });
    mockRunExtractionJob.mockResolvedValue({ success: true, memoryId: 'mem-1' });

    await runExtractionSweepTick();

    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'extraction_sweep_success', conversation_id: 'conv-1', attempt: 3 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure path
// ─────────────────────────────────────────────────────────────────────────────

describe('runExtractionSweepTick — failure, not yet final attempt', () => {
  it('sets the conversation back to closed with the incremented attempt count', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-1', userId: 'user-1', extractionAttempts: 0 }],
    });
    mockRunExtractionJob.mockResolvedValue({ success: false, reason: 'llm_fallback' });
    const { set } = setupUpdateMock();

    await runExtractionSweepTick();

    expect(set).toHaveBeenCalledWith({ status: 'closed', extractionAttempts: 1 });
  });

  it('logs extraction_sweep_retry', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-1', userId: 'user-1', extractionAttempts: 0 }],
    });
    mockRunExtractionJob.mockResolvedValue({ success: false, reason: 'parse_error' });

    await runExtractionSweepTick();

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'extraction_sweep_retry', conversation_id: 'conv-1', attempt: 1, reason: 'parse_error' }),
    );
  });
});

describe('runExtractionSweepTick — failure, final attempt', () => {
  it('marks the conversation extraction_failed once MAX_EXTRACTION_ATTEMPTS is reached', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-1', userId: 'user-1', extractionAttempts: MAX_EXTRACTION_ATTEMPTS - 1 }],
    });
    mockRunExtractionJob.mockResolvedValue({ success: false, reason: 'schema_invalid' });
    const { set } = setupUpdateMock();

    await runExtractionSweepTick();

    expect(set).toHaveBeenCalledWith({ status: 'extraction_failed', extractionAttempts: MAX_EXTRACTION_ATTEMPTS });
  });

  it('logs extraction_sweep_failed_final', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-1', userId: 'user-1', extractionAttempts: MAX_EXTRACTION_ATTEMPTS - 1 }],
    });
    mockRunExtractionJob.mockResolvedValue({ success: false, reason: 'db_error' });

    await runExtractionSweepTick();

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'extraction_sweep_failed_final', conversation_id: 'conv-1', attempt: MAX_EXTRACTION_ATTEMPTS }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling — never lets one bad conversation kill the whole tick,
// never leaves a conversation stranded at 'extracting'
// ─────────────────────────────────────────────────────────────────────────────

describe('runExtractionSweepTick — error handling', () => {
  it('does not throw when the claim query itself fails, and logs it', async () => {
    mockExecute.mockRejectedValue(new Error('DB connection lost'));

    await expect(runExtractionSweepTick()).resolves.not.toThrow();

    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'extraction_sweep_claim_error' }),
    );
  });

  it('continues processing other claimed conversations when one throws unexpectedly', async () => {
    mockExecute.mockResolvedValue({
      rows: [
        { id: 'conv-fail', userId: 'user-1', extractionAttempts: 0 },
        { id: 'conv-ok',   userId: 'user-2', extractionAttempts: 0 },
      ],
    });
    mockRunExtractionJob
      .mockRejectedValueOnce(new Error('unexpected explosion'))
      .mockResolvedValueOnce({ success: true, memoryId: 'mem-ok' });

    await expect(runExtractionSweepTick()).resolves.not.toThrow();

    expect(mockRunExtractionJob).toHaveBeenCalledTimes(2);
  });

  it('resets a conversation back to closed (without counting an attempt) when processing throws unexpectedly', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ id: 'conv-fail', userId: 'user-1', extractionAttempts: 0 }],
    });
    mockRunExtractionJob.mockRejectedValue(new Error('unexpected explosion'));
    const { set } = setupUpdateMock();

    await runExtractionSweepTick();

    expect(set).toHaveBeenCalledWith({ status: 'closed' });
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'extraction_sweep_process_error', conversation_id: 'conv-fail' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Interval control
// ─────────────────────────────────────────────────────────────────────────────

describe('startExtractionSweep / stopExtractionSweep', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('ticks on the configured interval once started', () => {
    mockExecute.mockResolvedValue({ rows: [] });
    startExtractionSweep();

    jest.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(mockExecute).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('does not tick after stopExtractionSweep()', () => {
    mockExecute.mockResolvedValue({ rows: [] });
    startExtractionSweep();
    stopExtractionSweep();

    jest.advanceTimersByTime(SWEEP_INTERVAL_MS * 3);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('starting twice does not double the tick rate', () => {
    mockExecute.mockResolvedValue({ rows: [] });
    startExtractionSweep();
    startExtractionSweep();

    jest.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
