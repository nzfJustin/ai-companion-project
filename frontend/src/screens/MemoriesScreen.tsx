/**
 * src/screens/MemoriesScreen.tsx
 *
 * F1-008 · Memory List Screen
 *
 * Acceptance criteria:
 *   ✓ Paginated list (20/page), ordered created_at DESC
 *   ✓ Each card: title, level badge (L1–L5 distinct colors), emotion chip,
 *     date range (period_start → period_end)
 *   ✓ Level 4–5 cards: lock icon + badge + title only — emotion chip hidden
 *     (title is the only "content" shown; everything else is protected)
 *   ✓ Filter bar: level multi-select chips (1–5, all default) + date range
 *     picker — state synced to URL (?level=1,2,3&from=…&to=…) for deep-links
 *   ✓ Filter changes re-fetch from page 1 and REPLACE results
 *   ✓ "Load more" appends the next page with current filters preserved
 *   ✓ Contextual empty state with a "Clear filters" button
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { listMemories, type MemoryListItem } from '../api/memories';

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE     = 20;
const ALL_LEVELS    = [1, 2, 3, 4, 5] as const;
const LOCKED_LEVELS = new Set([4, 5]);

// ─── Level badge config ───────────────────────────────────────────────────────

const LEVEL_STYLES: Record<number, { badge: string; chip: string }> = {
  1: { badge: 'bg-emerald-100 text-emerald-800 ring-emerald-200',  chip: 'bg-emerald-50  text-emerald-700 ring-emerald-100'  },
  2: { badge: 'bg-blue-100   text-blue-800   ring-blue-200',      chip: 'bg-blue-50    text-blue-700   ring-blue-100'      },
  3: { badge: 'bg-violet-100 text-violet-800 ring-violet-200',    chip: 'bg-violet-50  text-violet-700 ring-violet-100'    },
  4: { badge: 'bg-amber-100  text-amber-800  ring-amber-200',     chip: 'bg-amber-50   text-amber-700  ring-amber-100'     },
  5: { badge: 'bg-red-100    text-red-800    ring-red-200',       chip: 'bg-red-50     text-red-700    ring-red-100'       },
};

// ─── Emotion chip colours (same palette as ConversationHistoryScreen) ─────────

const EMOTION_COLOURS: Record<string, string> = {
  joy:        'bg-yellow-50  text-yellow-700 ring-yellow-100',
  calm:       'bg-teal-50    text-teal-700   ring-teal-100',
  anxiety:    'bg-orange-50  text-orange-700 ring-orange-100',
  sadness:    'bg-blue-50    text-blue-700   ring-blue-100',
  anger:      'bg-red-50     text-red-700    ring-red-100',
  excitement: 'bg-purple-50  text-purple-700 ring-purple-100',
};

function emotionClasses(e: string): string {
  return EMOTION_COLOURS[e.toLowerCase()] ?? 'bg-gray-50 text-gray-600 ring-gray-100';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(yyyymmdd: string): string {
  // "2026-01-15" → "Jan 15, 2026"
  const d = new Date(`${yyyymmdd}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// Lock icon (heroicons mini)
function LockIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3" aria-hidden="true">
      <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
    </svg>
  );
}

function MemoryCard({ memory }: { memory: MemoryListItem }) {
  const isLocked = LOCKED_LEVELS.has(memory.level);
  const ls       = LEVEL_STYLES[memory.level];

  const sameDay = memory.period_start === memory.period_end;
  const dateRange = sameDay
    ? formatDate(memory.period_start)
    : `${formatDate(memory.period_start)} – ${formatDate(memory.period_end)}`;

  return (
    <Link
      to={`/memories/${memory.id}`}
      className="group flex flex-col gap-2.5 rounded-xl border border-gray-100 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
      aria-label={`Memory: ${memory.title}`}
    >
      {/* Top row: level badge (+ lock for L4/5) and emotion chip */}
      <div className="flex items-center justify-between gap-2">
        {/* Level badge */}
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${ls.badge}`}
        >
          {isLocked && <LockIcon />}
          L{memory.level}
        </span>

        {/* Emotion chip — hidden for locked levels */}
        {!isLocked && memory.dominant_emotion && (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${emotionClasses(memory.dominant_emotion)}`}
          >
            {memory.dominant_emotion}
          </span>
        )}
      </div>

      {/* Title (always shown, even for locked) */}
      <p className="text-sm font-medium leading-snug text-gray-900 group-hover:text-slate-700">
        {memory.title}
      </p>

      {/* Date range — hidden for locked levels */}
      {!isLocked && (
        <p className="text-[11px] text-gray-400">
          {dateRange}
        </p>
      )}

      {/* Locked hint */}
      {isLocked && (
        <p className="text-[11px] text-amber-500">
          Requires PIN to view
        </p>
      )}
    </Link>
  );
}

function SkeletonCard() {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="h-4 w-8 animate-pulse rounded-full bg-gray-100" />
        <div className="h-4 w-14 animate-pulse rounded-full bg-gray-100" />
      </div>
      <div className="h-4 w-3/4 animate-pulse rounded bg-gray-100" />
      <div className="h-3 w-24 animate-pulse rounded bg-gray-100" />
    </div>
  );
}

// ─── Filter bar ───────────────────────────────────────────────────────────────

interface FilterBarProps {
  activeLevels:   number[];
  onToggleLevel:  (level: number) => void;
  fromDate:       string;
  toDate:         string;
  onFromChange:   (v: string) => void;
  onToChange:     (v: string) => void;
  onClearFilters: () => void;
  /** Show the "Clear filters" shortcut only when results are visible; empty state has its own. */
  showClear:      boolean;
}

function FilterBar({
  activeLevels,
  onToggleLevel,
  fromDate,
  toDate,
  onFromChange,
  onToChange,
  onClearFilters,
  showClear,
}: FilterBarProps) {
  return (
    <div className="space-y-3 border-b border-gray-100 bg-white px-4 py-3">
      {/* Level chips — aria-label provides "L1"…"L5" so getByRole(button, {name:/L1/}) works
          while the visible text is just the number to avoid duplicate text with card badges */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] font-medium text-gray-400 mr-1">Level</span>
        {ALL_LEVELS.map((level) => {
          const selected  = activeLevels.includes(level);
          const ls        = LEVEL_STYLES[level];
          const isLocked  = LOCKED_LEVELS.has(level);
          return (
            <button
              key={level}
              onClick={() => onToggleLevel(level)}
              aria-pressed={selected}
              aria-label={`L${level}`}
              className={`
                inline-flex items-center gap-0.5 rounded-full px-2.5 py-1 text-xs font-medium
                ring-1 ring-inset transition-opacity
                ${selected ? ls.chip : 'bg-gray-50 text-gray-400 ring-gray-100 opacity-50'}
              `}
            >
              {isLocked && <LockIcon />}
              {level}
            </button>
          );
        })}
      </div>

      {/* Date range */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-gray-400">From</span>
        <input
          type="date"
          value={fromDate}
          onChange={(e) => onFromChange(e.target.value)}
          className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 focus:border-gray-400 focus:outline-none"
          aria-label="Filter from date"
        />
        <span className="text-gray-400">to</span>
        <input
          type="date"
          value={toDate}
          onChange={(e) => onToChange(e.target.value)}
          className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 focus:border-gray-400 focus:outline-none"
          aria-label="Filter to date"
        />
        {showClear && (
          <button
            onClick={onClearFilters}
            className="ml-auto text-[11px] text-gray-400 hover:text-gray-600 underline"
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

// ─── MemoriesScreen ───────────────────────────────────────────────────────────

export function MemoriesScreen() {
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Read filters from URL ─────────────────────────────────────────────────
  const levelParam = searchParams.get('level');
  const fromParam  = searchParams.get('from') ?? '';
  const toParam    = searchParams.get('to')   ?? '';

  const activeLevels: number[] = useMemo(() => {
    if (!levelParam) return [1, 2, 3, 4, 5];
    return levelParam
      .split(',')
      .map(Number)
      .filter((n) => n >= 1 && n <= 5);
  }, [levelParam]);

  // True when filters differ from the default (all levels, no date range)
  const isFiltered =
    activeLevels.length < 5 ||
    Boolean(fromParam) ||
    Boolean(toParam);

  // ── Local pagination state ─────────────────────────────────────────────────
  const [memories,       setMemories]       = useState<MemoryListItem[]>([]);
  const [page,           setPage]           = useState(1);
  const [hasMore,        setHasMore]        = useState(false);
  const [isLoading,      setIsLoading]      = useState(false);
  const [isLoadingMore,  setIsLoadingMore]  = useState(false);
  const [fetchError,     setFetchError]     = useState<string | null>(null);

  // ── Fetch (replaces results — used when filters change or on first load) ──

  const fetchFirstPage = useCallback(async () => {
    setIsLoading(true);
    setFetchError(null);
    try {
      const data = await listMemories({
        page:    1,
        perPage: PAGE_SIZE,
        levels:  activeLevels.length < 5 ? activeLevels.join(',') : undefined,
        from:    fromParam || undefined,
        to:      toParam   || undefined,
      });
      setMemories(data.memories);
      setHasMore(data.has_more);
      setPage(1);
    } catch (err) {
      setFetchError('Could not load memories. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [activeLevels, fromParam, toParam]);

  // Re-fetch whenever filters change (dependency array is derived from URL)
  useEffect(() => {
    void fetchFirstPage();
  }, [fetchFirstPage]);

  // ── Load more ─────────────────────────────────────────────────────────────

  const handleLoadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    try {
      const nextPage = page + 1;
      const data = await listMemories({
        page:    nextPage,
        perPage: PAGE_SIZE,
        levels:  activeLevels.length < 5 ? activeLevels.join(',') : undefined,
        from:    fromParam || undefined,
        to:      toParam   || undefined,
      });
      setMemories((prev) => [...prev, ...data.memories]);
      setHasMore(data.has_more);
      setPage(nextPage);
    } catch {
      // Non-fatal — user can try again
    } finally {
      setIsLoadingMore(false);
    }
  }, [page, hasMore, isLoadingMore, activeLevels, fromParam, toParam]);

  // ── Filter update helpers ─────────────────────────────────────────────────

  function updateSearchParams(updates: Record<string, string | null>) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      return next;
    }, { replace: true });
  }

  function handleToggleLevel(level: number) {
    const next = activeLevels.includes(level)
      ? activeLevels.filter((l) => l !== level)
      : [...activeLevels, level].sort();

    // If all 5 selected → remove the param (default); else set it
    if (next.length === 5) {
      updateSearchParams({ level: null });
    } else if (next.length === 0) {
      // Don't allow deselecting all — keep the last one selected
      return;
    } else {
      updateSearchParams({ level: next.join(',') });
    }
  }

  function handleClearFilters() {
    setSearchParams({}, { replace: true });
  }

  // ── Empty state message ───────────────────────────────────────────────────

  function emptyMessage(): string {
    if (!isFiltered) return 'Close a conversation to create one.';
    if (fromParam || toParam) return 'No memories in this date range.';
    if (activeLevels.length < 5) return 'No memories at this level yet.';
    return 'No memories match the active filters.';
  }

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-gray-100 px-4 py-4">
        <h1 className="text-base font-semibold text-gray-900">Memories</h1>
        <p className="mt-0.5 text-xs text-gray-400">
          Moments from your conversations, captured and organized.
        </p>
      </div>

      {/* Filter bar */}
      <FilterBar
        activeLevels={activeLevels}
        onToggleLevel={handleToggleLevel}
        fromDate={fromParam}
        toDate={toParam}
        onFromChange={(v) => updateSearchParams({ from: v })}
        onToChange={(v) => updateSearchParams({ to: v })}
        onClearFilters={handleClearFilters}
        showClear={isFiltered && memories.length > 0}
      />

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {/* Error state */}
        {fetchError && (
          <div className="p-6 text-center">
            <p className="text-sm text-red-500">{fetchError}</p>
            <button
              onClick={() => void fetchFirstPage()}
              className="mt-2 text-sm text-gray-500 underline"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading skeleton */}
        {isLoading && !fetchError && (
          <div
            className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2"
            role="status"
            aria-label="Loading memories…"
          >
            {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !fetchError && memories.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-4 px-6 py-20 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6 text-gray-400" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">
                {isFiltered ? 'No results' : 'No memories yet'}
              </p>
              <p className="mt-1 text-xs text-gray-400">{emptyMessage()}</p>
            </div>
            {isFiltered && (
              <button
                onClick={handleClearFilters}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        {/* Memory grid */}
        {!isLoading && !fetchError && memories.length > 0 && (
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            {memories.map((m) => <MemoryCard key={m.id} memory={m} />)}
          </div>
        )}

        {/* Load more */}
        {!isLoading && hasMore && (
          <div className="flex justify-center pb-6">
            <button
              onClick={() => void handleLoadMore()}
              disabled={isLoadingMore}
              className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-5 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-60"
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
