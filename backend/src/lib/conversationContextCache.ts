/**
 * src/lib/conversationContextCache.ts
 *
 * Redis-backed context-window cache for the message-streaming endpoint
 * (P1-014). Extracted out of conversations.router.ts so messagesStream.ts's
 * background stream driver and conversations.router.ts's request handler
 * can both use it without duplicating the Redis pipeline logic.
 *
 *   Key:  conv_ctx:{conversationId}
 *   Type: Redis LIST of JSON strings — { role, content (decrypted) }
 *   TTL:  30 minutes, reset on every write
 *   Size: trimmed to the most recent MAX_CONTEXT_MSGS entries after each append
 *
 * All functions fail soft: a Redis error never rejects the caller — the
 * context cache is an optimisation, not a dependency for the message
 * endpoint to function (DB fallback covers a cache miss).
 */

import { redis } from './redis';
import type { Message } from '../ai/llm/types';

const CONTEXT_TTL_SEC  = 30 * 60; // 30 minutes
const MAX_CONTEXT_MSGS = 20;

const ctxKey = (conversationId: string) => `conv_ctx:${conversationId}`;

/**
 * Seeds an empty-but-existing context list right after a conversation is
 * created, so the first message's context read hits an intentional cache
 * HIT (an empty window) instead of falling back to a (trivially empty
 * anyway) DB query. Redis auto-deletes empty lists, so this pushes then
 * immediately trims away a placeholder entry to force the key to exist.
 */
export async function initContextCache(conversationId: string): Promise<void> {
  try {
    await redis
      .pipeline()
      .rpush(ctxKey(conversationId), JSON.stringify({ _init: true }))
      .ltrim(ctxKey(conversationId), 1, 0) // immediately empty the list
      .expire(ctxKey(conversationId), CONTEXT_TTL_SEC)
      .exec();
  } catch {
    /* non-fatal — the first real message just falls back to the DB */
  }
}

/**
 * Reads the cached context window for a conversation.
 * Returns `null` on a cache miss (key absent/empty or Redis error) so the
 * caller knows to fall back to a DB query — NOT an empty array, which
 * would be indistinguishable from a genuinely-empty, cache-HIT window.
 */
export async function getContextWindow(conversationId: string): Promise<Message[] | null> {
  try {
    const entries = await redis.lrange(ctxKey(conversationId), 0, -1);
    if (entries.length === 0) return null;
    return entries.map((e) => JSON.parse(e) as Message);
  } catch {
    return null;
  }
}

/**
 * Repopulates the cache after a DB-fallback read, so subsequent messages
 * in the same conversation hit the cache again. Fire-and-forget — never
 * throws.
 */
export async function repopulateContextCache(
  conversationId: string,
  messages:       Message[],
): Promise<void> {
  if (messages.length === 0) return;
  try {
    const pipe = redis.pipeline().del(ctxKey(conversationId));
    for (const m of messages) {
      pipe.rpush(ctxKey(conversationId), JSON.stringify(m));
    }
    await pipe.expire(ctxKey(conversationId), CONTEXT_TTL_SEC).exec();
  } catch {
    /* non-fatal */
  }
}

/**
 * Appends a single message (user or assistant) to the cache, trimming to
 * the most recent MAX_CONTEXT_MSGS entries and refreshing the TTL.
 * Fire-and-forget — never throws.
 */
export async function appendToContextCache(
  conversationId: string,
  entry:          Message,
): Promise<void> {
  try {
    await redis
      .pipeline()
      .rpush(ctxKey(conversationId), JSON.stringify(entry))
      .ltrim(ctxKey(conversationId), -MAX_CONTEXT_MSGS, -1)
      .expire(ctxKey(conversationId), CONTEXT_TTL_SEC)
      .exec();
  } catch {
    /* non-fatal */
  }
}
