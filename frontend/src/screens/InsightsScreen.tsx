/**
 * src/screens/InsightsScreen.tsx
 *
 * F2-001 · Insight Reports Screen + Phase 2 Insights container
 *
 * Wraps two tabs under a single "Insights" nav item:
 *   Overview — the existing 30-day emotion trends chart (TrendsScreen)
 *   Reports  — paginated list of AI-generated weekly/monthly insight reports
 *
 * Route: /insights  (replaces /trends from Phase 1)
 * The /trends route redirects here via the router for backward compatibility.
 *
 * F2-001 acceptance criteria (Reports tab):
 *   ✓ Paginated list of insight reports ordered period_start DESC, 20/page
 *   ✓ Each card: Weekly/Monthly badge, date range, relative created_at
 *   ✓ Empty state: honest message about the 14-day wait for the first report
 *   ✓ "Load more" button appends the next page
 *   ✓ Tapping a card navigates to /insights/:id (F2-002)
 */

import { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { TrendsScreen } from './TrendsScreen';
import { getInsightReports, type InsightReport } from '../api/insights';

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'reports';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateRange(start: string, end: string): string {
  // "2026-01-08" → "Jan 8"; "2026-01-31" → "Jan 31"
  function fmt(d: string) {
    const [, m, day] = d.split('-').map(Number);
    const months = ['Jan','Feb','Mar','Apr','May','Jun',
                    'Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[m - 1]} ${day}`;
  }
  const year = start.slice(0, 4);
  const nowYear = String(new Date().getFullYear());
  const yearSuffix = year !== nowYear ? `, ${year}` : '';
  return `${fmt(start)} – ${fmt(end)}${yearSuffix}`;
}

function generatedAgo(isoString: string): string {
  const diff   = Date.now() - new Date(isoString).getTime();
  const days   = Math.floor(diff / 86_400_000);
  const hours  = Math.floor(diff / 3_600_000);
  const mins   = Math.floor(diff / 60_000);
  if (mins < 1)  return 'Generated just now';
  if (mins < 60) return `Generated ${mins} min ago`;
  if (hours < 24) return `Generated ${hours}h ago`;
  if (days === 1) return 'Generated yesterday';
  return `Generated ${days} days ago`;
}

// ─── Badge config ─────────────────────────────────────────────────────────────

const BADGE_STYLES = {
  weekly:  'bg-blue-50   text-blue-700   ring-blue-100',
  monthly: 'bg-purple-50 text-purple-700 ring-purple-100',
};

// ─── Report card ──────────────────────────────────────────────────────────────

function ReportCard({ report }: { report: InsightReport }) {
  return (
    <Link
      to={`/insights/${report.id}`}
      className="group flex items-start justify-between gap-3 rounded-xl border border-gray-100 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
      aria-label={`${report.report_type === 'weekly' ? 'Weekly' : 'Monthly'} insight report — ${formatDateRange(report.period_start, report.period_end)}`}
    >
      <div className="min-w-0 flex-1">
        {/* Badge */}
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset capitalize ${BADGE_STYLES[report.report_type]}`}
        >
          {report.report_type}
        </span>

        {/* Date range */}
        <p className="mt-2 text-sm font-medium text-gray-900">
          {formatDateRange(report.period_start, report.period_end)}
        </p>

        {/* Generated timestamp */}
        <p className="mt-0.5 text-xs text-gray-400">
          {generatedAgo(report.created_at)}
        </p>
      </div>

      {/* Chevron */}
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        className="mt-1 h-5 w-5 shrink-0 text-gray-300 transition-colors group-hover:text-gray-400"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M8.22 5.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 010-1.06z"
          clipRule="evenodd"
        />
      </svg>
    </Link>
  );
}

// ─── Skeleton cards ────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <div className="h-5 w-16 animate-pulse rounded-full bg-gray-100" />
      <div className="mt-2 h-4 w-32 animate-pulse rounded bg-gray-100" />
      <div className="mt-1.5 h-3 w-24 animate-pulse rounded bg-gray-100" />
    </div>
  );
}

// ─── Reports tab content ──────────────────────────────────────────────────────

function ReportsTab() {
  const [allReports, setAllReports] = useState<InsightReport[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const { isLoading } = useQuery({
    queryKey: ['insight-reports', 1],
    queryFn: async () => {
      const data = await getInsightReports(1, 20);
      setAllReports(data.reports);
      setHasMore(data.has_more);
      return data;
    },
    staleTime: 5 * 60_000,
  });

  const handleLoadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    try {
      const next = currentPage + 1;
      const data = await getInsightReports(next, 20);
      setAllReports((prev) => [...prev, ...data.reports]);
      setHasMore(data.has_more);
      setCurrentPage(next);
    } finally {
      setIsLoadingMore(false);
    }
  }, [currentPage, hasMore, isLoadingMore]);

  // ── Loading skeleton ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div
        className="space-y-3 p-4"
        role="status"
        aria-label="Loading reports…"
      >
        {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
      </div>
    );
  }

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (allReports.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        {/* Sparkle illustration */}
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-50">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            className="h-7 w-7 text-blue-400"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"
            />
          </svg>
        </div>

        <div>
          <p className="text-sm font-medium text-gray-900">No reports yet</p>
          <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-gray-400">
            Your first weekly report will appear after 14 days of conversations.
            Keep chatting!
          </p>
        </div>

        <Link
          to="/chat"
          className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white"
        >
          Start a conversation
        </Link>
      </div>
    );
  }

  // ── Report list ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3 p-4">
      {allReports.map((report) => (
        <ReportCard key={report.id} report={report} />
      ))}

      {hasMore && (
        <div className="flex justify-center pt-2">
          <button
            onClick={() => void handleLoadMore()}
            disabled={isLoadingMore}
            className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-5 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-60"
          >
            {isLoadingMore ? (
              <>
                <span
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
                  aria-hidden="true"
                />
                Loading…
              </>
            ) : (
              'Load more'
            )}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── InsightsScreen ───────────────────────────────────────────────────────────

export function InsightsScreen() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  return (
    <div className="flex h-full flex-col">
      {/* ── Header with tab strip ─────────────────────────────────────────── */}
      <div className="border-b border-gray-100 bg-white">
        {/* Page title */}
        <div className="px-4 pt-4 pb-3">
          <h1 className="text-base font-semibold text-gray-900">Insights</h1>
        </div>

        {/* Tab strip */}
        <div className="flex px-4" role="tablist" aria-label="Insights sections">
          {([ 'overview', 'reports' ] as const).map((tab) => {
            const isActive = activeTab === tab;
            const label = tab === 'overview' ? 'Overview' : 'Reports';
            return (
              <button
                key={tab}
                role="tab"
                aria-selected={isActive}
                aria-controls={`tabpanel-${tab}`}
                onClick={() => setActiveTab(tab)}
                className={`
                  mr-5 border-b-2 pb-3 text-sm font-medium transition-colors
                  ${isActive
                    ? 'border-slate-700 text-slate-700'
                    : 'border-transparent text-gray-400 hover:text-gray-600'}
                `}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Tab panels ───────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {/* Overview tab — TrendsScreen without its own page header */}
        <div
          id="tabpanel-overview"
          role="tabpanel"
          aria-label="Overview"
          hidden={activeTab !== 'overview'}
          className={activeTab === 'overview' ? 'h-full' : ''}
        >
          {activeTab === 'overview' && <TrendsScreen hideHeader />}
        </div>

        {/* Reports tab — F2-001 insight report list */}
        <div
          id="tabpanel-reports"
          role="tabpanel"
          aria-label="Reports"
          hidden={activeTab !== 'reports'}
        >
          {activeTab === 'reports' && <ReportsTab />}
        </div>
      </div>
    </div>
  );
}
