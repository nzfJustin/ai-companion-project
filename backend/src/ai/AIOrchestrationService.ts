/**
 * src/ai/AIOrchestrationService.ts
 *
 * Central orchestration layer for every LLM call in the application.
 * All code that wants an AI response goes through this service — never
 * directly to the LLMProvider or the Anthropic SDK.
 *
 * Responsibilities (TDD P1-008):
 *   - Select and assemble the versioned system prompt (via P1-12 selectPrompt)
 *   - Wrap every provider call with retry logic, timeout enforcement, and
 *     structured log emission
 *   - Return the user-facing fallback message when all retries are exhausted
 *     (rather than letting rate-limit errors propagate to route handlers)
 *   - Expose both complete() and stream() for non-streaming and SSE use-cases
 *
 * Retry policy (TDD P1-008):
 *   - Retryable errors: LLMRateLimitError (429) and LLMStreamError (5xx)
 *   - Max 2 retries → up to 3 total attempts
 *   - Exponential backoff before each retry: [1 s, 2 s] (configurable for tests)
 *   - LLMTimeoutError is NOT retried (we already exhausted the per-call timeout)
 *   - After all retries fail: return RATE_LIMIT_USER_MESSAGE as content
 *
 * Timeout policy:
 *   - A 15-second hard limit is applied to every complete() call
 *   - stream() timeout is handled at the SSE layer (P1-18) because we can
 *     not easily abort an async generator mid-iteration here
 */

import type { LLMProvider, CompletionRequest, Message }  from './llm/types';
import {
  LLMRateLimitError,
  LLMStreamError,
  LLMTimeoutError,
  RATE_LIMIT_USER_MESSAGE,
} from './llm/errors';
import type { PromptContext } from './prompts/index';
import { selectPrompt }      from './prompts/index';
import { log, warn } from '../lib/logger';

// Default model name logged with every LLM call.  When the provider
// abstraction supports multiple models, pass it through CompletionRequest.
const DEFAULT_LLM_MODEL = 'claude-sonnet-4-6';

// ─── Public types ─────────────────────────────────────────────────────────────

/** Profile fields the orchestration layer needs to assemble the prompt. */
export interface UserProfileForOrchestration {
  displayName:    string;
  timezone:       string;
  commStyle:      PromptContext['comm_style'];
  onboardingDone: boolean;
  contextSummary: string | null;
}

/**
 * Input to every orchestration call.
 *
 * `mode` determines which prompt variant is used:
 *   'chat'        — standard conversation (selectPrompt routes to
 *                   ONBOARDING_PROMPT if onboarding_done = false)
 *   'extraction'  — memory extraction after a conversation closes
 *   'onboarding'  — forced onboarding prompt regardless of flag
 */
export interface OrchestrationRequest {
  mode:        'chat' | 'extraction' | 'onboarding';
  messages:    Message[];
  userProfile: UserProfileForOrchestration;
}

export interface OrchestrationResponse {
  content:       string;
  promptVersion: string;
  usage: {
    inputTokens:  number;
    outputTokens: number;
    cachedTokens: number;
  };
  /**
   * True when the response is the user-facing fallback message because all
   * LLM attempts failed. The caller may use this flag to skip DB persistence
   * of the response (there is no real AI message to store).
   */
  isFallback: boolean;
}

// ─── Service options (injected for testability) ───────────────────────────────

export interface AIOrchestrationServiceOptions {
  /** Maximum number of retries after an initial failure. Default: 2 */
  maxRetries?: number;
  /** Per-call timeout in milliseconds. Default: 15 000 (15 s) */
  timeoutMs?: number;
  /**
   * Delay in ms before each retry attempt.
   * Index 0 = delay before retry 1, index 1 = delay before retry 2.
   * Default: [1000, 2000]
   * Tests pass [0, 0] to eliminate real waiting.
   */
  retryDelays?: [number, number];
}

const DEFAULT_OPTIONS: Required<AIOrchestrationServiceOptions> = {
  maxRetries:  2,
  timeoutMs:   15_000,
  retryDelays: [1_000, 2_000],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Races a promise against a timeout.
 * Throws LLMTimeoutError if the timeout fires first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new LLMTimeoutError(`LLM call timed out after ${ms}ms`)),
      ms,
    ),
  );
  return Promise.race([promise, timeout]);
}

/** Writes a structured LLM log line via the shared logger. */
function logLLMCall(fields: {
  prompt_version:  string;
  llm_model:       string;
  input_tokens?:   number;
  output_tokens?:  number;
  cached_tokens?:  number;
  duration_ms:     number;
  success:         boolean;
  attempt:         number;
  error_code?:     string;
}): void {
  log({ event: 'llm_call', ...fields });
}

/** Returns true for errors that are worth retrying. */
function isRetryable(err: unknown): boolean {
  return err instanceof LLMRateLimitError || err instanceof LLMStreamError;
}

// ─── AIOrchestrationService ───────────────────────────────────────────────────

export class AIOrchestrationService {
  private readonly opts: Required<AIOrchestrationServiceOptions>;

  constructor(
    private readonly provider: LLMProvider,
    options: AIOrchestrationServiceOptions = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  // ─── complete() ─────────────────────────────────────────────────────────────
  // For extraction, onboarding, and any non-streamed response.

  async complete(req: OrchestrationRequest): Promise<OrchestrationResponse> {
    const { prompt, system } = this.buildPrompt(req);
    const llmRequest: CompletionRequest = {
      system,
      messages:       req.messages,
      prompt_version: prompt.version,
    };

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      // Back off before each retry (not before the first attempt)
      if (attempt > 0) {
        await sleep(this.opts.retryDelays[attempt - 1] ?? 0);
      }

      const startedAt = Date.now();

      try {
        const response = await withTimeout(
          this.provider.complete(llmRequest),
          this.opts.timeoutMs,
        );

        logLLMCall({
          prompt_version: prompt.version,
          llm_model:      DEFAULT_LLM_MODEL,
          input_tokens:   response.usage.input_tokens,
          output_tokens:  response.usage.output_tokens,
          cached_tokens:  response.usage.cached_tokens,
          duration_ms:    Date.now() - startedAt,
          success:        true,
          attempt,
        });

        return {
          content:       response.content,
          promptVersion: prompt.version,
          usage: {
            inputTokens:  response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            cachedTokens: response.usage.cached_tokens,
          },
          isFallback: false,
        };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        lastError = err;

        const retriesLeft = attempt < this.opts.maxRetries;
        const willRetry   = isRetryable(err) && retriesLeft;

        logLLMCall({
          prompt_version: prompt.version,
          llm_model:      DEFAULT_LLM_MODEL,
          duration_ms:    durationMs,
          success:        false,
          attempt,
          error_code:     err instanceof Error ? err.name : 'UnknownError',
        });

        // LLMTimeoutError: don't retry (we already waited the full window)
        if (err instanceof LLMTimeoutError || !willRetry) {
          break;
        }

        // Retryable error with retries remaining — loop continues
      }
    }

    // All attempts failed — return the user-facing fallback so the message
    // endpoint can stream it to the client without special error handling.
    warn({
      event:     'llm_call_exhausted',
      llm_model: DEFAULT_LLM_MODEL,
      error:     lastError instanceof Error ? lastError.message : String(lastError),
    });

    return {
      content:       RATE_LIMIT_USER_MESSAGE,
      promptVersion: prompt.version,
      usage:         { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      isFallback:    true,
    };
  }

  // ─── stream() ───────────────────────────────────────────────────────────────
  // For the chat SSE endpoint (P1-18). Streams tokens as they arrive.
  //
  // Retry semantics for streaming are limited: we cannot replay tokens
  // already sent to the client. We attempt the stream once; on a rate-limit
  // error before the first token, we yield the fallback message instead of
  // propagating the error (keeping the SSE connection clean). Mid-stream
  // errors are re-thrown so the SSE handler can send an event: error frame.

  async *stream(req: OrchestrationRequest): AsyncGenerator<string> {
    const { prompt, system } = this.buildPrompt(req);
    const llmRequest: CompletionRequest = {
      system,
      messages:       req.messages,
      prompt_version: prompt.version,
    };

    const startedAt = Date.now();

    try {
      const gen = this.provider.stream(llmRequest);

      for await (const chunk of gen) {
        yield chunk;
      }

      logLLMCall({
        prompt_version: prompt.version,
        llm_model:      DEFAULT_LLM_MODEL,
        duration_ms:    Date.now() - startedAt,
        success:        true,
        attempt:        0,
      });
    } catch (err) {
      logLLMCall({
        prompt_version: prompt.version,
        llm_model:      DEFAULT_LLM_MODEL,
        duration_ms:    Date.now() - startedAt,
        success:        false,
        attempt:        0,
        error_code:     err instanceof Error ? err.name : 'UnknownError',
      });

      if (err instanceof LLMRateLimitError || err instanceof LLMTimeoutError) {
        // Before the first token — yield the fallback message so the SSE
        // handler can forward it to the client cleanly
        yield RATE_LIMIT_USER_MESSAGE;
        return;
      }

      // Mid-stream error or unexpected — re-throw so SSE handler sends
      // event: error
      throw err;
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────────

  private buildPrompt(req: OrchestrationRequest): {
    prompt: ReturnType<typeof selectPrompt>;
    system: string;
  } {
    const ctx: PromptContext = {
      display_name:    req.userProfile.displayName,
      timezone:        req.userProfile.timezone,
      comm_style:      req.userProfile.commStyle,
      context_summary: req.userProfile.contextSummary,
      onboarding_done: req.userProfile.onboardingDone,
    };

    // selectPrompt() handles all mode routing:
    //   'extraction' → ONBOARDING_EXTRACTION_PROMPT (static, ignores ctx)
    //   'onboarding' → ONBOARDING_PROMPT (always, ignores onboarding_done flag)
    //   'chat'       → CHAT_PROMPT or ONBOARDING_PROMPT based on ctx.onboarding_done
    const prompt = selectPrompt(ctx, req.mode);
    const system = prompt.system(ctx);

    return { prompt, system };
  }
}
