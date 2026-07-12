/**
 * src/routes/v1/insights.router.ts
 *
 * Insights endpoints for the Phase 1 Trends Dashboard (F1-010).
 *
 *   GET /v1/insights/trends
 *     Returns daily averaged emotion scores for the past 30 days.
 *     Every day in the window is included; days with no conversations have
 *     emotion_scores: null so the frontend can render honest gaps in the
 *     chart rather than interpolated zeros.
 *
 * Data source: emotional_snapshots table (written by the P1-19 extraction job).
 * Multiple conversations on the same day are averaged together per emotion.
 * dominant_emotion per day is the most frequently occurring value across
 * that day's snapshots (mode).
 *
 * Phase 2 will add insight report generation (the nightly batch job and the
 * GET /v1/insights/reports endpoints from TDD P1-020).
 */

import { Router }       from 'express';
import { sql }          from 'drizzle-orm';
import { db }           from '../../db';
import { authenticate } from '../../middleware/authenticate';
import { globalRateLimit } from '../../middleware/rateLimit';

export const insightsRouter = Router();

insightsRouter.use(authenticate);
insightsRouter.use(globalRateLimit);

// ─── Types ────────────────────────────────────────────────────────────────────

interface EmotionScores {
  joy:        number;
  sadness:    number;
  anxiety:    number;
  anger:      number;
  calm:       number;
  excitement: number;
}

interface TrendDay {
  date:             string;          // YYYY-MM-DD
  emotion_scores:   EmotionScores | null;
  dominant_emotion: string | null;
}

// ─── GET /v1/insights/trends ──────────────────────────────────────────────────

insightsRouter.get('/trends', async (req, res, next) => {
  const userId = req.userId!;

  try {
    // Query: average each emotion score per day for the past 30 days.
    // ROUND to 3 decimal places to avoid floating-point noise in the response.
    const rows = await db.execute<{
      date:             string;
      joy:              number;
      sadness:          number;
      anxiety:          number;
      anger:            number;
      calm:             number;
      excitement:       number;
      dominant_emotion: string;
    }>(sql`
      SELECT
        snapshot_date::text                                              AS date,
        ROUND(AVG((emotion_scores->>'joy')::float)::numeric, 3)::float        AS joy,
        ROUND(AVG((emotion_scores->>'sadness')::float)::numeric, 3)::float    AS sadness,
        ROUND(AVG((emotion_scores->>'anxiety')::float)::numeric, 3)::float    AS anxiety,
        ROUND(AVG((emotion_scores->>'anger')::float)::numeric, 3)::float      AS anger,
        ROUND(AVG((emotion_scores->>'calm')::float)::numeric, 3)::float       AS calm,
        ROUND(AVG((emotion_scores->>'excitement')::float)::numeric, 3)::float AS excitement,
        -- Modal dominant_emotion for the day
        (
          SELECT dominant_emotion
          FROM   emotional_snapshots es2
          WHERE  es2.user_id      = ${userId}
            AND  es2.snapshot_date = es.snapshot_date
          GROUP  BY dominant_emotion
          ORDER  BY COUNT(*) DESC
          LIMIT  1
        ) AS dominant_emotion
      FROM  emotional_snapshots es
      WHERE user_id      = ${userId}
        AND snapshot_date >= (CURRENT_DATE - INTERVAL '29 days')
      GROUP BY snapshot_date
      ORDER BY snapshot_date ASC
    `);

    // Index the DB results by date for O(1) merging
    const byDate = new Map<string, (typeof rows.rows)[0]>();
    for (const row of rows.rows) {
      byDate.set(row.date, row);
    }

    // Build the full 30-day response, filling null for missing days.
    // Day 0 = 29 days ago; Day 29 = today.
    const today = new Date();
    const trend: TrendDay[] = [];

    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD

      const row = byDate.get(dateStr);

      trend.push(
        row
          ? {
              date:             dateStr,
              dominant_emotion: row.dominant_emotion ?? null,
              emotion_scores: {
                joy:        row.joy,
                sadness:    row.sadness,
                anxiety:    row.anxiety,
                anger:      row.anger,
                calm:       row.calm,
                excitement: row.excitement,
              },
            }
          : {
              date:             dateStr,
              dominant_emotion: null,
              emotion_scores:   null,
            },
      );
    }

    return res.status(200).json(trend);
  } catch (err) {
    return next(err);
  }
});
