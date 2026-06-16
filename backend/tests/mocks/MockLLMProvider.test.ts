/**
 * tests/mocks/MockLLMProvider.test.ts
 *
 * Tests for the MockLLMProvider itself — ensures it behaves correctly
 * so that tests that rely on it get predictable, trustworthy fakes.
 */

import { MockLLMProvider } from './MockLLMProvider';
import { LLMRateLimitError, LLMTimeoutError } from '../../src/ai/llm/errors';
import type { CompletionRequest } from '../../src/ai/llm/types';

const CHAT_REQ: CompletionRequest = {
  messages: [{ role: 'user', content: 'How are you?' }],
  system:   'You are a supportive companion.',
  prompt_version: 'chat_v1.0.0',
};

const EXTRACTION_REQ: CompletionRequest = {
  messages: [{ role: 'user', content: 'Please extract memories.' }],
  system:   'Extract memories from this conversation.',
  prompt_version: 'extraction_v1.0.0',
};

const ONBOARDING_REQ: CompletionRequest = {
  messages: [{ role: 'user', content: 'Hi! I want to start journaling.' }],
  system:   'Onboard this new user.',
  prompt_version: 'onboarding_v1.0.0',
};

// ─────────────────────────────────────────────────────────────────────────────

describe('MockLLMProvider.complete()', () => {
  let mock: MockLLMProvider;
  beforeEach(() => { mock = new MockLLMProvider(); });

  it('returns a CompletionResponse without making a network call', async () => {
    const result = await mock.complete(CHAT_REQ);
    expect(result.content).toBeTruthy();
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    expect(result.usage.output_tokens).toBeGreaterThan(0);
    expect(result.usage.cached_tokens).toBe(0);
  });

  it('uses the chat fixture by default for a conversational request', async () => {
    const result = await mock.complete(CHAT_REQ);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('detects extraction mode from system prompt', async () => {
    const result = await mock.complete(EXTRACTION_REQ);
    // Default extraction fixture is valid JSON
    expect(() => JSON.parse(result.content)).not.toThrow();
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveProperty('memory_level');
  });

  it('detects onboarding mode from system prompt', async () => {
    const result = await mock.complete(ONBOARDING_REQ);
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveProperty('inferred_comm_style');
    expect(parsed).toHaveProperty('stated_goals');
  });

  it('setFixture() overrides the canned response for that type', async () => {
    mock.setFixture('chat', 'Custom response!');
    const result = await mock.complete(CHAT_REQ);
    expect(result.content).toBe('Custom response!');
  });

  it('setFixture() for extraction can inject memory_level: 99 (schema validation edge case)', async () => {
    const invalidPayload = JSON.stringify({
      title:           'Bad memory',
      summary:         'This has an invalid level.',
      key_events:      [],
      dominant_emotion: 'calm',
      emotion_scores:  { joy: 0.5, sadness: 0.1, anxiety: 0.1, anger: 0.0, calm: 0.8, excitement: 0.2 },
      memory_level:    99,   // ← invalid, triggers safeParse rejection in P1-19
      emotional_tags:  [],
    });

    mock.setFixture('extraction', invalidPayload);
    const result = await mock.complete(EXTRACTION_REQ);
    const parsed = JSON.parse(result.content);

    expect(parsed.memory_level).toBe(99);
  });

  it('throws LLMRateLimitError once when simulateRateLimit() is called', async () => {
    mock.simulateRateLimit();
    await expect(mock.complete(CHAT_REQ)).rejects.toThrow(LLMRateLimitError);

    // Next call should succeed normally
    await expect(mock.complete(CHAT_REQ)).resolves.toBeTruthy();
  });

  it('throws LLMTimeoutError once when simulateTimeout() is called', async () => {
    mock.simulateTimeout();
    await expect(mock.complete(CHAT_REQ)).rejects.toThrow(LLMTimeoutError);
    await expect(mock.complete(CHAT_REQ)).resolves.toBeTruthy();
  });

  it('getLastRequest() returns the most recent request', async () => {
    await mock.complete(CHAT_REQ);
    expect(mock.getLastRequest()).toBe(CHAT_REQ);

    await mock.complete(EXTRACTION_REQ);
    expect(mock.getLastRequest()).toBe(EXTRACTION_REQ);
  });

  it('callCount increments with each call', async () => {
    expect(mock.callCount).toBe(0);
    await mock.complete(CHAT_REQ);
    expect(mock.callCount).toBe(1);
    await mock.complete(CHAT_REQ);
    expect(mock.callCount).toBe(2);
  });

  it('reset() clears fixtures, error flags, and call count', async () => {
    mock.setFixture('chat', 'Custom');
    mock.simulateRateLimit();
    await mock.complete(CHAT_REQ).catch(() => {});

    mock.reset();

    expect(mock.callCount).toBe(0);
    expect(mock.getLastRequest()).toBeNull();
    // After reset, rate limit is cleared — should succeed
    await expect(mock.complete(CHAT_REQ)).resolves.toBeTruthy();
    // After reset, fixture is cleared — should use default
    const result = await mock.complete(CHAT_REQ);
    expect(result.content).not.toBe('Custom');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('MockLLMProvider.stream()', () => {
  let mock: MockLLMProvider;
  beforeEach(() => { mock = new MockLLMProvider(); });

  it('yields chunks that combine to a non-empty string', async () => {
    const chunks: string[] = [];
    for await (const chunk of mock.stream(CHAT_REQ)) {
      chunks.push(chunk);
    }
    expect(chunks.join('')).toBeTruthy();
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('stream yields the fixture content word-by-word', async () => {
    mock.setFixture('chat', 'one two three');
    const chunks: string[] = [];
    for await (const chunk of mock.stream(CHAT_REQ)) {
      chunks.push(chunk);
    }
    expect(chunks.join('').trim()).toBe('one two three');
  });

  it('throws LLMRateLimitError on the first next() when simulateRateLimit()', async () => {
    mock.simulateRateLimit();
    const gen = mock.stream(CHAT_REQ);
    await expect(gen.next()).rejects.toThrow(LLMRateLimitError);
  });

  it('increments callCount for stream calls', async () => {
    for await (const _ of mock.stream(CHAT_REQ)) { /* consume */ }
    expect(mock.callCount).toBe(1);
  });
});
