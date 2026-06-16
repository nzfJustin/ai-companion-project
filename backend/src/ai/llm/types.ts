/**
 * src/ai/llm/types.ts
 *
 * Provider-agnostic LLM types. All AI features talk to this interface —
 * never to the Anthropic SDK or any other vendor SDK directly.
 */

// ─── Message ──────────────────────────────────────────────────────────────────

export interface Message {
  role:    'user' | 'assistant';
  content: string;
}

// ─── System prompt blocks ─────────────────────────────────────────────────────

/**
 * A text block with optional Anthropic prompt-cache control.
 * Used to mark PERSONA and BEHAVIORAL GUARDRAILS blocks as cacheable
 * so they are not re-encoded on every request (P2-07).
 */
export interface SystemBlock {
  type:  'text';
  text:  string;
  cache_control?: { type: 'ephemeral' };
}

// ─── Request ──────────────────────────────────────────────────────────────────

export interface CompletionRequest {
  /** Conversation history — most recent message last */
  messages:    Message[];

  /**
   * System prompt.
   *   - string:        simple prompt, no caching
   *   - SystemBlock[]: blocks with optional cache_control (Phase 2+)
   */
  system?:     string | SystemBlock[];

  /** Override the provider's default model */
  model?:      string;

  /** Max tokens to generate (default: provider-specific) */
  max_tokens?: number;

  /**
   * Opaque version string logged with every call for observability.
   * Format: "<context>_v<major>.<minor>.<patch>" e.g. "chat_v1.0.0"
   */
  prompt_version?: string;
}

// ─── Response ─────────────────────────────────────────────────────────────────

export interface TokenUsage {
  input_tokens:  number;
  output_tokens: number;
  /** Tokens served from the provider's prompt cache (0 if not cached) */
  cached_tokens: number;
}

export interface CompletionResponse {
  /** The assistant's full response text */
  content:      string;
  usage:        TokenUsage;
  stop_reason?: string;
}

// ─── Provider interface ───────────────────────────────────────────────────────

/**
 * Core LLM abstraction.
 *
 * Implementations:
 *   AnthropicProvider  — production (src/ai/llm/AnthropicProvider.ts)
 *   MockLLMProvider    — tests       (tests/mocks/MockLLMProvider.ts)
 *
 * Retry / timeout / structured logging are handled by AIOrchestrationService
 * (P1-13) — NOT by the provider. The provider's only responsibility is
 * making the vendor call and mapping vendor errors to our error types.
 */
export interface LLMProvider {
  /**
   * Single-shot completion — for extractions, onboarding, report generation.
   *
   * @throws {LLMRateLimitError}  Provider returned 429
   * @throws {LLMTimeoutError}    Network / read timeout
   * @throws {LLMStreamError}     Any other provider error
   */
  complete(req: CompletionRequest): Promise<CompletionResponse>;

  /**
   * Streaming completion — for chat messages (SSE).
   * Yields text delta strings as they arrive from the provider.
   *
   * @throws {LLMRateLimitError}  Provider returned 429 (before first chunk)
   * @throws {LLMTimeoutError}    Network / read timeout
   * @throws {LLMStreamError}     Mid-stream error
   */
  stream(req: CompletionRequest): AsyncIterable<string>;
}
