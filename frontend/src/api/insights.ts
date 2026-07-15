/**
 * src/api/insights.ts
 *
 * Typed wrappers for the insights API.
 * F1-010 uses getTrends() for the emotion trends chart.
 * F2-001 uses getInsightReports() for the insight reports list.
 * F2-002 uses getInsightReport(id) for the report detail view.
 */

import { apiFetch } from './client';

// ─── Trends (F1-010) ──────────────────────────────────────────────────────────

export interface EmotionScores {
  joy:        number;
  sadness:    number;
  anxiety:    number;
  anger:      number;
  calm:       number;
  excitement: number;
}

export type EmotionKey = keyof EmotionScores;

/** One day in the 30-day trends response. */
export interface TrendDay {
  /** YYYY-MM-DD */
  date:             string;
  /** null means no conversation on this day — renders as a gap in the chart */
  emotion_scores:   EmotionScores | null;
  dominant_emotion: string | null;
}

/**
 * GET /v1/insights/trends
 * Returns the past 30 days of daily emotion averages, one item per day,
 * oldest first. Days with no conversations have emotion_scores: null.
 */
export function getTrends(): Promise<TrendDay[]> {
  return apiFetch<TrendDay[]>('/v1/insights/trends');
}

// ─── Insight Reports (F2-001, F2-002) ────────────────────────────────────────

export interface InsightReport {
  id:           string;
  /** 'weekly' reports cover 7 days; 'monthly' cover a calendar month */
  report_type:  'weekly' | 'monthly';
  /** YYYY-MM-DD — start of the reporting period */
  period_start: string;
  /** YYYY-MM-DD — end of the reporting period */
  period_end:   string;
  created_at:   string;
}

export interface InsightReportsResponse {
  reports:  InsightReport[];
  page:     number;
  per_page: number;
  has_more: boolean;
}

/**
 * GET /v1/insights/reports
 * Returns a paginated list of insight reports for the authenticated user,
 * ordered period_start DESC (most recent first).
 */
export function getInsightReports(
  page    = 1,
  perPage = 20,
): Promise<InsightReportsResponse> {
  return apiFetch<InsightReportsResponse>(
    `/v1/insights/reports?page=${page}&per_page=${perPage}`,
  );
}

/**
 * GET /v1/insights/reports/:id
 * Returns the full detail of a single insight report including the
 * decrypted narrative, patterns, and goal progress (F2-002).
 */
export interface InsightReportDetail extends InsightReport {
  content:       string;   // decrypted narrative prose
  patterns:      ReportPattern[];
  goal_progress: GoalProgress[];  // empty array if no goals set
  meta: {
    pattern_data_insufficient: boolean;
    word_count:                number;
  };
}

export interface ReportPattern {
  description:    string;
  severity:       'low' | 'medium' | 'high';
  first_observed: string;  // YYYY-MM-DD
  frequency:      string;  // e.g. "3 times this week"
}

export interface GoalProgress {
  goal:       string;
  assessment: 'improving' | 'stable' | 'regressing';
  evidence:   string;
}

export function getInsightReport(id: string): Promise<InsightReportDetail> {
  return apiFetch<InsightReportDetail>(`/v1/insights/reports/${id}`);
}
