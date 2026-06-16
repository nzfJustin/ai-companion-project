/**
 * src/ai/llm/errors.ts
 *
 * Error types thrown by LLMProvider implementations.
 * AIOrchestrationService (P1-13) catches these and decides whether to
 * retry, log, or surface the user-facing fallback message.
 */

// ─── Base ─────────────────────────────────────────────────────────────────────

export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMError';
    Object.setPrototypeOf(this, LLMError.prototype);
  }
}

// ─── Specific types ───────────────────────────────────────────────────────────

/**
 * Thrown when the provider returns a 429 Too Many Requests.
 *
 * AIOrchestrationService retries with exponential backoff (max 2 retries).
 * After all retries are exhausted, it surfaces the user-facing message:
 *   "I'm having a moment of quiet. Could you share that again?"
 */
export class LLMRateLimitError extends LLMError {
  constructor(message = 'LLM rate limit exceeded') {
    super(message);
    this.name = 'LLMRateLimitError';
    Object.setPrototypeOf(this, LLMRateLimitError.prototype);
  }
}

/**
 * Thrown when the provider connection times out.
 * AIOrchestrationService applies a 15-second timeout before this fires.
 */
export class LLMTimeoutError extends LLMError {
  constructor(message = 'LLM request timed out') {
    super(message);
    this.name = 'LLMTimeoutError';
    Object.setPrototypeOf(this, LLMTimeoutError.prototype);
  }
}

/**
 * Thrown for any other provider error (non-429, non-timeout).
 * Covers 5xx server errors, invalid request errors, mid-stream failures.
 */
export class LLMStreamError extends LLMError {
  constructor(message = 'LLM error') {
    super(message);
    this.name = 'LLMStreamError';
    Object.setPrototypeOf(this, LLMStreamError.prototype);
  }
}

// ─── User-facing fallback ─────────────────────────────────────────────────────

/**
 * The message shown to the user when the LLM is unavailable (rate-limited
 * or errored after all retries). Returned by AIOrchestrationService.
 */
export const RATE_LIMIT_USER_MESSAGE =
  "I'm having a moment of quiet. Could you share that again?";
