/**
 * src/ai/llm/__tests__/AnthropicProvider.test.ts
 *
 * Unit tests for AnthropicProvider.
 *
 * Strategy: inject a mock Anthropic client via the constructor so no
 * network call is ever made. The mock matches the minimal interface
 * used by the provider (messages.create + messages.stream).
 *
 * This test file DOES import from @anthropic-ai/sdk to reference error
 * classes (Anthropic.RateLimitError etc.), but only for constructing
 * them in mock throws — it never creates a real Anthropic client.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider } from '../AnthropicProvider';
import {
  LLMRateLimitError,
  LLMTimeoutError,
  LLMStreamError,
} from '../errors';
import type { CompletionRequest } from '../types';

// ─── Mock client factory ──────────────────────────────────────────────────────

function makeAnthropicMessage(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id:           'msg_test',
    type:         'message',
    role:         'assistant',
    model:        'claude-sonnet-4-6',
    stop_reason:  'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text: 'Hello world' }],
    usage: {
      input_tokens:  50,
      output_tokens: 10,
    } as unknown as Anthropic.Usage,
    ...overrides,
  };
}

async function* makeStreamEvents(
  text: string,
): AsyncIterable<Anthropic.RawMessageStreamEvent> {
  yield {
    type:    'message_start',
    message: {
      id: 'msg_stream', type: 'message', role: 'assistant',
      model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null,
      content: [],
      usage: {
        input_tokens: 40, output_tokens: 0,
      } as unknown as Anthropic.Usage,
    },
  };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  yield {
    type:  'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  };
  yield { type: 'content_block_stop', index: 0 };
  yield {
    type:  'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 8 },
  };
  yield { type: 'message_stop' };
}

interface MockAnthropicMessages {
  create: jest.Mock;
  stream: jest.Mock;
}

function makeClient(
  mockMessages?: Partial<MockAnthropicMessages>,
): { messages: MockAnthropicMessages } {
  return {
    messages: {
      create: jest.fn().mockResolvedValue(makeAnthropicMessage()),
      stream: jest.fn().mockReturnValue(makeStreamEvents('streamed text')),
      ...mockMessages,
    },
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_REQ: CompletionRequest = {
  messages:       [{ role: 'user', content: 'Hello' }],
  system:         'You are a helpful assistant.',
  prompt_version: 'chat_v1.0.0',
};

// ─────────────────────────────────────────────────────────────────────────────
// complete()
// ─────────────────────────────────────────────────────────────────────────────

describe('AnthropicProvider.complete()', () => {
  it('calls client.messages.create with the right params', async () => {
    const client   = makeClient();
    const provider = new AnthropicProvider({ client: client as never });

    await provider.complete(BASE_REQ);

    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        messages:   BASE_REQ.messages,
        system:     BASE_REQ.system,
      }),
    );
  });

  it('uses a custom model when req.model is provided', async () => {
    const client   = makeClient();
    const provider = new AnthropicProvider({ client: client as never });

    await provider.complete({ ...BASE_REQ, model: 'claude-haiku-4-5-20251001' });

    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
    );
  });

  it('returns { content, usage } from the API response', async () => {
    const apiMessage = makeAnthropicMessage({
      content: [{ type: 'text', text: 'The answer is 42.' }],
      usage: {
        input_tokens:  80,
        output_tokens: 15,
        cache_read_input_tokens: 25,
      } as unknown as Anthropic.Usage,
    });
    const client   = makeClient({ create: jest.fn().mockResolvedValue(apiMessage) });
    const provider = new AnthropicProvider({ client: client as never });

    const result = await provider.complete(BASE_REQ);

    expect(result.content).toBe('The answer is 42.');
    expect(result.usage).toEqual({
      input_tokens:  80,
      output_tokens: 15,
      cached_tokens: 25,  // maps cache_read_input_tokens → cached_tokens
    });
  });

  it('concatenates multiple text blocks into a single content string', async () => {
    const apiMessage = makeAnthropicMessage({
      content: [
        { type: 'text', text: 'Part one. ' },
        { type: 'text', text: 'Part two.' },
      ],
    });
    const client   = makeClient({ create: jest.fn().mockResolvedValue(apiMessage) });
    const provider = new AnthropicProvider({ client: client as never });

    const result = await provider.complete(BASE_REQ);

    expect(result.content).toBe('Part one. Part two.');
  });

  it('defaults cached_tokens to 0 when cache_read_input_tokens is absent', async () => {
    const apiMessage = makeAnthropicMessage({
      usage: {
        input_tokens:  50,
        output_tokens: 10,
        cache_read_input_tokens: undefined,
      } as unknown as Anthropic.Usage,
    });
    const client   = makeClient({ create: jest.fn().mockResolvedValue(apiMessage) });
    const provider = new AnthropicProvider({ client: client as never });

    const result = await provider.complete(BASE_REQ);

    expect(result.usage.cached_tokens).toBe(0);
  });

  it('maps Anthropic.RateLimitError → LLMRateLimitError', async () => {
    const client = makeClient({
      create: jest.fn().mockRejectedValue(new Anthropic.RateLimitError(429, undefined, 'Rate limited', undefined as never)),
    });
    const provider = new AnthropicProvider({ client: client as never });

    await expect(provider.complete(BASE_REQ)).rejects.toThrow(LLMRateLimitError);
  });

  it('maps Anthropic.APIConnectionTimeoutError → LLMTimeoutError', async () => {
    const client = makeClient({
      create: jest.fn().mockRejectedValue(
        new Anthropic.APIConnectionTimeoutError({} as never),
      ),
    });
    const provider = new AnthropicProvider({ client: client as never });

    await expect(provider.complete(BASE_REQ)).rejects.toThrow(LLMTimeoutError);
  });

  it('maps any other Error → LLMStreamError', async () => {
    const client = makeClient({
      create: jest.fn().mockRejectedValue(new Error('Internal server error')),
    });
    const provider = new AnthropicProvider({ client: client as never });

    await expect(provider.complete(BASE_REQ)).rejects.toThrow(LLMStreamError);
  });

  it('does not leak Anthropic-specific error types to callers', async () => {
    const client = makeClient({
      create: jest.fn().mockRejectedValue(new Anthropic.RateLimitError(429, undefined, 'Rate limited', undefined as never)),
    });
    const provider = new AnthropicProvider({ client: client as never });

    try {
      await provider.complete(BASE_REQ);
    } catch (err) {
      expect(err).toBeInstanceOf(LLMRateLimitError);
      expect(err).not.toBeInstanceOf(Anthropic.RateLimitError);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stream()
// ─────────────────────────────────────────────────────────────────────────────

describe('AnthropicProvider.stream()', () => {
  it('yields text delta chunks from the stream', async () => {
    const client   = makeClient({ stream: jest.fn().mockReturnValue(makeStreamEvents('hello world')) });
    const provider = new AnthropicProvider({ client: client as never });

    const chunks: string[] = [];
    for await (const chunk of provider.stream(BASE_REQ)) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe('hello world');
  });

  it('calls client.messages.stream with the right params', async () => {
    const client   = makeClient({ stream: jest.fn().mockReturnValue(makeStreamEvents('hi')) });
    const provider = new AnthropicProvider({ client: client as never });

    for await (const _ of provider.stream(BASE_REQ)) { /* consume */ }

    expect(client.messages.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        messages:   BASE_REQ.messages,
        system:     BASE_REQ.system,
      }),
    );
  });

  it('yields only text_delta events (skips other event types)', async () => {
    async function* mixedEvents(): AsyncIterable<Anthropic.RawMessageStreamEvent> {
      yield { type: 'message_start', message: { id: 'x', type: 'message', role: 'assistant', model: 'x', stop_reason: null, stop_sequence: null, content: [], usage: { input_tokens: 0, output_tokens: 0 } as unknown as Anthropic.Usage } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'chunk1' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'chunk2' } };
      yield { type: 'message_stop' };
    }

    const client   = makeClient({ stream: jest.fn().mockReturnValue(mixedEvents()) });
    const provider = new AnthropicProvider({ client: client as never });

    const chunks: string[] = [];
    for await (const chunk of provider.stream(BASE_REQ)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['chunk1', 'chunk2']);
  });

  it('maps Anthropic.RateLimitError → LLMRateLimitError during stream setup', async () => {
    const client = makeClient({
      stream: jest.fn().mockImplementation(() => {
        throw new Anthropic.RateLimitError(429, undefined, 'Rate limited', undefined as never);
      }),
    });
    const provider = new AnthropicProvider({ client: client as never });

    const gen = provider.stream(BASE_REQ);
    await expect(gen.next()).rejects.toThrow(LLMRateLimitError);
  });

  it('maps mid-stream errors → LLMStreamError', async () => {
    async function* failingStream(): AsyncIterable<Anthropic.RawMessageStreamEvent> {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } };
      throw new Error('Connection reset');
    }

    const client   = makeClient({ stream: jest.fn().mockReturnValue(failingStream()) });
    const provider = new AnthropicProvider({ client: client as never });

    const gen = provider.stream(BASE_REQ);
    await gen.next(); // consume the 'partial' chunk

    await expect(gen.next()).rejects.toThrow(LLMStreamError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// System prompt handling
// ─────────────────────────────────────────────────────────────────────────────

describe('AnthropicProvider — system prompt handling', () => {
  it('passes a plain string system prompt through unchanged', async () => {
    const client   = makeClient();
    const provider = new AnthropicProvider({ client: client as never });

    await provider.complete({ ...BASE_REQ, system: 'Be concise.' });

    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ system: 'Be concise.' }),
    );
  });

  it('passes SystemBlock[] (for prompt caching) to the SDK', async () => {
    const client   = makeClient();
    const provider = new AnthropicProvider({ client: client as never });

    const systemBlocks = [
      { type: 'text' as const, text: 'Persona block', cache_control: { type: 'ephemeral' as const } },
      { type: 'text' as const, text: 'Context block' },
    ];

    await provider.complete({ ...BASE_REQ, system: systemBlocks });

    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ system: systemBlocks }),
    );
  });

  it('passes undefined system prompt when none is provided', async () => {
    const client   = makeClient();
    const provider = new AnthropicProvider({ client: client as never });

    const { system: _, ...reqWithoutSystem } = BASE_REQ;
    await provider.complete(reqWithoutSystem);

    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ system: undefined }),
    );
  });
});
