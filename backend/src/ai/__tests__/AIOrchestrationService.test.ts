/**
 * src/ai/__tests__/AIOrchestrationService.test.ts
 *
 * Uses MockLLMProvider (tests/mocks/) — no real network calls.
 * Retry delays are set to [0, 0] so tests run instantly.
 */

import { AIOrchestrationService }   from '../AIOrchestrationService';
import { MockLLMProvider }           from '../../../tests/mocks/MockLLMProvider';
import { LLMRateLimitError, LLMStreamError, LLMTimeoutError, RATE_LIMIT_USER_MESSAGE }
  from '../llm/errors';
import type { OrchestrationRequest } from '../AIOrchestrationService';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_PROFILE = {
  displayName:    'Alice',
  timezone:       'UTC',
  commStyle:      'warm' as const,
  onboardingDone: true,
  contextSummary: null,
};

const CHAT_REQ: OrchestrationRequest = {
  mode:        'chat',
  messages:    [{ role: 'user', content: 'Hello' }],
  userProfile: BASE_PROFILE,
};

const ONBOARDING_REQ: OrchestrationRequest = {
  mode:        'onboarding',
  messages:    [{ role: 'user', content: 'Hi, just joined!' }],
  userProfile: { ...BASE_PROFILE, onboardingDone: false },
};

const _EXTRACTION_REQ: OrchestrationRequest = {
  mode:        'extraction',
  messages:    [{ role: 'user', content: 'I had a stressful day.' }],
  userProfile: BASE_PROFILE,
};

// Zero delays so tests run instantly
const FAST_OPTS = { retryDelays: [0, 0] as [number, number] };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a service with a fresh mock provider and instant retry delays. */
function makeService(mock = new MockLLMProvider()) {
  const service = new AIOrchestrationService(mock, FAST_OPTS);
  return { service, mock };
}

/** Captures console.log calls during a test. */
function captureConsoleLogs(fn: () => Promise<void>): Promise<unknown[]> {
  const logs: unknown[] = [];
  const orig = console.log;
  console.log = (...args) => logs.push(...args);
  return fn().then(
    () => { console.log = orig; return logs; },
    (err) => { console.log = orig; throw err; },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// complete() — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('AIOrchestrationService.complete() — success', () => {
  it('returns content and promptVersion on first attempt', async () => {
    const { service } = makeService();
    const result = await service.complete(CHAT_REQ);

    expect(result.content).toBeTruthy();
    expect(result.promptVersion).toMatch(/^chat_v/);
    expect(result.isFallback).toBe(false);
  });

  it('uses onboarding_v prompt version when mode is onboarding', async () => {
    const { service } = makeService();
    const result = await service.complete(ONBOARDING_REQ);
    expect(result.promptVersion).toMatch(/^onboarding_v/);
  });

  it('uses chat_v prompt when mode is chat and onboarding_done is true', async () => {
    const { service } = makeService();
    const result = await service.complete(CHAT_REQ);
    expect(result.promptVersion).toMatch(/^chat_v/);
  });

  it('uses onboarding_v prompt when mode is chat and onboarding_done is false', async () => {
    const { service } = makeService();
    const result = await service.complete({
      ...CHAT_REQ,
      userProfile: { ...BASE_PROFILE, onboardingDone: false },
    });
    expect(result.promptVersion).toMatch(/^onboarding_v/);
  });

  it('returns usage data', async () => {
    const { service } = makeService();
    const result = await service.complete(CHAT_REQ);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.cachedTokens).toBe(0);
  });

  it('calls the provider exactly once on success', async () => {
    const { service, mock } = makeService();
    await service.complete(CHAT_REQ);
    expect(mock.callCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// complete() — structured logging
// ─────────────────────────────────────────────────────────────────────────────

describe('AIOrchestrationService.complete() — structured logging', () => {
  it('emits a structured llm_call log on success', async () => {
    const { service } = makeService();

    const logs = await captureConsoleLogs(async () => {
      await service.complete(CHAT_REQ);
    });

    const callLog = logs
      .map((l) => JSON.parse(l as string))
      .find((l) => l.event === 'llm_call');

    expect(callLog).toBeDefined();
    expect(callLog.event).toBe('llm_call');
    expect(callLog.success).toBe(true);
    expect(callLog.prompt_version).toMatch(/^chat_v/);
    expect(typeof callLog.duration_ms).toBe('number');
    expect(typeof callLog.input_tokens).toBe('number');
    expect(typeof callLog.output_tokens).toBe('number');
    expect(typeof callLog.cached_tokens).toBe('number');
  });

  it('emits a structured llm_call log with success=false on failure', async () => {
    const mock = new MockLLMProvider();
    mock.simulateRateLimit();
    mock.simulateRateLimit(); // ensure 3 consecutive failures
    mock.simulateRateLimit();

    const provider: import('../llm/types').LLMProvider = {
      complete: jest.fn().mockRejectedValue(new LLMRateLimitError()),
      stream:   jest.fn(),
    };
    const service = new AIOrchestrationService(provider, FAST_OPTS);

    const logs = await captureConsoleLogs(async () => {
      await service.complete(CHAT_REQ);
    });

    const failLog = logs
      .map((l) => JSON.parse(l as string))
      .find((l) => l.event === 'llm_call' && l.success === false);

    expect(failLog).toBeDefined();
    expect(failLog.success).toBe(false);
    expect(failLog.error_code).toBe('LLMRateLimitError');
  });

  it('includes a timestamp in the log', async () => {
    const { service } = makeService();
    const logs = await captureConsoleLogs(async () => {
      await service.complete(CHAT_REQ);
    });
    const callLog = logs.map((l) => JSON.parse(l as string)).find((l) => l.event === 'llm_call');
    expect(callLog.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// complete() — retry logic (TDD P1-008)
// ─────────────────────────────────────────────────────────────────────────────

describe('AIOrchestrationService.complete() — retry logic', () => {
  it('retries on LLMRateLimitError and succeeds on the second attempt', async () => {
    const provider: import('../llm/types').LLMProvider = {
      complete: jest.fn()
        .mockRejectedValueOnce(new LLMRateLimitError())
        .mockResolvedValueOnce({
          content: 'Success on retry',
          usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0 },
          stop_reason: 'end_turn',
        }),
      stream: jest.fn(),
    };
    const service = new AIOrchestrationService(provider, FAST_OPTS);

    const result = await service.complete(CHAT_REQ);

    expect(result.content).toBe('Success on retry');
    expect(result.isFallback).toBe(false);
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it('retries on LLMStreamError (5xx) and succeeds on the third attempt', async () => {
    const provider: import('../llm/types').LLMProvider = {
      complete: jest.fn()
        .mockRejectedValueOnce(new LLMStreamError('503'))
        .mockRejectedValueOnce(new LLMStreamError('503'))
        .mockResolvedValueOnce({
          content: 'Finally succeeded',
          usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0 },
          stop_reason: 'end_turn',
        }),
      stream: jest.fn(),
    };
    const service = new AIOrchestrationService(provider, FAST_OPTS);

    const result = await service.complete(CHAT_REQ);

    expect(result.content).toBe('Finally succeeded');
    expect(provider.complete).toHaveBeenCalledTimes(3);
  });

  // ── The TDD-required test (TDD P1-008) ──────────────────────────────────────
  it('after 3 consecutive 429s: fails with LLMRateLimitError and returns the fallback message', async () => {
    const provider: import('../llm/types').LLMProvider = {
      complete: jest.fn()
        .mockRejectedValueOnce(new LLMRateLimitError())
        .mockRejectedValueOnce(new LLMRateLimitError())
        .mockRejectedValueOnce(new LLMRateLimitError()),
      stream: jest.fn(),
    };
    const service = new AIOrchestrationService(provider, FAST_OPTS);

    const result = await service.complete(CHAT_REQ);

    // Made exactly 3 calls (initial + 2 retries)
    expect(provider.complete).toHaveBeenCalledTimes(3);
    // Returned the user-facing fallback, not a thrown error
    expect(result.isFallback).toBe(true);
    expect(result.content).toBe(RATE_LIMIT_USER_MESSAGE);
    expect(result.content).toBe("I'm having a moment of quiet. Could you share that again?");
  });

  it('does NOT retry on LLMTimeoutError (already waited full timeout window)', async () => {
    const provider: import('../llm/types').LLMProvider = {
      complete: jest.fn().mockRejectedValue(new LLMTimeoutError()),
      stream: jest.fn(),
    };
    const service = new AIOrchestrationService(provider, FAST_OPTS);

    const result = await service.complete(CHAT_REQ);

    expect(provider.complete).toHaveBeenCalledTimes(1); // No retry
    expect(result.isFallback).toBe(true);
  });

  it('makes at most 3 total calls (initial + 2 retries, never more)', async () => {
    const provider: import('../llm/types').LLMProvider = {
      complete: jest.fn().mockRejectedValue(new LLMRateLimitError()),
      stream: jest.fn(),
    };
    const service = new AIOrchestrationService(provider, FAST_OPTS);

    await service.complete(CHAT_REQ);

    expect(provider.complete).toHaveBeenCalledTimes(3); // Hard cap
  });

  it('applies backoff delays between retries in the correct order', async () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    jest.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => {
      if (typeof ms === 'number' && ms > 0) delays.push(ms);
      return realSetTimeout(fn as Parameters<typeof setTimeout>[0], 0); // run immediately in tests
    });

    const provider: import('../llm/types').LLMProvider = {
      complete: jest.fn()
        .mockRejectedValueOnce(new LLMRateLimitError())
        .mockRejectedValueOnce(new LLMRateLimitError())
        .mockRejectedValueOnce(new LLMRateLimitError()),
      stream: jest.fn(),
    };
    // Use real (non-zero) delays to verify order
    const service = new AIOrchestrationService(provider, { retryDelays: [500, 1000] });

    await service.complete(CHAT_REQ);

    // Filter out the withTimeout timer (15 s default) — only keep retry-backoff delays
    const retryDelays = delays.filter((d) => d === 500 || d === 1000);
    expect(retryDelays[0]).toBe(500);
    expect(retryDelays[1]).toBe(1000);

    jest.restoreAllMocks();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// complete() — timeout enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe('AIOrchestrationService.complete() — timeout', () => {
  it('returns fallback when provider call exceeds timeoutMs', async () => {
    const provider: import('../llm/types').LLMProvider = {
      // Never resolves within the tiny timeout window
      complete: jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5_000)),
      ),
      stream: jest.fn(),
    };
    // Very short timeout so the test doesn't wait
    const service = new AIOrchestrationService(provider, {
      timeoutMs:   1,
      retryDelays: [0, 0],
    });

    const result = await service.complete(CHAT_REQ);

    expect(result.isFallback).toBe(true);
    expect(result.content).toBe(RATE_LIMIT_USER_MESSAGE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stream()
// ─────────────────────────────────────────────────────────────────────────────

describe('AIOrchestrationService.stream()', () => {
  it('yields tokens from the provider', async () => {
    const { service } = makeService();
    const chunks: string[] = [];

    for await (const chunk of service.stream(CHAT_REQ)) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBeTruthy();
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('yields the fallback message when provider throws LLMRateLimitError', async () => {
    const provider: import('../llm/types').LLMProvider = {
      complete: jest.fn(),
      stream:   jest.fn().mockImplementation(async function *() {
        yield ''; // satisfy require-yield; throw before consumer sees it
        throw new LLMRateLimitError();
      }),
    };
    const service = new AIOrchestrationService(provider, FAST_OPTS);
    const chunks: string[] = [];

    for await (const chunk of service.stream(CHAT_REQ)) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe(RATE_LIMIT_USER_MESSAGE);
  });

  it('yields the fallback message on LLMTimeoutError', async () => {
    const provider: import('../llm/types').LLMProvider = {
      complete: jest.fn(),
      stream:   jest.fn().mockImplementation(async function *() {
        yield ''; // satisfy require-yield; throw before consumer sees it
        throw new LLMTimeoutError();
      }),
    };
    const service = new AIOrchestrationService(provider, FAST_OPTS);
    const chunks: string[] = [];

    for await (const chunk of service.stream(CHAT_REQ)) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe(RATE_LIMIT_USER_MESSAGE);
  });

  it('re-throws LLMStreamError (mid-stream failure) for the SSE handler to catch', async () => {
    const provider: import('../llm/types').LLMProvider = {
      complete: jest.fn(),
      stream:   jest.fn().mockImplementation(async function *() {
        yield 'partial ';
        throw new LLMStreamError('Connection reset');
      }),
    };
    const service = new AIOrchestrationService(provider, FAST_OPTS);

    const gen = service.stream(CHAT_REQ);
    const first = await gen.next(); // 'partial '
    expect(first.value).toBe('partial ');

    await expect(gen.next()).rejects.toThrow(LLMStreamError);
  });

  it('emits a structured llm_call log after streaming completes', async () => {
    const { service } = makeService();
    const logs = await captureConsoleLogs(async () => {
      for await (const _ of service.stream(CHAT_REQ)) { /* consume */ }
    });

    const callLog = logs
      .map((l) => JSON.parse(l as string))
      .find((l) => l.event === 'llm_call');

    expect(callLog).toBeDefined();
    expect(callLog.success).toBe(true);
    expect(callLog.prompt_version).toMatch(/^chat_v/);
  });

  it('uses onboarding_v prompt when mode is onboarding', async () => {
    const { service } = makeService();
    const logs = await captureConsoleLogs(async () => {
      for await (const _ of service.stream(ONBOARDING_REQ)) { /* consume */ }
    });

    const callLog = logs
      .map((l) => JSON.parse(l as string))
      .find((l) => l.event === 'llm_call');

    expect(callLog.prompt_version).toMatch(/^onboarding_v/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt routing
// ─────────────────────────────────────────────────────────────────────────────

describe('AIOrchestrationService — prompt routing', () => {
  it('forces onboarding prompt when mode=onboarding even if onboarding_done=true', async () => {
    const { service, mock } = makeService();

    await service.complete({
      ...CHAT_REQ,
      mode:        'onboarding',
      userProfile: { ...BASE_PROFILE, onboardingDone: true }, // would normally get chat prompt
    });

    // The system prompt sent to the mock should contain onboarding language
    const req = mock.getLastRequest();
    const system = typeof req?.system === 'string' ? req.system : '';
    expect(system).toMatch(/meeting|first|new user/i);
  });

  it('passes the user\'s display_name into the system prompt', async () => {
    const { service, mock } = makeService();

    await service.complete({
      ...CHAT_REQ,
      userProfile: { ...BASE_PROFILE, displayName: 'TestUserName' },
    });

    const req = mock.getLastRequest();
    const system = typeof req?.system === 'string' ? req.system : '';
    expect(system).toContain('TestUserName');
  });

  it('includes context_summary in the system prompt when provided', async () => {
    const { service, mock } = makeService();

    await service.complete({
      ...CHAT_REQ,
      userProfile: {
        ...BASE_PROFILE,
        contextSummary: 'Alice is working on a startup and often feels overwhelmed.',
      },
    });

    const req = mock.getLastRequest();
    const system = typeof req?.system === 'string' ? req.system : '';
    expect(system).toContain('startup');
  });
});
