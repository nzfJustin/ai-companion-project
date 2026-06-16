/**
 * tests/mocks/MockLLMProvider.ts
 *
 * Test double for LLMProvider (TDD §11.2).
 *
 * Used in all non-golden-set tests. Never makes real network calls.
 *
 * Features:
 *   setFixture(type, response)  — set a canned response per prompt mode
 *   simulateRateLimit()         — cause the next call to throw LLMRateLimitError
 *   simulateTimeout()           — cause the next call to throw LLMTimeoutError
 *   getLastRequest()            — inspect what was last passed to complete/stream
 *   reset()                     — clear all fixtures and flags
 *
 * Fixture types:
 *   'chat'        — conversational AI response (default)
 *   'extraction'  — JSON string conforming to MemoryExtractionSchema
 *   'onboarding'  — JSON string conforming to OnboardingExtractionSchema
 *
 * Edge-case fixture for schema validation tests:
 *   setFixture('extraction', JSON.stringify({ ..., memory_level: 99 }))
 *   This lets P1-19 tests verify that out-of-range memory_level is rejected.
 */

import type { LLMProvider, CompletionRequest, CompletionResponse } from '../../src/ai/llm/types';
import { LLMRateLimitError, LLMTimeoutError } from '../../src/ai/llm/errors';

// ─── Fixture types ────────────────────────────────────────────────────────────

export type FixtureType = 'chat' | 'extraction' | 'onboarding';

// ─── Default canned responses ─────────────────────────────────────────────────

const DEFAULT_RESPONSES: Record<FixtureType, string> = {
  chat: "I hear you. How long have you been feeling this way?",

  extraction: JSON.stringify({
    title:           'Daily reflection',
    summary:         'User shared their thoughts about their day.',
    key_events:      ['Felt stressed at work', 'Had a good conversation with a friend'],
    dominant_emotion: 'calm',
    emotion_scores: {
      joy:       0.4,
      sadness:   0.2,
      anxiety:   0.3,
      anger:     0.1,
      calm:      0.6,
      excitement: 0.2,
    },
    memory_level: 1,  // Valid level — tests can override to 99 for edge-case testing
    emotional_tags: ['reflective', 'hopeful'],
  }),

  onboarding: JSON.stringify({
    inferred_comm_style: 'warm',
    stated_goals:        ['Manage stress', 'Build better habits', 'Feel more connected'],
    initial_context:     'User is a young professional dealing with work-related stress.',
  }),
};

// ─── MockLLMProvider ──────────────────────────────────────────────────────────

export class MockLLMProvider implements LLMProvider {
  private fixtures   = new Map<FixtureType, string>();
  private _rateLimitOnce  = false;
  private _timeoutOnce    = false;
  private _lastRequest:   CompletionRequest | null = null;
  private _callCount      = 0;

  // ─── Fixture controls ────────────────────────────────────────────────────────

  /**
   * Set the response string for a given prompt mode.
   * For extraction/onboarding modes the response must be valid JSON.
   *
   * @example
   *   mock.setFixture('extraction', JSON.stringify({ ...validShape, memory_level: 99 }))
   */
  setFixture(type: FixtureType, response: string): this {
    this.fixtures.set(type, response);
    return this;
  }

  /**
   * Cause the NEXT call (complete or stream) to throw LLMRateLimitError.
   * Subsequent calls behave normally.
   */
  simulateRateLimit(): this {
    this._rateLimitOnce = true;
    return this;
  }

  /**
   * Cause the NEXT call (complete or stream) to throw LLMTimeoutError.
   */
  simulateTimeout(): this {
    this._timeoutOnce = true;
    return this;
  }

  /**
   * Inspect the most recent request passed to complete() or stream().
   */
  getLastRequest(): CompletionRequest | null {
    return this._lastRequest;
  }

  /** Total number of complete() + stream() calls made. */
  get callCount(): number {
    return this._callCount;
  }

  /** Clear all fixtures and error simulation flags. */
  reset(): this {
    this.fixtures.clear();
    this._rateLimitOnce  = false;
    this._timeoutOnce    = false;
    this._lastRequest    = null;
    this._callCount      = 0;
    return this;
  }

  // ─── LLMProvider implementation ──────────────────────────────────────────────

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this._lastRequest = req;
    this._callCount++;
    this.checkErrors();

    const content = this.responseFor(req);

    return {
      content,
      usage: {
        input_tokens:  100,
        output_tokens: Math.ceil(content.length / 4),
        cached_tokens: 0,
      },
      stop_reason: 'end_turn',
    };
  }

  async *stream(req: CompletionRequest): AsyncIterable<string> {
    this._lastRequest = req;
    this._callCount++;
    this.checkErrors();

    const content = this.responseFor(req);

    // Simulate chunked streaming by yielding word-by-word
    const words = content.split(' ');
    for (const word of words) {
      yield word + ' ';
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private checkErrors(): void {
    if (this._rateLimitOnce) {
      this._rateLimitOnce = false;
      throw new LLMRateLimitError('Mock: rate limit');
    }
    if (this._timeoutOnce) {
      this._timeoutOnce = false;
      throw new LLMTimeoutError('Mock: timeout');
    }
  }

  private responseFor(req: CompletionRequest): string {
    const type = this.detectType(req);
    return this.fixtures.get(type) ?? DEFAULT_RESPONSES[type];
  }

  /**
   * Detect which prompt mode is in use by inspecting the system prompt.
   * This mirrors how AIOrchestrationService routes to different prompt modes.
   */
  private detectType(req: CompletionRequest): FixtureType {
    const system = typeof req.system === 'string'
      ? req.system
      : Array.isArray(req.system)
        ? req.system.map((b) => b.text).join(' ')
        : '';

    const lower = system.toLowerCase();
    if (lower.includes('extract') || lower.includes('memory')) return 'extraction';
    if (lower.includes('onboard'))                               return 'onboarding';
    return 'chat';
  }
}
