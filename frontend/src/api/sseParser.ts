/**
 * src/api/sseParser.ts
 *
 * Parses Server-Sent Events from a browser ReadableStream<Uint8Array>.
 *
 * The native EventSource API cannot send custom headers (no Authorization),
 * so we must read the response body as a ReadableStream and parse the SSE
 * wire format ourselves. This module is the only place that touches the
 * raw bytes — every caller just iterates the yielded frames.
 *
 * SSE wire format (RFC / WHATWG):
 *   id: <id>\n
 *   event: <type>\n
 *   data: <payload>\n
 *   \n                  ← blank line terminates the frame
 *
 * Comments (lines starting with ':') and empty frames are skipped.
 *
 * Usage:
 *   for await (const frame of parseSSE(response.body)) {
 *     if (frame.event === 'token') { ... }
 *   }
 */

export interface SseFrame {
  /** Event type; defaults to "message" when the event: field is absent */
  event: string;
  /** The raw data string from the data: field */
  data: string;
  /** The id: field value, if present */
  id?: string;
}

/**
 * Reads chunks from a ReadableStream, reassembles them into SSE frames
 * delimited by double-newlines, and yields each parsed frame.
 *
 * Handles frames split across multiple chunks correctly by maintaining a
 * carry buffer between reads.
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader  = stream.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      // Accumulate — { stream: true } tells TextDecoder this is a streaming
      // decode so it won't emit a replacement char for a partial multi-byte
      // sequence that might span chunk boundaries.
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by blank lines (\n\n or \r\n\r\n).
      // We normalise to \n first for simplicity.
      buffer = buffer.replace(/\r\n/g, '\n');

      const frames = buffer.split('\n\n');
      // The last element is either empty (frame ended cleanly) or a
      // partial frame — keep it in the buffer for the next chunk.
      buffer = frames.pop() ?? '';

      for (const raw of frames) {
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }

    // Process any trailing content after the stream closes
    if (buffer.trim()) {
      const frame = parseFrame(buffer);
      if (frame) yield frame;
    }
  } finally {
    // Always release the lock so the response body can be GC'd
    reader.releaseLock();
  }
}

// ─── Frame parser ─────────────────────────────────────────────────────────────

function parseFrame(raw: string): SseFrame | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith(':')) return null; // comment or empty

  let event = 'message';
  let data  = '';
  let id: string | undefined;

  for (const line of trimmed.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // Spec allows multiple data: lines; concatenate with \n
      data = data ? `${data}\n${line.slice(5).trim()}` : line.slice(5).trim();
    } else if (line.startsWith('id:')) {
      id = line.slice(3).trim();
    }
    // 'retry:' lines are intentionally ignored (no reconnect logic needed)
  }

  // Only emit if there is meaningful content
  if (!data && event === 'message') return null;
  return { event, data, id };
}
