/**
 * src/screens/InsightReportScreen.tsx
 *
 * F2-002 · Insight Report Detail Screen
 *
 * Route: /insights/:id
 *
 * Acceptance criteria:
 *   ✓ Narrative section — LLM prose rendered as flowing paragraphs, not truncated
 *   ✓ Patterns section — severity chips (low/medium/high), first_observed date,
 *     frequency string. If meta.pattern_data_insufficient → shows "not enough
 *     data yet" message rather than an empty section
 *   ✓ Goal progress section — assessment pill (improving/stable/regressing) +
 *     evidence text. Hidden entirely when goal_progress is empty (user has
 *     no stated goals from onboarding)
 *   ✓ Back button navigates to /insights (not -1) so deep-link arrivals don't
 *     land somewhere unexpected
 *   ✗ Share / export — deferred to Phase 3
 */

import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  getInsightReport,
  type InsightReportDetail,
  type ReportPattern,
  type GoalProgress,
} from '../api/insights';
import { ApiError } from '../api/client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPeriod(start: string, end: string): string {
  function fmt(d: string): string {
    const [y, m, day] = d.split('-').map(Number);
    const months = ['Jan','Feb','Mar','Apr','May','Jun',
                    'Jul','Aug','Sep','Oct','Nov','Dec'];
    const nowYear = new Date().getFullYear();
    return y !== nowYear
      ? `${months[m - 1]} ${day}, ${y}`
      : `${months[m - 1]} ${day}`;
  }
  return `${fmt(start)} – ${fmt(end)}`;
}

function formatObserved(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  const nowYear = new Date().getFullYear();
  return y !== nowYear
    ? `${months[m - 1]} ${d}, ${y}`
    : `${months[m - 1]} ${d}`;
}

/**
 * Split narrative prose on double newlines to produce paragraph elements.
 * Single newlines within a paragraph are preserved as spaces.
 */
function parseParagraphs(content: string): string[] {
  return content
    .split(/\n\n+/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter(Boolean);
}

// ─── Severity chip ────────────────────────────────────────────────────────────

const SEVERITY_STYLES: Record<ReportPattern['severity'], string> = {
  low:    'bg-emerald-50 text-emerald-700 ring-emerald-100',
  medium: 'bg-amber-50   text-amber-700   ring-amber-100',
  high:   'bg-red-50     text-red-700     ring-red-100',
};

const SEVERITY_LABELS: Record<ReportPattern['severity'], string> = {
  low:    'Low',
  medium: 'Medium',
  high:   'High',
};

function SeverityChip({ severity }: { severity: ReportPattern['severity'] }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${SEVERITY_STYLES[severity]}`}
    >
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

// ─── Assessment pill ──────────────────────────────────────────────────────────

const ASSESSMENT_STYLES: Record<GoalProgress['assessment'], string> = {
  improving:  'bg-emerald-50 text-emerald-700 ring-emerald-100',
  stable:     'bg-blue-50    text-blue-700    ring-blue-100',
  regressing: 'bg-amber-50   text-amber-700   ring-amber-100',
};

const ASSESSMENT_ICONS: Record<GoalProgress['assessment'], string> = {
  improving:  '↑',
  stable:     '→',
  regressing: '↓',
};

function AssessmentPill({ assessment }: { assessment: GoalProgress['assessment'] }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset capitalize ${ASSESSMENT_STYLES[assessment]}`}
    >
      <span aria-hidden="true">{ASSESSMENT_ICONS[assessment]}</span>
      {assessment}
    </span>
  );
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <h2
        id={id}
        className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-gray-400"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function ReportSkeleton() {
  return (
    <div role="status" aria-label="Loading report…" className="space-y-6 px-4 py-5">
      {/* Header skeleton */}
      <div className="space-y-2">
        <div className="h-5 w-20 animate-pulse rounded-full bg-gray-100" />
        <div className="h-6 w-48 animate-pulse rounded bg-gray-100" />
        <div className="h-3 w-32 animate-pulse rounded bg-gray-100" />
      </div>

      {/* Narrative skeleton */}
      <div className="space-y-2">
        <div className="h-3 w-24 animate-pulse rounded bg-gray-100" />
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-3.5 animate-pulse rounded bg-gray-100"
            style={{ width: i === 4 ? '65%' : '100%' }}
          />
        ))}
        <div className="mt-2 h-3.5 w-full animate-pulse rounded bg-gray-100" />
        <div className="h-3.5 w-4/5 animate-pulse rounded bg-gray-100" />
      </div>

      {/* Patterns skeleton */}
      <div className="space-y-3">
        <div className="h-3 w-20 animate-pulse rounded bg-gray-100" />
        {[1, 2].map((i) => (
          <div key={i} className="rounded-xl border border-gray-100 bg-white p-4">
            <div className="flex items-center justify-between">
              <div className="h-4 w-40 animate-pulse rounded bg-gray-100" />
              <div className="h-5 w-14 animate-pulse rounded-full bg-gray-100" />
            </div>
            <div className="mt-2 h-3 w-28 animate-pulse rounded bg-gray-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Report content ───────────────────────────────────────────────────────────

function ReportContent({ report }: { report: InsightReportDetail }) {
  const paragraphs      = parseParagraphs(report.content);
  const hasGoals        = report.goal_progress.length > 0;
  const noPatternData   = report.meta.pattern_data_insufficient;

  return (
    <div className="space-y-8 px-4 py-5">
      {/* ── Report header ─────────────────────────────────────────────── */}
      <div>
        {/* Type badge */}
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset capitalize ${
            report.report_type === 'weekly'
              ? 'bg-blue-50 text-blue-700 ring-blue-100'
              : 'bg-purple-50 text-purple-700 ring-purple-100'
          }`}
        >
          {report.report_type} insight
        </span>

        {/* Period */}
        <h1 className="mt-2 text-xl font-semibold leading-snug text-gray-900">
          {formatPeriod(report.period_start, report.period_end)}
        </h1>

        <p className="mt-0.5 text-xs text-gray-400">
          {report.meta.word_count} words
        </p>
      </div>

      {/* ── Narrative ─────────────────────────────────────────────────── */}
      <Section id="narrative-heading" title="Summary">
        <div className="space-y-3.5">
          {paragraphs.map((para, i) => (
            <p
              key={i}
              className="text-sm leading-relaxed text-gray-700"
            >
              {para}
            </p>
          ))}
        </div>
      </Section>

      {/* ── Patterns ──────────────────────────────────────────────────── */}
      <Section id="patterns-heading" title="Patterns">
        {noPatternData ? (
          <div className="rounded-xl bg-gray-50 px-4 py-5 text-center">
            <p className="text-sm font-medium text-gray-500">Not enough data yet</p>
            <p className="mt-1 text-xs leading-relaxed text-gray-400">
              Patterns will appear after 14 days of conversations — keep chatting.
            </p>
          </div>
        ) : report.patterns.length === 0 ? (
          <p className="text-sm text-gray-400">
            No recurring patterns were identified this period.
          </p>
        ) : (
          <ul className="space-y-3" aria-label="Detected patterns">
            {report.patterns.map((pattern, i) => (
              <li
                key={i}
                className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm"
              >
                {/* Top row: description + severity chip */}
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium leading-snug text-gray-900">
                    {pattern.description}
                  </p>
                  <div className="shrink-0 pt-0.5">
                    <SeverityChip severity={pattern.severity} />
                  </div>
                </div>

                {/* Metadata row */}
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-400">
                  <span>
                    First observed: {formatObserved(pattern.first_observed)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{pattern.frequency}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ── Goal progress (hidden when no goals set) ────────────────────── */}
      {hasGoals && (
        <Section id="goals-heading" title="Goal Progress">
          <ul className="space-y-3" aria-label="Goal progress">
            {report.goal_progress.map((item, i) => (
              <li
                key={i}
                className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm"
              >
                {/* Goal text + pill */}
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium leading-snug text-gray-900">
                    {item.goal}
                  </p>
                  <div className="shrink-0 pt-0.5">
                    <AssessmentPill assessment={item.assessment} />
                  </div>
                </div>

                {/* Evidence */}
                <p className="mt-2 text-xs leading-relaxed text-gray-500">
                  {item.evidence}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ── Phase 3 share placeholder ──────────────────────────────────── */}
      {/* Share / export is deferred to Phase 3 */}
    </div>
  );
}

// ─── InsightReportScreen ──────────────────────────────────────────────────────

export function InsightReportScreen() {
  const { id }   = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: report, isLoading, error } = useQuery({
    queryKey: ['insight-report', id],
    queryFn:  () => getInsightReport(id!),
    staleTime: 10 * 60_000, // reports don't change once generated
    retry: (count, err) => {
      // Don't retry 404/403 — the report doesn't exist or isn't accessible
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
        return false;
      }
      return count < 2;
    },
  });

  const is404 = error instanceof ApiError &&
    (error.status === 404 || error.status === 403);

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3">
        {/* Back to /insights — intentionally NOT navigate(-1) so deep-link
            arrivals always land on the Insights list, not somewhere unexpected */}
        <Link
          to="/insights"
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
          aria-label="Back to Insights"
        >
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z"
              clipRule="evenodd"
            />
          </svg>
          Insights
        </Link>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {/* Loading */}
        {isLoading && <ReportSkeleton />}

        {/* Error — not found or no access */}
        {is404 && (
          <div className="flex flex-col items-center justify-center gap-4 px-6 py-20 text-center">
            <p className="text-sm font-medium text-gray-900">Report not found</p>
            <p className="text-xs text-gray-400">
              This report may have been deleted or may not be available yet.
            </p>
            <Link
              to="/insights"
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Back to Insights
            </Link>
          </div>
        )}

        {/* Generic error */}
        {error && !is404 && (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
            <p className="text-sm text-red-500">Could not load this report.</p>
            <button
              onClick={() => navigate('/insights')}
              className="text-sm text-gray-500 underline"
            >
              Back to Insights
            </button>
          </div>
        )}

        {/* Report content */}
        {report && !error && <ReportContent report={report} />}
      </div>
    </div>
  );
}
