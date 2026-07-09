/**
 * src/screens/ConversationHistoryScreen.tsx
 *
 * F1-007 · Conversation History Screen
 *
 * This doubles as the home screen for returning users. Acceptance criteria:
 *
 *   ✓ "New conversation" primary button at the top
 *   ✓ Active conversation (status: "active") pinned above the list with a
 *     live green dot; tapping it resumes with the composer enabled
 *   ✓ Past conversations in chronological order, most recent first
 *   ✓ Each card shows: start date/time, message count, and — when memory
 *     extraction is complete — the dominant_emotion as a coloured chip
 *   ✓ When extraction is still in progress (status: "closed", memory not yet
 *     written), the card shows a "Summarizing…" indicator instead
 *   ✓ "Load more" button fetches the next page (20 at a time)
 *   ✓ Empty state for users with no conversations
 *
 * Data strategy:
 *   Two parallel queries run on mount:
 *     - listConversations(page, 20)  → conversation list
 *     - listMemories({ perPage: 100 }) → first 100 memories (enough for
 *       the history viewport; each conversation produces at most one memory)
 *   The results are cross-referenced by conversation_id so each summarized
 *   conversation card can show its emotion chip without additional per-card
 *   fetches. The memory list refreshes with the same staleTime so newly
 *   completed extractions appear on the next query cycle.
 */

import { useState, useMemo, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listConversations,
  createConversation,
  type ConversationResponse,
} from '../api/conversations';
import { listMemories, type MemoryListItem } from '../api/memories';
import { conversationDate } from '../utils/time';

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

// ─── Emotion chip colours ─────────────────────────────────────────────────────
// Matches the palette used in MessageBubble for visual consistency.

const EMOTION_COLOURS: Record<string, string> = {
  joy:        'bg-yellow-50  text-yellow-700  ring-yellow-100',
  calm:       'bg-teal-50    text-teal-700    ring-teal-100',
  anxiety:    'bg-orange-50  text-orange-700  ring-orange-100',
  sadness:    'bg-blue-50    text-blue-700    ring-blue-100',
  anger:      'bg-red-50     text-red-700     ring-red-100',
  excitement: 'bg-purple-50  text-purple-700  ring-purple-100',
};

function emotionClasses(emotion: string): string {
  return EMOTION_COLOURS[emotion.toLowerCase()] ??
    'bg-gray-50 text-gray-600 ring-gray-100';
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function EmotionChip({ emotion }: { emotion: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${emotionClasses(emotion)}`}
    >
      {emotion}
    </span>
  );
}

function SummarizingChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-50 px-2 py-0.5 text-[11px] text-gray-400 ring-1 ring-inset ring-gray-100">
      <span
        className="h-1 w-1 animate-pulse rounded-full bg-gray-300"
        aria-hidden="true"
      />
      Summarizing…
    </span>
  );
}

function ConversationCard({
  conv,
  memory,
}: {
  conv:   ConversationResponse;
  memory: MemoryListItem | undefined;
}) {
  const isActive     = conv.status === 'active';
  const isClosed     = conv.status === 'closed';
  const isSummarized = conv.status === 'summarized';

  return (
    <Link
      to={`/chat/${conv.id}`}
      className={`
        flex items-start justify-between gap-3 border-b border-gray-50 px-4 py-3.5
        transition-colors hover:bg-gray-50/80
        ${isActive ? 'bg-green-50/30' : ''}
      `}
      aria-label={`Conversation from ${conversationDate(conv.started_at)}`}
    >
      {/* Left: date + count */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {isActive && (
            <span
              className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-green-400"
              aria-label="Active conversation"
            />
          )}
          <span className="truncate text-sm font-medium text-gray-900">
            {conversationDate(conv.started_at)}
          </span>
        </div>

        <p className="mt-0.5 text-xs text-gray-400">
          {conv.message_count} {conv.message_count === 1 ? 'message' : 'messages'}
        </p>
      </div>

      {/* Right: status chip */}
      <div className="shrink-0 pt-0.5">
        {isActive && (
          <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700 ring-1 ring-inset ring-green-100">
            Active
          </span>
        )}

        {isClosed && <SummarizingChip />}

        {isSummarized && memory?.dominant_emotion && (
          <EmotionChip emotion={memory.dominant_emotion} />
        )}
      </div>
    </Link>
  );
}

function SkeletonCard() {
  return (
    <div className="flex items-center gap-3 border-b border-gray-50 px-4 py-3.5">
      <div className="flex-1 space-y-2">
        <div className="h-3.5 w-32 animate-pulse rounded bg-gray-100" />
        <div className="h-2.5 w-16 animate-pulse rounded bg-gray-100" />
      </div>
      <div className="h-5 w-14 animate-pulse rounded-full bg-gray-100" />
    </div>
  );
}

// ─── ConversationHistoryScreen ────────────────────────────────────────────────

export function ConversationHistoryScreen() {
  const navigate    = useNavigate();
  const queryClient = useQueryClient();

  // Pagination state — accumulate pages client-side
  const [page, setPage] = useState(1);
  const [accumulated, setAccumulated] = useState<ConversationResponse[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // ── Initial fetch (page 1) ────────────────────────────────────────────────
  const { isLoading: convLoading } = useQuery({
    queryKey: ['conversations', 1],
    queryFn: async () => {
      const data = await listConversations(1, PAGE_SIZE);
      setAccumulated(data.conversations);
      setHasMore(data.has_more);
      return data;
    },
    staleTime: 30_000,
  });

  // ── Parallel memory fetch — needed for emotion chips ──────────────────────
  // Fetch the first 100 memories (enough to cover a typical conversation
  // history viewport). The query is keyed the same way so it updates
  // whenever conversations are invalidated.
  const { data: memoryData } = useQuery({
    queryKey: ['memories-for-history'],
    queryFn:  () => listMemories({ perPage: 100 }),
    staleTime: 30_000,
  });

  // Index memories by conversation_id for O(1) card lookups
  const memoryByConvId = useMemo(() => {
    const map = new Map<string, MemoryListItem>();
    for (const mem of memoryData?.memories ?? []) {
      if (mem.conversation_id) map.set(mem.conversation_id, mem);
    }
    return map;
  }, [memoryData]);

  // ── New conversation ──────────────────────────────────────────────────────
  const newConvMutation = useMutation({
    mutationFn: createConversation,
    onSuccess: (conv) => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['memories-for-history'] });
      navigate(`/chat/${conv.id}`);
    },
  });

  // ── Load more ─────────────────────────────────────────────────────────────
  const handleLoadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    try {
      const nextPage = page + 1;
      const data = await listConversations(nextPage, PAGE_SIZE);
      setAccumulated((prev) => [...prev, ...data.conversations]);
      setHasMore(data.has_more);
      setPage(nextPage);
    } finally {
      setIsLoadingMore(false);
    }
  }, [page, hasMore, isLoadingMore]);

  // ── Split active vs past ──────────────────────────────────────────────────
  // Active conversation is pinned above the list per spec.
  // There should only ever be one active conversation at a time.
  const activeConv = accumulated.find((c) => c.status === 'active');
  const pastConvs  = accumulated.filter((c) => c.status !== 'active');

  const isEmpty = !convLoading && accumulated.length === 0;

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ── */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-4">
        <h1 className="text-base font-semibold text-gray-900">Conversations</h1>
        <button
          onClick={() => newConvMutation.mutate()}
          disabled={newConvMutation.isPending}
          aria-label="Start new conversation"
          className="
            flex items-center gap-1.5 rounded-lg bg-slate-700
            px-3 py-1.5 text-sm font-medium text-white
            transition-opacity disabled:cursor-not-allowed disabled:opacity-60
          "
        >
          {newConvMutation.isPending ? (
            <span
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
              aria-hidden="true"
            />
          ) : (
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
              <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
            </svg>
          )}
          New conversation
        </button>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto">
        {/* Loading skeleton */}
        {convLoading && (
          <div role="status" aria-label="Loading conversations…">
            {[1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}
          </div>
        )}

        {/* Empty state */}
        {isEmpty && (
          <div className="flex flex-col items-center justify-center gap-4 px-6 py-20 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6 text-gray-400" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 9.75a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">No conversations yet</p>
              <p className="mt-1 text-xs text-gray-400">Start your first conversation to begin.</p>
            </div>
            <button
              onClick={() => newConvMutation.mutate()}
              disabled={newConvMutation.isPending}
              className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              Start your first conversation
            </button>
          </div>
        )}

        {/* Active conversation — pinned above the list */}
        {activeConv && (
          <>
            <div className="px-4 pt-3 pb-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Active
              </p>
            </div>
            <ConversationCard
              conv={activeConv}
              memory={memoryByConvId.get(activeConv.id)}
            />
            {pastConvs.length > 0 && (
              <div className="px-4 pt-3 pb-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  Past
                </p>
              </div>
            )}
          </>
        )}

        {/* Past conversations */}
        {pastConvs.map((conv) => (
          <ConversationCard
            key={conv.id}
            conv={conv}
            memory={memoryByConvId.get(conv.id)}
          />
        ))}

        {/* Load more */}
        {hasMore && (
          <div className="flex justify-center py-4">
            <button
              onClick={handleLoadMore}
              disabled={isLoadingMore}
              className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-60"
            >
              {isLoadingMore ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" aria-hidden="true" />
                  Loading…
                </>
              ) : (
                'Load more'
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
