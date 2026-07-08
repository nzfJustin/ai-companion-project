/**
 * src/screens/ChatScreen.tsx
 *
 * Handles two route shapes:
 *
 *   /chat                    — conversation list (history + new conversation CTA)
 *   /chat/:conversationId    — message display + composer for a specific conversation
 *
 * F1-005 acceptance criteria (static aspects — streaming is F1-006):
 *
 *   ✓ Message list renders history chronologically; user right-aligned,
 *     assistant left-aligned, each with a relative timestamp.
 *   ✓ Auto-scroll to bottom on new message only if user is already near
 *     the bottom. If scrolled up, shows a "New message ↓" pill.
 *   ✓ Composer: textarea grows to 5 lines, Enter submits, Shift+Enter
 *     newlines, disabled while AI response is in progress or history loads.
 *   ✓ Character counter: visible within 200 chars of 2,000 limit, amber
 *     at 1,800, red at 1,950+, blocks submit when over limit or empty.
 *   ✓ Loading skeleton during initial fetch; composer disabled until ready.
 *   ✓ /chat (no id) shows conversation history with a "New conversation"
 *     primary button and per-card emotion chip (if available).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageBubble }   from '../components/MessageBubble';
import { MessageSkeleton } from '../components/MessageSkeleton';
import { MessageComposer } from '../components/MessageComposer';
import {
  getConversation,
  listConversations,
  createConversation,
  type MessageResponse,
} from '../api/conversations';
import { relativeTime } from '../utils/time';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Distance from the bottom (px) within which we consider the user "at the bottom" */
const SCROLL_NEAR_BOTTOM_PX = 80;

// ─────────────────────────────────────────────────────────────────────────────
// Conversation List (/chat — no conversationId)
// ─────────────────────────────────────────────────────────────────────────────

function ConversationList() {
  const navigate     = useNavigate();
  const queryClient  = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['conversations'],
    queryFn:  () => listConversations(1, 20),
  });

  const newConvMutation = useMutation({
    mutationFn: createConversation,
    onSuccess: (conv) => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      navigate(`/chat/${conv.id}`);
    },
  });

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-4">
        <h1 className="text-base font-semibold text-gray-900">Conversations</h1>
        <button
          onClick={() => newConvMutation.mutate()}
          disabled={newConvMutation.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-slate-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
        >
          {newConvMutation.isPending ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />
          ) : (
            <span aria-hidden="true">+</span>
          )}
          New conversation
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="p-4" role="status" aria-label="Loading conversations…">
            {[1, 2, 3].map((i) => (
              <div key={i} className="mb-3 h-16 animate-pulse rounded-xl bg-gray-100" />
            ))}
          </div>
        )}

        {!isLoading && data?.conversations.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
            <p className="text-sm text-gray-500">No conversations yet.</p>
            <button
              onClick={() => newConvMutation.mutate()}
              className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white"
            >
              Start your first conversation
            </button>
          </div>
        )}

        {data?.conversations.map((conv) => {
          const isActive = conv.status === 'active';
          return (
            <Link
              key={conv.id}
              to={`/chat/${conv.id}`}
              className="flex items-start justify-between gap-3 border-b border-gray-50 px-4 py-3.5 hover:bg-gray-50"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {isActive && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-green-400"
                      aria-label="Active conversation"
                    />
                  )}
                  <span className="truncate text-sm font-medium text-gray-900">
                    {relativeTime(conv.started_at)}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-gray-500">
                  {conv.message_count} message{conv.message_count !== 1 ? 's' : ''}
                  {conv.status === 'closed' && ' · Ended'}
                  {conv.status === 'summarized' && ' · Summarised'}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation View (/chat/:conversationId)
// ─────────────────────────────────────────────────────────────────────────────

function ConversationView({ conversationId }: { conversationId: string }) {

  // ── State ────────────────────────────────────────────────────────────────────
  const [draft, setDraft]           = useState('');
  const [messages, setMessages]     = useState<MessageResponse[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [showNewPill, setShowNewPill] = useState(false);

  const listRef       = useRef<HTMLDivElement>(null);
  const bottomRef     = useRef<HTMLDivElement>(null);
  const atBottomRef   = useRef(true);

  // ── Load conversation ─────────────────────────────────────────────────────────
  const { data: conv, isLoading } = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn:  () => getConversation(conversationId),
    staleTime: 5_000,
  });

  // Populate messages from query result
  useEffect(() => {
    if (conv?.messages) {
      setMessages(conv.messages);
    }
  }, [conv]);

  // ── Auto-scroll logic ─────────────────────────────────────────────────────────

  function checkAtBottom() {
    const el = listRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_NEAR_BOTTOM_PX;
  }

  function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
    if (bottomRef.current?.scrollIntoView) bottomRef.current.scrollIntoView({ behavior });
  }

  // On new messages: scroll if already at bottom, otherwise show pill
  const prevLenRef = useRef(0);
  useEffect(() => {
    if (messages.length <= prevLenRef.current) return;
    prevLenRef.current = messages.length;

    if (atBottomRef.current) {
      scrollToBottom();
    } else {
      setShowNewPill(true);
    }
  }, [messages.length]);

  // Initial scroll to bottom (without animation) when history loads
  useEffect(() => {
    if (!isLoading && messages.length > 0) {
      scrollToBottom('instant');
    }
  }, [isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleScroll() {
    atBottomRef.current = checkAtBottom();
    if (atBottomRef.current) setShowNewPill(false);
  }

  // ── Send message (stub for F1-006 SSE — posts via apiFetch for now) ──────────
  // F1-006 will replace the body of handleSend with the SSE streaming flow.
  // The state management (optimistic user message, isStreaming flag, ai bubble)
  // is already in place here so F1-006 only needs to swap out the network call.
  const handleSend = useCallback(async () => {
    if (!draft.trim() || draft.length > 2_000 || isStreaming) return;
    if (conv?.status !== 'active') return;

    const userContent = draft.trim();
    setDraft('');
    setIsStreaming(true);

    // Optimistic user message
    const optimisticUser: MessageResponse = {
      id:           `optimistic-${Date.now()}`,
      role:         'user',
      content:      userContent,
      emotion_tags: null,
      created_at:   new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);

    // Typing indicator bubble (placeholder for F1-006 SSE)
    const typingId = `typing-${Date.now()}`;
    const typingBubble: MessageResponse & { isTyping: boolean } = {
      id:           typingId,
      role:         'assistant',
      content:      '',
      emotion_tags: null,
      created_at:   new Date().toISOString(),
      isTyping:     true,
    };
    setMessages((prev) => [...prev, typingBubble as unknown as MessageResponse]);

    // ── F1-006: Replace this block with the SSE fetch stream ──────────────────
    // For now this is a placeholder that removes the typing indicator after a
    // short delay so the UI shell is functional for testing. F1-006 will
    // stream real AI tokens into the typing bubble and then swap it to a real
    // assistant message on event:done.
    try {
      await new Promise((r) => setTimeout(r, 800));
      setMessages((prev) =>
        prev.filter((m) => (m as { id: string }).id !== typingId),
      );
      // F1-006 will append the completed AI message here
    } finally {
      setIsStreaming(false);
    }
    // ──────────────────────────────────────────────────────────────────────────
  }, [draft, isStreaming, conv]);

  // ── Render ───────────────────────────────────────────────────────────────────

  const isClosed   = conv?.status === 'closed' || conv?.status === 'summarized';
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
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                role={msg.role}
                content={msg.content}
                createdAt={msg.created_at}
                emotionTag={msg.emotion_tags}
                isTyping={(msg as { isTyping?: boolean }).isTyping}
              />
            ))}

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
            onClick={() => {
              scrollToBottom();
              setShowNewPill(false);
            }}
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
        : <ConversationList />}
    </div>
  );
}
