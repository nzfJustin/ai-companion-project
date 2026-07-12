/**
 * src/api/insights.ts
 *
 * Typed wrappers for the insights API.
 * F1-010 uses getTrends() for the emotion trends chart.
 */

import { apiFetch } from './client';

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
