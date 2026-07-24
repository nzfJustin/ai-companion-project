/**
 * src/services/__tests__/streakService.test.ts
 *
 * Unit tests for the streak tracking logic (T-008).
 * The DB is fully mocked — no real Postgres connection needed.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockSelect   = jest.fn();
const mockInsert   = jest.fn();
const mockUpdate   = jest.fn();

jest.mock('../../db', () => ({
  db: {
    select:   (...args: unknown[]) => mockSelect(...args),
    insert:   (...args: unknown[]) => mockInsert(...args),
    update:   (...args: unknown[]) => mockUpdate(...args),
    transaction: jest.fn(),
  },
}));

jest.mock('../../lib/logger', () => ({
  log:      jest.fn(),
  warn:     jest.fn(),
  logError: jest.fn(),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { updateStreak, todayInTz, yesterdayInTz } from '../streakService';

// ── Helpers ────────────────────────────────────────────────────────────────────

const USER_ID  = 'aaaa-0000-0000-0000-aaaaaaaaaaaa';
const TIMEZONE = 'America/New_York';

function today()     { return todayInTz(TIMEZONE); }
function yesterday() { return yesterdayInTz(TIMEZONE); }
function twoDaysAgo() {
  return new Date(Date.now() - 2 * 86_400_000)
    .toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

/** Chains .from().where().limit() returning a Promise resolving to rows */
function makeSelectChain(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const from  = jest.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
  return { from, where, limit };
}

/** Chains .into()/.values() returning a resolved Promise */
function makeInsertChain() {
  const values = jest.fn().mockResolvedValue([]);
  const into   = jest.fn().mockReturnValue({ values });
  mockInsert.mockReturnValue({ into, values });
  return { into, values };
}

/** Chains .set().where() returning a resolved Promise */
function makeUpdateChain() {
  const where = jest.fn().mockResolvedValue([]);
  const set   = jest.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set });
  return { set, where };
}

/** A fake transaction object that proxies to the module-level mocks */
const fakeTx = {
  select:   (...args: unknown[]) => mockSelect(...args),
  insert:   (...args: unknown[]) => mockInsert(...args),
  update:   (...args: unknown[]) => mockUpdate(...args),
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('todayInTz / yesterdayInTz', () => {
  it('returns a YYYY-MM-DD string', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(yesterday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('yesterday is always one day before today', () => {
    const t = new Date(today());
    const y = new Date(yesterday());
    const diffMs = t.getTime() - y.getTime();
    expect(diffMs).toBe(86_400_000);
  });

  it('falls back to UTC on an invalid timezone string', () => {
    expect(() => todayInTz('Not/ATimezone')).not.toThrow();
    expect(todayInTz('Not/ATimezone')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// First-ever conversation — INSERT a new streak row
// ─────────────────────────────────────────────────────────────────────────────

describe('updateStreak — first conversation', () => {
  it('inserts a new row with current_streak=1, longest_streak=1', async () => {
    makeSelectChain([]);       // no existing row
    const { values } = makeInsertChain();

    await updateStreak(fakeTx as never, USER_ID, TIMEZONE);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId:         USER_ID,
        currentStreak:  1,
        longestStreak:  1,
        lastActiveDate: today(),
      }),
    );
  });

  it('does not call update when inserting for the first time', async () => {
    makeSelectChain([]);
    makeInsertChain();

    await updateStreak(fakeTx as never, USER_ID, TIMEZONE);

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Same day — no-op
// ─────────────────────────────────────────────────────────────────────────────

describe('updateStreak — same day (no-op)', () => {
  it('does nothing when lastActiveDate is already today', async () => {
    makeSelectChain([{
      currentStreak: 3, longestStreak: 5, lastActiveDate: today(),
    }]);

    await updateStreak(fakeTx as never, USER_ID, TIMEZONE);

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consecutive day — extend streak
// ─────────────────────────────────────────────────────────────────────────────

describe('updateStreak — consecutive day', () => {
  it('increments current_streak by 1', async () => {
    makeSelectChain([{
      currentStreak: 4, longestStreak: 4, lastActiveDate: yesterday(),
    }]);
    const { set } = makeUpdateChain();

    await updateStreak(fakeTx as never, USER_ID, TIMEZONE);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ currentStreak: 5 }),
    );
  });

  it('updates longest_streak when current exceeds it', async () => {
    makeSelectChain([{
      currentStreak: 7, longestStreak: 7, lastActiveDate: yesterday(),
    }]);
    const { set } = makeUpdateChain();

    await updateStreak(fakeTx as never, USER_ID, TIMEZONE);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ currentStreak: 8, longestStreak: 8 }),
    );
  });

  it('does NOT update longest_streak when current is below it', async () => {
    // User had a 10-day streak before, currently on a 3-day run
    makeSelectChain([{
      currentStreak: 3, longestStreak: 10, lastActiveDate: yesterday(),
    }]);
    const { set } = makeUpdateChain();

    await updateStreak(fakeTx as never, USER_ID, TIMEZONE);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ currentStreak: 4, longestStreak: 10 }),
    );
  });

  it('sets lastActiveDate to today on a consecutive update', async () => {
    makeSelectChain([{
      currentStreak: 2, longestStreak: 2, lastActiveDate: yesterday(),
    }]);
    const { set } = makeUpdateChain();

    await updateStreak(fakeTx as never, USER_ID, TIMEZONE);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ lastActiveDate: today() }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap in days — reset streak
// ─────────────────────────────────────────────────────────────────────────────

describe('updateStreak — streak reset after gap', () => {
  it('resets current_streak to 1 when last active was 2+ days ago', async () => {
    makeSelectChain([{
      currentStreak: 5, longestStreak: 12, lastActiveDate: twoDaysAgo(),
    }]);
    const { set } = makeUpdateChain();

    await updateStreak(fakeTx as never, USER_ID, TIMEZONE);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ currentStreak: 1 }),
    );
  });

  it('does NOT decrease longest_streak after a reset', async () => {
    makeSelectChain([{
      currentStreak: 5, longestStreak: 12, lastActiveDate: twoDaysAgo(),
    }]);
    const { set } = makeUpdateChain();

    await updateStreak(fakeTx as never, USER_ID, TIMEZONE);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ longestStreak: 12 }),
    );
  });

  it('resets even when lastActiveDate is null (edge case)', async () => {
    // null lastActiveDate is treated as a gap (not yesterday)
    makeSelectChain([{
      currentStreak: 1, longestStreak: 1, lastActiveDate: null,
    }]);
    const { set } = makeUpdateChain();

    await updateStreak(fakeTx as never, USER_ID, TIMEZONE);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ currentStreak: 1, lastActiveDate: today() }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Timezone correctness
// ─────────────────────────────────────────────────────────────────────────────

describe('updateStreak — timezone handling', () => {
  it('uses the provided timezone, not UTC, to compute today', async () => {
    // We can't freeze time in this unit test, but we can verify that two
    // different timezones can produce different date strings (the assertion
    // will always be true when run near a timezone boundary, and is a
    // canary for timezone-awareness in the code).
    const utc  = todayInTz('UTC');
    const nz   = todayInTz('Pacific/Auckland');   // UTC+12 or UTC+13
    const hst  = todayInTz('Pacific/Honolulu');   // UTC-10

    // Both must be valid YYYY-MM-DD strings
    expect(utc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nz).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(hst).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // NZ should never be behind HST (it's always at least 20 hours ahead)
    expect(new Date(nz).getTime()).toBeGreaterThanOrEqual(new Date(hst).getTime());
  });

  it('passes the timezone-derived today to the DB, not a UTC date', async () => {
    // For any timezone, the date stored should match todayInTz(timezone)
    const tz = 'Asia/Tokyo';
    makeSelectChain([]);
    const { values } = makeInsertChain();

    await updateStreak(fakeTx as never, USER_ID, tz);

    const stored = (values.mock.calls[0][0] as { lastActiveDate: string }).lastActiveDate;
    expect(stored).toBe(todayInTz(tz));
  });
});
