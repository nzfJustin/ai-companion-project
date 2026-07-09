/**
 * src/screens/ChatScreen.tsx
 *
 * Handles two route shapes:
 *
 *   /chat                    — conversation list (history + new conversation CTA)
 *   /chat/:conversationId    — message display + composer for a specific conversation
 *
 * F1-005 acceptance criteria (static aspects):
 *   ✓ Message list renders history chronologically; user right-aligned,
 *     assistant left-aligned, each with a relative timestamp.
 *   ✓ Auto-scroll to bottom on new message only if user is already near bottom.
 *     If scrolled up, shows a "New message ↓" pill.
 *   ✓ Composer: textarea grows to 5 lines, Enter submits, Shift+Enter newlines,
 *     disabled while AI response is in progress or history loads.
 *   ✓ Character counter within 200 chars of 2,000 limit (amber → red).
 *   ✓ Loading skeleton during initial fetch; composer disabled until ready.
 *
 * F1-006 acceptance criteria (SSE streaming):
 *   ✓ Sends via fetch with Authorization: Bearer <token> — NOT EventSource.
 *   ✓ Three-dot typing indicator appears before first token; replaced token
 *     by token as event:token frames arrive (data.delta appended in real time).
 *   ✓ event:done → finalises AI bubble with real message_id + emotion pill,
 *     composer re-enables.
 *   ✓ event:error (LLM_STREAM_ERROR / LLM_TIMEOUT) → removes bubble, shows
 *     inline error "Couldn't get a response — please try again", restores
 *     original message in the input.
 *   ✓ Network drop (fetch abort) → same error recovery path as event:error.
 *   ✓ User's message is never lost — it was persisted by the backend before
 *     the stream began.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MessageBubble }   from '../components/MessageBubble';
import { MessageSkeleton } from '../components/MessageSkeleton';
import { MessageComposer } from '../components/MessageComposer';
import { ConversationHistoryScreen } from './ConversationHistoryScreen';
import {
  getConversation,
  type MessageResponse,
} from '../api/conversations';
import { parseSSE }       from '../api/sseParser';
import { API_BASE_URL }   from '../api/config';
import { getAccessToken } from '../store/authStore';

// ─── Constants ────────────────────────────────────────────────────────────────

const SCROLL_NEAR_BOTTOM_PX = 80;

// ─── Streaming state ──────────────────────────────────────────────────────────
// Kept separate from the messages array so the list of "real" messages stays
// clean; the streaming bubble is appended to the rendered list only.

interface StreamBubble {
  /** Temporary client-side ID while the stream is in progress */
  id:       string;
  /** Accumulated text from event:token frames so far */
  content:  string;
  /** True until the first token arrives; renders the three-dot indicator */
  isTyping: boolean;
}

// ConversationList is now ConversationHistoryScreen (see src/screens/ConversationHistoryScreen.tsx)

// ─────────────────────────────────────────────────────────────────────────────
// Conversation View (/chat/:conversationId)
// ─────────────────────────────────────────────────────────────────────────────

function ConversationView({ conversationId }: { conversationId: string }) {
  // ── State ────────────────────────────────────────────────────────────────────
  const [draft,        setDraft]        = useState('');
  const [messages,     setMessages]     = useState<MessageResponse[]>([]);
  const [streamBubble, setStreamBubble] = useState<StreamBubble | null>(null);
  const [streamError,  setStreamError]  = useState<string | null>(null);
  const [isStreaming,  setIsStreaming]   = useState(false);
  const [showNewPill,  setShowNewPill]  = useState(false);

  const listRef     = useRef<HTMLDivElement>(null);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // ── Load conversation ──────────────────────────────────────────────────────
  const { data: conv, isLoading } = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn:  () => getConversation(conversationId),
    staleTime: 5_000,
  });

  useEffect(() => {
    if (conv?.messages) setMessages(conv.messages);
  }, [conv]);

  // ── Auto-scroll ───────────────────────────────────────────────────────────

  function checkAtBottom() {
    const el = listRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_NEAR_BOTTOM_PX;
  }

  function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
    if (bottomRef.current?.scrollIntoView) bottomRef.current.scrollIntoView({ behavior });
  }

  const prevLenRef = useRef(0);
  useEffect(() => {
    if (messages.length <= prevLenRef.current) return;
    prevLenRef.current = messages.length;
    if (atBottomRef.current) scrollToBottom();
    else setShowNewPill(true);
  }, [messages.length]);

  useEffect(() => {
    if (!isLoading && messages.length > 0) scrollToBottom('instant');
  }, [isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleScroll() {
    atBottomRef.current = checkAtBottom();
    if (atBottomRef.current) setShowNewPill(false);
  }

  // ── Send message — SSE streaming (F1-006) ─────────────────────────────────
  //
  // Uses fetch + ReadableStream to parse SSE frames from the backend.
  // EventSource is intentionally NOT used here: it cannot send custom headers,
  // so the Authorization: Bearer token cannot be attached.
  //
  // Frame handling:
  //   event:token  → accumulate delta into streamBubble
  //   event:done   → move streamBubble into messages[], show emotion pill
  //   event:error  → remove streamBubble, show inline error, restore draft
  //   fetch error  → same recovery path as event:error

  const handleSend = useCallback(async () => {
    if (!draft.trim() || draft.length > 2_000 || isStreaming) return;
    if (conv?.status !== 'active') return;

    const userContent = draft.trim();
    setDraft('');
    setStreamError(null);
    setIsStreaming(true);

    // 1. Optimistic user message (backend already persisted it before streaming)
    setMessages((prev) => [
      ...prev,
      {
        id:           `optimistic-${Date.now()}`,
        role:         'user',
        content:      userContent,
        emotion_tags: null,
        created_at:   new Date().toISOString(),
      },
    ]);

    // 2. Show typing indicator bubble immediately (before first token)
    const tempId = `typing-${Date.now()}`;
    setStreamBubble({ id: tempId, content: '', isTyping: true });

    let accumulated = '';

    try {
      // ── Fetch — Authorization header injected manually (can't use apiFetch
      //    here because we need raw ReadableStream access, not parsed JSON) ──
      const token = getAccessToken();
      const response = await fetch(
        `${API_BASE_URL}/v1/conversations/${conversationId}/messages`,
        {
          method:      'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ content: userContent }),
        },
      );

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      // ── Parse SSE frames ──────────────────────────────────────────────────
      for await (const frame of parseSSE(response.body)) {
        if (frame.event === 'token') {
          const { delta } = JSON.parse(frame.data) as { delta: string };
          accumulated += delta;
          // Replace typing indicator with accumulating content
          setStreamBubble({ id: tempId, content: accumulated, isTyping: false });

        } else if (frame.event === 'done') {
          const done = JSON.parse(frame.data) as {
            message_id:   string;
            emotion_tags: { primary: string; score: number };
          };
          // Move the completed message into the persistent list
          setMessages((prev) => [
            ...prev,
            {
              id:           done.message_id,
              role:         'assistant',
              content:      accumulated,
              emotion_tags: done.emotion_tags,
              created_at:   new Date().toISOString(),
            },
          ]);
          setStreamBubble(null);
          return; // success — finally still runs

        } else if (frame.event === 'error') {
          const { code } = JSON.parse(frame.data) as { code: string };
          throw new Error(code); // caught below → error recovery path
        }
      }

      // Stream ended without a done event — treat as an error
      throw new Error('LLM_STREAM_ERROR');

    } catch {
      // ── Error recovery (covers event:error AND network drops) ──────────────
      // Per spec: remove the incomplete AI bubble, show an inline notice, and
      // restore the user's original message in the composer input.
      // The user's message is NOT removed — it was already persisted by the
      // backend before the stream began.
      setStreamBubble(null);
      setStreamError("Couldn't get a response — please try again.");
      setDraft(userContent);

    } finally {
      setIsStreaming(false);
    }
  }, [draft, isStreaming, conv, conversationId]);

  // ── Render ────────────────────────────────────────────────────────────────

  const isClosed         = conv?.status === 'closed' || conv?.status === 'summarized';
  const composerDisabled = isLoading || isClosed;

  return (
    <div className="flex h-full flex-col">
      {/* Message list */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto"
        onScroll={handleScroll}
      >
        {isLoading ? (
          <MessageSkeleton />
        ) : (
          <div className="flex flex-col gap-4 px-4 py-4">
            {/* Persisted messages */}
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                role={msg.role}
                content={msg.content}
                createdAt={msg.created_at}
                emotionTag={msg.emotion_tags}
              />
            ))}

            {/* In-progress streaming bubble (three-dot then accumulating text) */}
            {streamBubble && (
              <MessageBubble
                role="assistant"
                content={streamBubble.content}
                createdAt={new Date().toISOString()}
                isTyping={streamBubble.isTyping}
              />
            )}

            {/* Inline stream error notice */}
            {streamError && (
              <p
                role="alert"
                className="py-2 text-center text-sm text-red-500"
              >
                {streamError}
              </p>
            )}

            {/* Closed conversation notice */}
            {isClosed && (
              <p className="py-4 text-center text-xs text-gray-400">
                This conversation has ended.
              </p>
            )}

            {/* Scroll anchor */}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* "New message" jump pill */}
      {showNewPill && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2">
          <button
            onClick={() => { scrollToBottom(); setShowNewPill(false); }}
            className="flex items-center gap-1.5 rounded-full bg-slate-700 px-3 py-1.5 text-xs font-medium text-white shadow-md"
          >
            New message ↓
          </button>
        </div>
      )}

      {/* Composer */}
      {!isClosed && (
        <MessageComposer
          value={draft}
          onChange={setDraft}
          onSubmit={handleSend}
          disabled={composerDisabled}
          isStreaming={isStreaming}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ChatScreen — route switcher
// ─────────────────────────────────────────────────────────────────────────────

export function ChatScreen() {
  const { conversationId } = useParams<{ conversationId?: string }>();

  return (
    <div className="relative flex h-full flex-col">
      {conversationId
        ? <ConversationView conversationId={conversationId} />
        : <ConversationHistoryScreen />}
    </div>
  );
}
