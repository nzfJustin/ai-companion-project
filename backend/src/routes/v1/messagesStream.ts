/**
 * src/routes/v1/messagesStream.ts
 *
 * Crisis sentinel handling for POST /v1/conversations/:id/messages (T-007).
 *
 * When the AI includes crisis resources it appends CRISIS_SENTINEL at the
 * end of its response (instructed by GUARDRAILS_BLOCK in prompts/index.ts).
 * conversations.router.ts strips it here before storing the message or
 * sending it to the client, and emits a structured 'crisis_flag' warning
 * when detected so it can be surfaced for review (T-013).
 */

export const CRISIS_SENTINEL = 'CRISIS_RESOURCE_INJECTED';

const TRAILING_SENTINEL_RE = new RegExp(`\\s*${CRISIS_SENTINEL}\\s*$`);

/**
 * Strips a TRAILING CRISIS_SENTINEL from `text`, along with any surrounding
 * whitespace. Only a sentinel anchored at the very end counts as detected —
 * an incidental mid-response mention of the constant is not a real
 * guardrail trigger and is left untouched.
 *
 * Returns { text, detected } where detected is true only if a trailing
 * sentinel was actually found and stripped.
 */
export function stripCrisisSentinel(text: string): { text: string; detected: boolean } {
  if (!TRAILING_SENTINEL_RE.test(text)) {
    return { text, detected: false };
  }
  const stripped = text.replace(TRAILING_SENTINEL_RE, '').trimEnd();
  return { text: stripped, detected: true };
}

/**
 * Returns the length of the longest suffix of `tail` that is also a prefix
 * of CRISIS_SENTINEL — i.e. how much of `tail`'s end could be the start of
 * an in-progress sentinel match. 0 means no overlap, so all of `tail` is
 * safe to flush immediately.
 *
 * Used by the streaming loop in conversations.router.ts to forward tokens
 * to the client in real time while still guaranteeing the sentinel itself
 * never reaches an SSE frame: only the portion of the buffer that couldn't
 * possibly be a sentinel prefix is ever flushed mid-stream.
 */
export function sentinelPrefixOverlapLength(tail: string): number {
  const maxLen = Math.min(tail.length, CRISIS_SENTINEL.length);
  for (let len = maxLen; len > 0; len--) {
    if (CRISIS_SENTINEL.startsWith(tail.slice(-len))) return len;
  }
  return 0;
}
