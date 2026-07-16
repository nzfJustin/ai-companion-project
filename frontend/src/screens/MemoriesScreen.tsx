/**
 * src/screens/MemoriesScreen.tsx
 *
 * F1-008 · Memory List Screen  +  F2-003 · Semantic Memory Search
 *
 * F1-008 (filter mode):
 *   ✓ Paginated list (20/page) ordered created_at DESC
 *   ✓ Level multi-select chips (1–5, all default), date range picker
 *   ✓ Filters sync to URL for bookmark-friendliness
 *   ✓ Contextual empty states with "Clear filters" button
 *   ✓ Level 4–5 cards show lock icon, no emotion chip
 *
 * F2-003 (search mode, activated by ?q=<query> in URL):
 *   ✓ Search input above the filter bar — Enter/button submits
 *   ✓ Search calls GET /v1/memories?q=<query> (pgvector cosine similarity)
 *   ✓ Filter chips and date pickers are hidden in search mode
 *   ✓ Search results replace the list and are not paginated ("Load more" hidden)
 *   ✓ Clearing search restores the previous filter state from URL params
 *   ✓ URL-synced: ?q= persists on page refresh, shareable
 *   ✓ L4/5 memories are excluded server-side (no embedding stored for them)
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

function formatDate(yyyymmdd: string): string {
  const d = new Date(`${yyyymmdd}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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
  const sameDay  = memory.period_start === memory.period_end;
  const dateRange = sameDay
    ? formatDate(memory.period_start)
    : `${formatDate(memory.period_start)} – ${formatDate(memory.period_end)}`;

  return (
    <Link
      to={`/memories/${memory.id}`}
      className="group flex flex-col gap-2.5 rounded-xl border border-gray-100 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
      aria-label={`Memory: ${memory.title}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${ls.badge}`}>
          {isLocked && <LockIcon />}
          L{memory.level}
        </span>
        {!isLocked && memory.dominant_emotion && (
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${emotionClasses(memory.dominant_emotion)}`}>
            {memory.dominant_emotion}
          </span>
        )}
      </div>
      <p className="text-sm font-medium leading-snug text-gray-900 group-hover:text-slate-700">
        {memory.title}
      </p>
      {!isLocked && (
        <p className="text-[11px] text-gray-400">{dateRange}</p>
      )}
      {isLocked && (
        <p className="text-[11px] text-amber-500">Requires PIN to view</p>
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

// ─── Filter bar (F1-008) ──────────────────────────────────────────────────────

interface FilterBarProps {
  activeLevels:   number[];
  onToggleLevel:  (level: number) => void;
  fromDate:       string;
  toDate:         string;
  onFromChange:   (v: string) => void;
  onToChange:     (v: string) => void;
  onClearFilters: () => void;
  isFiltered:     boolean;
}

function FilterBar({ activeLevels, onToggleLevel, fromDate, toDate, onFromChange, onToChange, onClearFilters, isFiltered }: FilterBarProps) {
  return (
    <div className="space-y-3 border-b border-gray-100 bg-white px-4 py-3">
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
              className={`inline-flex items-center gap-0.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-opacity ${selected ? ls.chip : 'bg-gray-50 text-gray-400 ring-gray-100 opacity-50'}`}
            >
              {isLocked && <LockIcon />}
              {level}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-gray-400">From</span>
        <input type="date" value={fromDate} onChange={(e) => onFromChange(e.target.value)} className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 focus:border-gray-400 focus:outline-none" aria-label="Filter from date" />
        <span className="text-gray-400">to</span>
        <input type="date" value={toDate} onChange={(e) => onToChange(e.target.value)} className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 focus:border-gray-400 focus:outline-none" aria-label="Filter to date" />
        {isFiltered && (
          <button onClick={onClearFilters} className="ml-auto text-[11px] text-gray-400 hover:text-gray-600 underline">
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

  // ── URL state ─────────────────────────────────────────────────────────────
  const searchQuery = searchParams.get('q') ?? '';          // committed search
  const levelParam  = searchParams.get('level');
  const fromParam   = searchParams.get('from') ?? '';
  const toParam     = searchParams.get('to')   ?? '';

  // Is semantic search mode active?
  const isSearchMode = searchQuery.length > 0;

  // ── Local search input state ──────────────────────────────────────────────
  // inputValue is the draft (what the user is typing), searchQuery is what
  // has been committed to the URL and triggers a fetch.
  const [inputValue, setInputValue] = useState(searchQuery);

  // Keep input in sync when the URL changes externally (browser back/forward,
  // or sharing a ?q= link).
  useEffect(() => {
    setInputValue(searchQuery);
  }, [searchQuery]);

  // ── Filter state (F1-008) ─────────────────────────────────────────────────
  const activeLevels: number[] = useMemo(() => {
    if (!levelParam) return [1, 2, 3, 4, 5];
    return levelParam.split(',').map(Number).filter((n) => n >= 1 && n <= 5);
  }, [levelParam]);

  // isFiltered only applies in filter mode — search mode has its own indicator
  const isFiltered =
    !isSearchMode && (
      activeLevels.length < 5 ||
      Boolean(fromParam) ||
      Boolean(toParam)
    );

  // ── Pagination state ──────────────────────────────────────────────────────
  const [memories,      setMemories]      = useState<MemoryListItem[]>([]);
  const [page,          setPage]          = useState(1);
  const [hasMore,       setHasMore]       = useState(false);
  const [isLoading,     setIsLoading]     = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [fetchError,    setFetchError]    = useState<string | null>(null);

  // ── Fetch — replaces results on every mode/filter/query change ────────────

  const fetchFirstPage = useCallback(async () => {
    setIsLoading(true);
    setFetchError(null);
    try {
      const data = await listMemories(
        isSearchMode
          // Search mode: pass q only — no level/date filters
          ? { q: searchQuery, perPage: PAGE_SIZE }
          // Filter mode: pass level/date — no q
          : {
              page:    1,
              perPage: PAGE_SIZE,
              levels:  activeLevels.length < 5 ? activeLevels.join(',') : undefined,
              from:    fromParam || undefined,
              to:      toParam   || undefined,
            },
      );
      setMemories(data.memories);
      // Search results are NOT paginated — backend returns top N results
      setHasMore(isSearchMode ? false : data.has_more);
      setPage(1);
    } catch {
      setFetchError('Could not load memories. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [activeLevels, fromParam, toParam, isSearchMode, searchQuery]);

  useEffect(() => {
    void fetchFirstPage();
  }, [fetchFirstPage]);

  // ── Load more (filter mode only — hidden in search mode) ─────────────────

  const handleLoadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore || isSearchMode) return;
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
  }, [page, hasMore, isLoadingMore, activeLevels, fromParam, toParam, isSearchMode]);

  // ── Search handlers (F2-003) ──────────────────────────────────────────────

  function handleSearch() {
    const q = inputValue.trim();
    if (!q) return;
    // Add ?q= to the URL while preserving any existing filter params.
    // When search is cleared, the filter params reappear unchanged —
    // this is the "restore previous filter state" behaviour per spec.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('q', q);
      return next;
    }, { replace: true });
  }

  function handleClearSearch() {
    setInputValue('');
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('q');
      return next;
    }, { replace: true });
  }

  // ── Filter handlers (F1-008) ──────────────────────────────────────────────

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
    if (next.length === 5)       updateSearchParams({ level: null });
    else if (next.length === 0)  return; // keep last chip selected
    else                         updateSearchParams({ level: next.join(',') });
  }

  function handleClearFilters() {
    setSearchParams({}, { replace: true });
  }

  // ── Empty state message ───────────────────────────────────────────────────

  function emptyMessage(): string {
    if (isSearchMode)             return `No memories found for "${searchQuery}". Try different words or clear the search.`;
    if (!isFiltered)              return 'Close a conversation to create one.';
    if (fromParam || toParam)     return 'No memories in this date range.';
    if (activeLevels.length < 5) return 'No memories at this level yet.';
    return 'No memories match the active filters.';
  }

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col">
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="border-b border-gray-100 px-4 py-4">
        <h1 className="text-base font-semibold text-gray-900">Memories</h1>
        <p className="mt-0.5 text-xs text-gray-400">
          Moments from your conversations, captured and organized.
        </p>
      </div>

      {/* ── Search bar (F2-003) ─────────────────────────────────────────── */}
      <div className="border-b border-gray-100 bg-white px-4 py-3">
        <div className="relative flex items-center gap-2">
          {/* Magnifying glass */}
          <span className="pointer-events-none absolute left-3 text-gray-400" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
            </svg>
          </span>

          <input
            type="search"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
              if (e.key === 'Escape') handleClearSearch();
            }}
            placeholder="Search your memories…"
            aria-label="Search memories"
            className="w-full rounded-xl border border-gray-200 bg-gray-50 py-2.5 pl-9 pr-10 text-sm focus:border-gray-400 focus:bg-white focus:outline-none"
          />

          {/* Clear button — visible when anything is in the input or search is active */}
          {(inputValue || isSearchMode) && (
            <button
              onClick={handleClearSearch}
              aria-label="Clear search"
              className="absolute right-3 flex h-5 w-5 items-center justify-center rounded-full bg-gray-300 text-white hover:bg-gray-400"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3" aria-hidden="true">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          )}
        </div>

        {/* Active search indicator */}
        {isSearchMode && (
          <p className="mt-2 text-xs text-gray-400" aria-live="polite">
            Results for{' '}
            <span className="font-medium text-gray-600">"{searchQuery}"</span>
            {' · '}
            <button
              onClick={handleClearSearch}
              className="text-blue-600 underline hover:text-blue-700"
            >
              Clear search
            </button>
          </p>
        )}
      </div>

      {/* ── Filter bar (F1-008) — hidden in search mode ─────────────────── */}
      {!isSearchMode && (
        <FilterBar
          activeLevels={activeLevels}
          onToggleLevel={handleToggleLevel}
          fromDate={fromParam}
          toDate={toParam}
          onFromChange={(v) => updateSearchParams({ from: v })}
          onToChange={(v) => updateSearchParams({ to: v })}
          onClearFilters={handleClearFilters}
          isFiltered={isFiltered && memories.length > 0}
        />
      )}

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {/* Error */}
        {fetchError && (
          <div className="p-6 text-center">
            <p className="text-sm text-red-500">{fetchError}</p>
            <button onClick={() => void fetchFirstPage()} className="mt-2 text-sm text-gray-500 underline">
              Retry
            </button>
          </div>
        )}

        {/* Loading skeleton */}
        {isLoading && !fetchError && (
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2" role="status" aria-label="Loading memories…">
            {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !fetchError && memories.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-4 px-6 py-20 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
              {isSearchMode ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6 text-gray-400" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803 7.5 7.5 0 0015.803 15.803z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6 text-gray-400" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                </svg>
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">
                {isSearchMode ? 'No results' : (isFiltered ? 'No results' : 'No memories yet')}
              </p>
              <p className="mt-1 text-xs text-gray-400">{emptyMessage()}</p>
            </div>
            {isSearchMode && (
              <button onClick={handleClearSearch} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
                Clear search
              </button>
            )}
            {!isSearchMode && isFiltered && (
              <button onClick={handleClearFilters} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
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

        {/* Load more — hidden in search mode (results not paginated) */}
        {!isLoading && !isSearchMode && hasMore && (
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
