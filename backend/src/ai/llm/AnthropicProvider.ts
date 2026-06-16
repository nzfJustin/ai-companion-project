/**
 * src/ai/llm/AnthropicProvider.ts
 *
 * Production LLMProvider backed by Anthropic's Messages API.
 *
 * ⚠️  This is the ONLY file in the codebase that may import the Anthropic SDK.
 *     All other code interacts with the LLMProvider interface.
 *
 * Responsibilities:
 *   - Make the HTTP call (complete + stream)
 *   - Map Anthropic error types to our error types
 *   - Nothing else — retry logic, timeouts, and logging all live in
 *     AIOrchestrationService (P1-13)
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, CompletionRequest, CompletionResponse, SystemBlock } from './types';
import { LLMRateLimitError, LLMTimeoutError, LLMStreamError } from './errors';

// ─── Defaults ─────────────────────────────────────────────────────────────────

/** Default model used unless CompletionRequest.model overrides it. */
const DEFAULT_MODEL      = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 1_024;

// ─── Internal type for the Anthropic client ───────────────────────────────────
// Typed minimally so tests can inject a mock without importing the SDK.

interface AnthropicMessages {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  stream(params: Anthropic.MessageStreamParams): AsyncIterable<Anthropic.RawMessageStreamEvent>;
}

interface AnthropicClient {
  messages: AnthropicMessages;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  private readonly client: AnthropicClient;

  /**
   * @param options.apiKey  Overrides ANTHROPIC_API_KEY env var
   * @param options.client  Inject a mock client (for tests only)
   */
  constructor(options?: { apiKey?: string; client?: AnthropicClient }) {
    this.client =
      options?.client ??
      new Anthropic({ apiKey: options?.apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  // ─── complete ───────────────────────────────────────────────────────────────

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    try {
      const message = await this.client.messages.create({
        model:      req.model ?? DEFAULT_MODEL,
        max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
        messages:   req.messages,
        system:     this.toAnthropicSystem(req.system),
      });

      const content = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return {
        content,
        usage: {
          input_tokens:  message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
          cached_tokens: (message.usage as unknown as Record<string, number>)['cache_read_input_tokens'] ?? 0,
        },
        stop_reason: message.stop_reason ?? undefined,
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  // ─── stream ─────────────────────────────────────────────────────────────────

  async *stream(req: CompletionRequest): AsyncGenerator<string> {
    let streamIterable: AsyncIterable<Anthropic.RawMessageStreamEvent>;

    try {
      streamIterable = this.client.messages.stream({
        model:      req.model ?? DEFAULT_MODEL,
        max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
        messages:   req.messages,
        system:     this.toAnthropicSystem(req.system),
      });
    } catch (err) {
      // Error before any stream events (e.g. immediate 429 / bad request)
      throw this.mapError(err);
    }

    try {
      for await (const event of streamIterable) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield event.delta.text;
        }
      }
    } catch (err) {
      // Mid-stream error
      throw this.mapError(err);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Converts our system-prompt type to what the Anthropic SDK expects.
   * A plain string passes through unchanged; SystemBlock[] is passed as-is
   * (the SDK accepts TextBlockParam[] with the same shape).
   */
  private toAnthropicSystem(
    system: CompletionRequest['system'],
  ): string | Anthropic.TextBlockParam[] | undefined {
    if (!system) return undefined;
    if (typeof system === 'string') return system;
    // SystemBlock matches Anthropic.TextBlockParam structurally
    return system as unknown as Anthropic.TextBlockParam[];
  }

  /**
   * Maps Anthropic SDK errors to our error types.
   * Never leaks vendor-specific errors to callers.
   */
  private mapError(err: unknown): LLMRateLimitError | LLMTimeoutError | LLMStreamError {
    if (err instanceof Anthropic.RateLimitError) {
      return new LLMRateLimitError(err.message);
    }
    // SDK throws APIConnectionTimeoutError or APITimeoutError depending on version
    if (
      err instanceof Anthropic.APIConnectionTimeoutError ||
      (err instanceof Anthropic.APIError && err.status === 408)
    ) {
      return new LLMTimeoutError(err.message);
    }
    if (err instanceof Error) {
      return new LLMStreamError(err.message);
    }
    return new LLMStreamError(String(err));
  }
}
