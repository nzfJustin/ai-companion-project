/**
 * src/services/streakService.ts
 *
 * Streak tracking logic (T-008).
 *
 * Called inside the extraction job's DB transaction after a conversation is
 * successfully summarised. Three possible transitions per call:
 *
 *   first ever  → INSERT row with current_streak=1, longest_streak=1
 *   same day    → no-op (user already active today; don't double-count)
 *   consecutive → current_streak += 1; update longest_streak if needed
 *   gap         → current_streak = 1 (streak broken; restart from today)
 *
 * "Today" is always computed in the user's own timezone so that a conversation
 * closed at 11 PM local time counts as the same day as one at 8 AM local time.
 *
 * updateStreak() accepts a Drizzle transaction object (`tx`) so the streak
 * upsert is atomic with the memory + emotional_snapshot writes. If the
 * transaction rolls back, the streak is never updated.
 */

import { eq } from 'drizzle-orm';
import { users, userStreaks } from '../db/schema';
import type { Db } from '../db';
import { logError } from '../lib/logger';

// Drizzle transaction type — inferred from db.transaction()'s callback parameter.
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Returns the current date string (YYYY-MM-DD) in the given IANA timezone.
 * Uses en-CA locale because it formats dates as YYYY-MM-DD natively.
 *
 * Examples:
 *   todayInTz('America/Los_Angeles')  → '2026-01-15'  (even if UTC is Jan 16)
 *   todayInTz('Asia/Tokyo')           → '2026-01-16'  (UTC+9 ahead of UTC)
 */
export function todayInTz(tz: string): string {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: tz });
  } catch {
    // Fall back to UTC if the timezone string is invalid
    return new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
  }
}

/**
 * Returns yesterday's date string (YYYY-MM-DD) in the given IANA timezone.
 * Subtracts exactly 24 hours — safe for date-string comparison purposes.
 */
export function yesterdayInTz(tz: string): string {
  try {
    return new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: tz });
  } catch {
    return new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'UTC' });
  }
}

// ─── updateStreak ─────────────────────────────────────────────────────────────

/**
 * Upserts the user_streaks row for `userId` based on today's date in the
 * user's local timezone.
 *
 * Must be called inside a Drizzle transaction so the streak update is atomic
 * with the memory and emotional_snapshot writes.
 *
 * @param tx        Drizzle transaction object
 * @param userId    UUID of the user whose streak to update
 * @param timezone  IANA timezone string (e.g. 'America/New_York')
 */
export async function updateStreak(
  tx:       Tx,
  userId:   string,
  timezone: string,
): Promise<void> {
  const today     = todayInTz(timezone);
  const yesterday = yesterdayInTz(timezone);

  const [existing] = await tx
    .select()
    .from(userStreaks)
    .where(eq(userStreaks.userId, userId))
    .limit(1);

  if (!existing) {
    // ── First ever conversation ─────────────────────────────────────────────
    await tx.insert(userStreaks).values({
      userId,
      currentStreak:  1,
      longestStreak:  1,
      lastActiveDate: today,
      updatedAt:      new Date(),
    });
    return;
  }

  const { lastActiveDate, currentStreak, longestStreak } = existing;

  // ── Already active today — no-op ────────────────────────────────────────
  if (lastActiveDate === today) return;

  // ── Consecutive day — extend streak ─────────────────────────────────────
  // ── Gap (>1 day) — reset streak ──────────────────────────────────────────
  const newCurrent = lastActiveDate === yesterday
    ? currentStreak + 1   // consecutive
    : 1;                  // gap — restart

  const newLongest = Math.max(longestStreak, newCurrent);

  await tx
    .update(userStreaks)
    .set({
      currentStreak:  newCurrent,
      longestStreak:  newLongest,
      lastActiveDate: today,
      updatedAt:      new Date(),
    })
    .where(eq(userStreaks.userId, userId));
}

// ─── getUserTimezone ──────────────────────────────────────────────────────────

/**
 * Fetches the IANA timezone for a user. Called outside the extraction
 * transaction so it doesn't block the transaction if it fails.
 * Falls back to 'UTC' on any error.
 */
export async function getUserTimezone(dbInstance: Db, userId: string): Promise<string> {
  try {
    const [row] = await dbInstance
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.timezone ?? 'UTC';
  } catch (err) {
    logError({
      event:   'streak_timezone_fetch_failed',
      user_id: userId,
      error:   err instanceof Error ? err.message : String(err),
    });
    return 'UTC';
  }
}
