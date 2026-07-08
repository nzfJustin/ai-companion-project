/**
 * src/utils/time.ts
 *
 * Produces user-facing relative timestamps matching the F1-005 spec:
 *   < 1 min ago  → "just now"
 *   1–59 min ago → "2 min ago"
 *   same day     → "10:34 AM"
 *   older        → "Jan 15"
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
