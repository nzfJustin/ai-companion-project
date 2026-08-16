/**
 * src/lib/streamSessionRegistry.ts
 *
 * Supports SSE reconnection via the Last-Event-ID header (TDD P1-013).
 *
 * The AI response generation runs as a background "job" independent of
 * any single HTTP connection — exactly as the spec frames it: "the server
 * resumes from the last sent token if the AI response job is still in
 * progress." A StreamSession buffers every token emitted so far (each
 * with an incrementing numeric ID used as the SSE `id:` field) and lets
 * any number of HTTP responses attach to it over time:
 *
 *   1. Replay all buffered tokens with id > Last-Event-ID
 *   2. Then forward new tokens live as they arrive
 *   3. Until a terminal 'done' or 'error' event fires
 *
 * This is explicitly an in-memory buffer, not Redis or DB-backed (per the
 * TDD: "simple replay from an in-memory buffer, not DB replay"). It does
 * not survive a server restart — an acceptable Phase 1 tradeoff since a
 * restart mid-stream is rare and the user can simply send a new message.
 *
 * Completed sessions are retained for SESSION_RETENTION_MS to serve a
 * final reconnect race (e.g. the done event and a reconnect attempt
 * crossing in flight), then garbage collected automatically.
 *
 * Token IDs are 1-indexed (not 0). This lets `Last-Event-ID: 0` (or an
 * absent header, defaulted to 0) unambiguously mean "I have seen nothing
 * yet" without colliding with a real token's id.
 */

import { EventEmitter } from 'node:events';
import type { EmotionTag } from '../services/EmotionDetector';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BufferedToken {
  id:    number;
  delta: string;
}

export interface DoneMeta {
  messageId:   string;
  emotionTags: EmotionTag;
  /** True when the onboarding conversation was closed server-side after the
   *  user confirmed "jump to chat". The frontend navigates to /chat on receipt. */
  onboardingComplete?: boolean;
}

export interface ErrorMeta {
  code: 'LLM_STREAM_ERROR' | 'LLM_TIMEOUT';
}

// ─── StreamSession ────────────────────────────────────────────────────────────

export class StreamSession extends EventEmitter {
  readonly conversationId: string;

  private tokens: BufferedToken[] = [];
  private nextId = 1;

  status: 'in_progress' | 'done' | 'error' = 'in_progress';
  doneMeta?:  DoneMeta;
  errorMeta?: ErrorMeta;

  constructor(conversationId: string) {
    super();
    this.conversationId = conversationId;
    // Multiple reconnect attempts + the original connection could all
    // attach across the session's lifetime — raise the default cap of 10
    // to avoid spurious MaxListenersExceededWarning noise.
    this.setMaxListeners(50);
    // Node's EventEmitter special-cases the string 'error': emitting it
    // with zero listeners attached throws synchronously and crashes the
    // process. The background driver can legitimately call finishError()
    // before any HTTP response has attached (client hasn't connected yet,
    // or reconnected after a drop) — a permanent no-op listener makes
    // 'error' behave like any other named event here, never fatal. Real
    // listeners added later via attachToSession still fire normally
    // alongside this one.
    this.on('error', () => { /* prevents EventEmitter's unhandled-'error' crash */ });
  }

  /** Records a token in the buffer and emits it to any live listeners. */
  pushToken(delta: string): BufferedToken {
    const token = { id: this.nextId++, delta };
    this.tokens.push(token);
    this.emit('token', token);
    return token;
  }

  finishDone(meta: DoneMeta): void {
    this.status   = 'done';
    this.doneMeta = meta;
    this.emit('done', meta);
  }

  finishError(meta: ErrorMeta): void {
    this.status    = 'error';
    this.errorMeta = meta;
    this.emit('error', meta);
  }

  /** Returns every buffered token with id strictly greater than lastEventId. */
  tokensAfter(lastEventId: number): BufferedToken[] {
    return this.tokens.filter((t) => t.id > lastEventId);
  }

  get lastTokenId(): number {
    return this.tokens.length > 0 ? this.tokens[this.tokens.length - 1].id : 0;
  }
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const SESSION_RETENTION_MS = 2 * 60 * 1000; // 2 minutes after completion

const registry = new Map<string, StreamSession>();

/**
 * Creates and registers a new session for a conversation, replacing any
 * prior (necessarily completed, or abandoned) session for the same ID.
 */
export function createSession(conversationId: string): StreamSession {
  const session = new StreamSession(conversationId);
  registry.set(conversationId, session);

  const scheduleCleanup = () => {
    const timer = setTimeout(() => {
      if (registry.get(conversationId) === session) {
        registry.delete(conversationId);
      }
    }, SESSION_RETENTION_MS);
    timer.unref?.(); // don't keep the process alive just for cleanup
  };

  session.once('done',  scheduleCleanup);
  session.once('error', scheduleCleanup);

  return session;
}

export function getSession(conversationId: string): StreamSession | undefined {
  return registry.get(conversationId);
}

/** Test-only helper to reset state between test cases. */
export function clearAllSessions(): void {
  registry.clear();
}
