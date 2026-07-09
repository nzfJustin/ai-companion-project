/**
 * src/utils/time.ts
 *
 * Produces user-facing relative timestamps matching the F1-005 spec:
 *   < 1 min ago  → "just now"
 *   1–59 min ago → "2 min ago"
 *   same day     → "10:34 AM"
 *   older        → "Jan 15"
 *
 * Also exports conversationDate for the F1-007 history screen:
 *   today        → "Today at 2:34 PM"
 *   yesterday    → "Yesterday at 10:12 AM"
 *   within 7d   → "Monday at 3:45 PM"
 *   older        → "Jan 15 at 9:20 AM"
 */

export function relativeTime(isoString: string): string {
  const now  = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs  = now - then;
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1)  return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;

  const date = new Date(isoString);
  const today = new Date();

  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth()    === today.getMonth()    &&
    date.getDate()     === today.getDate()
  ) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Rich date display for conversation history cards.
 * More informative than relativeTime — always shows the clock time.
 */
export function conversationDate(isoString: string): string {
  const date    = new Date(isoString);
  const now     = new Date();
  const time    = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  const startOfToday     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
  const startOfWeek      = new Date(startOfToday.getTime() - 6 * 86_400_000);

  if (date >= startOfToday)     return `Today at ${time}`;
  if (date >= startOfYesterday) return `Yesterday at ${time}`;

  if (date >= startOfWeek) {
    const day = date.toLocaleDateString(undefined, { weekday: 'long' });
    return `${day} at ${time}`;
  }

  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${dateStr} at ${time}`;
}
