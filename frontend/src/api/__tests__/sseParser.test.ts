/**
 * src/api/__tests__/sseParser.test.ts
 *
 * Tests for parseSSE(). Uses real ReadableStream (available in Vitest's jsdom env).
 */

import { describe, it, expect } from 'vitest';
import { parseSSE } from '../sseParser';

// ── Helpers ────────────────────────────────────────────────────────────────────

const ENC = new TextEncoder();

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(ENC.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const frames = [];
  for await (const f of parseSSE(stream)) {
    frames.push(f);
  }
  return frames;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('parseSSE', () => {
  it('parses a single token event', async () => {
    const raw = 'id: 1\nevent: token\ndata: {"delta":"Hello"}\n\n';
    const frames = await collect(makeStream([raw]));

    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('token');
    expect(frames[0].data).toBe('{"delta":"Hello"}');
    expect(frames[0].id).toBe('1');
  });

  it('parses a done event', async () => {
    const raw = 'event: done\ndata: {"message_id":"m-1","emotion_tags":{"primary":"calm","score":0.8}}\n\n';
    const frames = await collect(makeStream([raw]));

    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('done');
    const payload = JSON.parse(frames[0].data);
    expect(payload.message_id).toBe('m-1');
    expect(payload.emotion_tags.primary).toBe('calm');
  });

  it('parses an error event', async () => {
    const raw = 'event: error\ndata: {"code":"LLM_STREAM_ERROR"}\n\n';
    const frames = await collect(makeStream([raw]));

    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('error');
    expect(JSON.parse(frames[0].data).code).toBe('LLM_STREAM_ERROR');
  });

  it('parses an LLM_TIMEOUT error event', async () => {
    const raw = 'event: error\ndata: {"code":"LLM_TIMEOUT"}\n\n';
    const frames = await collect(makeStream([raw]));

    expect(frames[0].event).toBe('error');
    expect(JSON.parse(frames[0].data).code).toBe('LLM_TIMEOUT');
  });

  it('parses multiple frames from a single chunk', async () => {
    const raw =
      'id: 1\nevent: token\ndata: {"delta":"Hi"}\n\n' +
      'id: 2\nevent: token\ndata: {"delta":" there"}\n\n' +
      'event: done\ndata: {"message_id":"m-1","emotion_tags":{"primary":"joy","score":0.9}}\n\n';

    const frames = await collect(makeStream([raw]));

    expect(frames).toHaveLength(3);
    expect(frames[0].event).toBe('token');
    expect(frames[1].event).toBe('token');
    expect(frames[2].event).toBe('done');
  });

  it('correctly reassembles a frame split across two chunks', async () => {
    const part1 = 'event: token\n';
    const part2 = 'data: {"delta":"split"}\n\n';

    const frames = await collect(makeStream([part1, part2]));

    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('token');
    expect(JSON.parse(frames[0].data).delta).toBe('split');
  });

  it('correctly reassembles when the frame boundary (\\n\\n) is split across chunks', async () => {
    const part1 = 'event: token\ndata: {"delta":"x"}\n';
    const part2 = '\n'; // completes the double-newline

    const frames = await collect(makeStream([part1, part2]));

    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('token');
  });

  it('skips comment lines (starting with :)', async () => {
    const raw = ': keep-alive\n\nevent: token\ndata: {"delta":"y"}\n\n';
    const frames = await collect(makeStream([raw]));

    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('token');
  });

  it('skips empty frames', async () => {
    const raw = '\n\nevent: token\ndata: {"delta":"z"}\n\n\n\n';
    const frames = await collect(makeStream([raw]));

    expect(frames).toHaveLength(1);
  });

  it('handles \\r\\n line endings (Windows / some proxies)', async () => {
    const raw = 'event: token\r\ndata: {"delta":"crlf"}\r\n\r\n';
    const frames = await collect(makeStream([raw]));

    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0].data).delta).toBe('crlf');
  });

  it('yields no frames for an empty stream', async () => {
    const frames = await collect(makeStream([]));
    expect(frames).toHaveLength(0);
  });

  it('yields no frames for a stream with only comments', async () => {
    const frames = await collect(makeStream([': ping\n\n: ping\n\n']));
    expect(frames).toHaveLength(0);
  });

  it('releases the reader lock when the stream ends normally', async () => {
    const stream = makeStream(['event: done\ndata: {"message_id":"x","emotion_tags":{"primary":"calm","score":0.5}}\n\n']);
    const reader = stream.getReader();
    reader.releaseLock();
    const frames = await collect(stream);
    expect(frames).toHaveLength(1);
  });

  it('parses many rapid token frames correctly', async () => {
    const words = ['The', ' quick', ' brown', ' fox'];
    const raw = words
      .map((w, i) => `id: ${i + 1}\nevent: token\ndata: {"delta":"${w}"}\n\n`)
      .join('');

    const frames = await collect(makeStream([raw]));

    expect(frames).toHaveLength(4);
    const reconstructed = frames.map((f) => JSON.parse(f.data).delta).join('');
    expect(reconstructed).toBe('The quick brown fox');
  });
});
