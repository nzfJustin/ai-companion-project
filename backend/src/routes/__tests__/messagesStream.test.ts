/**
 * src/routes/__tests__/messagesStream.test.ts
 *
 * Unit tests for the T-007 crisis sentinel helpers used by
 * conversations.router.ts's POST /:id/messages streaming handler.
 *
 * See messages.test.ts for the end-to-end SSE integration tests (sentinel
 * never reaches the client, crisis_flag is logged, the persisted message
 * is sentinel-free).
 */

import {
  CRISIS_SENTINEL,
  stripCrisisSentinel,
  sentinelPrefixOverlapLength,
} from '../v1/messagesStream';

// ─────────────────────────────────────────────────────────────────────────────
// CRISIS_SENTINEL
// ─────────────────────────────────────────────────────────────────────────────

describe('CRISIS_SENTINEL', () => {
  it('matches the exact text instructed in the prompt guardrails', () => {
    // Guard against typo drift between prompts/index.ts and messagesStream.ts
    expect(CRISIS_SENTINEL).toBe('CRISIS_RESOURCE_INJECTED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stripCrisisSentinel
// ─────────────────────────────────────────────────────────────────────────────

describe('stripCrisisSentinel', () => {
  it('detects and strips a trailing sentinel', () => {
    const input = `I hear how much pain you're in. Please reach out to 988.\n${CRISIS_SENTINEL}`;
    const { text, detected } = stripCrisisSentinel(input);
    expect(detected).toBe(true);
    expect(text).not.toContain(CRISIS_SENTINEL);
    expect(text).toContain('988');
  });

  it('strips surrounding whitespace along with the sentinel', () => {
    const input = `Please call 988.\n\n${CRISIS_SENTINEL}\n`;
    const { text, detected } = stripCrisisSentinel(input);
    expect(detected).toBe(true);
    expect(text.trim()).toBe('Please call 988.');
  });

  it('returns detected=false and the original text when no sentinel is present', () => {
    const input = 'It sounds like you had a tough day.';
    const { text, detected } = stripCrisisSentinel(input);
    expect(detected).toBe(false);
    expect(text).toBe(input);
  });

  it('does not treat a partial/incidental substring as the sentinel', () => {
    const input = 'Something CRISIS_RESOURCE happened but this is CRISIS_RESOURCE_INJECT not a sentinel.';
    const { text, detected } = stripCrisisSentinel(input);
    expect(detected).toBe(false);
    expect(text).toBe(input);
  });

  it('does not strip a sentinel that appears mid-text rather than at the end', () => {
    const input = `${CRISIS_SENTINEL} is mentioned but this is not at the end, more follows.`;
    const { text, detected } = stripCrisisSentinel(input);
    expect(detected).toBe(false);
    expect(text).toBe(input);
  });

  it('returns detected=false for an empty string', () => {
    const { text, detected } = stripCrisisSentinel('');
    expect(detected).toBe(false);
    expect(text).toBe('');
  });

  it('handles the sentinel with no preceding whitespace', () => {
    const input = `Please call 988.${CRISIS_SENTINEL}`;
    const { text, detected } = stripCrisisSentinel(input);
    expect(detected).toBe(true);
    expect(text).toBe('Please call 988.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sentinelPrefixOverlapLength
// ─────────────────────────────────────────────────────────────────────────────

describe('sentinelPrefixOverlapLength', () => {
  it('returns 0 when the tail shares no prefix with the sentinel', () => {
    expect(sentinelPrefixOverlapLength('Hello, world')).toBe(0);
  });

  it('returns the full tail length when the tail exactly equals the sentinel', () => {
    expect(sentinelPrefixOverlapLength(CRISIS_SENTINEL)).toBe(CRISIS_SENTINEL.length);
  });

  it('returns the overlap length for a partial trailing prefix match', () => {
    expect(sentinelPrefixOverlapLength('done. CRIS')).toBe(4); // "CRIS" is a prefix of the sentinel
  });

  it('recovers to 0 once a character diverges from the sentinel prefix', () => {
    // "CRIX" is NOT a prefix of CRISIS_RESOURCE_INJECTED
    expect(sentinelPrefixOverlapLength('done. CRIX')).toBe(0);
  });

  it('returns 0 for an empty string', () => {
    expect(sentinelPrefixOverlapLength('')).toBe(0);
  });
});
