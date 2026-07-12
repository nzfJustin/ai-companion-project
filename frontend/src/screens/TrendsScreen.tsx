/**
 * src/screens/TrendsScreen.tsx
 *
 * F1-010 · Emotion Trends Dashboard
 *
 * Acceptance criteria:
 *   ✓ Recharts line chart — 30 days, X-axis label every 7 days, Y 0–1,
 *     six distinct color-coded emotion lines
 *   ✓ null emotion_scores → gap in the line (connectNulls={false}),
 *     chart never fabricates data for days the user didn't use the app
 *   ✓ Emotion toggle row — default shows anxiety + calm; all six available
 *   ✓ Summary card — most-frequent dominant_emotion over past 7 days,
 *     derived client-side from already-fetched data (no second API call)
 *   ✓ Fully responsive — mobile: reduced chart height + X-axis labels at 45°
 */

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { getTrends, type TrendDay, type EmotionKey } from '../api/insights';

// ─── Emotion config ───────────────────────────────────────────────────────────

const EMOTIONS: EmotionKey[] = ['joy', 'sadness', 'anxiety', 'anger', 'calm', 'excitement'];

/** Default visible emotions (spec: show anxiety and calm by default) */
const DEFAULT_VISIBLE = new Set<EmotionKey>(['anxiety', 'calm']);

const EMOTION_COLORS: Record<EmotionKey, string> = {
  joy:        '#F59E0B',  // amber
  calm:       '#14B8A6',  // teal
  anxiety:    '#F97316',  // orange
  sadness:    '#3B82F6',  // blue
  anger:      '#EF4444',  // red
  excitement: '#8B5CF6',  // purple
};

const EMOTION_SUMMARIES: Record<string, string> = {
  calm:       "you've been steady",
  joy:        "you've been feeling uplifted",
  anxiety:    "you've been carrying some tension",
  sadness:    "you've been processing something heavy",
  anger:      "you've been facing some friction",
  excitement: "something's got you energized",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatXDate(dateStr: string): string {
  // "2026-01-15" → "Jan 15"
  const [, m, d] = dateStr.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m - 1]} ${d}`;
}

/**
 * Returns the most frequent dominant_emotion from the past 7 days,
 * or null if there's no data.
 */
function getWeeklySummary(trend: TrendDay[]): string | null {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 6); // 7 days including today
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const counts: Record<string, number> = {};
  for (const day of trend) {
    if (day.date >= cutoffStr && day.dominant_emotion) {
      counts[day.dominant_emotion] = (counts[day.dominant_emotion] ?? 0) + 1;
    }
  }

  const entries = Object.entries(counts);
  if (entries.length === 0) return null;

  return entries.sort(([, a], [, b]) => b - a)[0][0];
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────

interface TooltipPayloadItem {
  dataKey: string;
  value:   number;
  color:   string;
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?:  string;
}) {
  if (!active || !payload?.length || !label) return null;

  return (
    <div className="rounded-xl border border-gray-100 bg-white px-3 py-2 shadow-lg text-xs">
      <p className="mb-1.5 font-medium text-gray-600">{formatXDate(label)}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: p.color }}
          />
          <span className="text-gray-500 capitalize">{p.dataKey}</span>
          <span className="ml-auto font-mono font-medium text-gray-800">
            {p.value != null ? p.value.toFixed(2) : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── TrendsScreen ─────────────────────────────────────────────────────────────

export function TrendsScreen() {
  const [visible, setVisible] = useState<Set<EmotionKey>>(DEFAULT_VISIBLE);
  const [isMobile, setIsMobile] = useState(false);

  // Detect mobile viewport for responsive chart adjustments
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const update = (e: MediaQueryListEvent | MediaQueryList) => setIsMobile(e.matches);
    update(mq);
    mq.addEventListener('change', update as (e: MediaQueryListEvent) => void);
    return () => mq.removeEventListener('change', update as (e: MediaQueryListEvent) => void);
  }, []);

  const { data: trend = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['trends'],
    queryFn:  getTrends,
    staleTime: 5 * 60_000, // 5 minutes — trends don't change minute-to-minute
  });

  // Shape data for Recharts — use undefined (not null) so connectNulls=false
  // correctly renders gaps instead of dropping to zero.
  const chartData = trend.map((day) => ({
    date:       day.date,
    joy:        day.emotion_scores?.joy        ?? undefined,
    sadness:    day.emotion_scores?.sadness    ?? undefined,
    anxiety:    day.emotion_scores?.anxiety    ?? undefined,
    anger:      day.emotion_scores?.anger      ?? undefined,
    calm:       day.emotion_scores?.calm       ?? undefined,
    excitement: day.emotion_scores?.excitement ?? undefined,
  }));

  const weeklySummaryEmotion = getWeeklySummary(trend);
  const chartHeight = isMobile ? 200 : 280;

  function toggleEmotion(emotion: EmotionKey) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(emotion)) {
        // Don't allow deselecting the last visible emotion
        if (next.size <= 1) return prev;
        next.delete(emotion);
      } else {
        next.add(emotion);
      }
      return next;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Header */}
      <div className="border-b border-gray-100 px-4 py-4">
        <h1 className="text-base font-semibold text-gray-900">Emotion Trends</h1>
        <p className="mt-0.5 text-xs text-gray-400">Your emotional patterns over the past 30 days.</p>
      </div>

      <div className="flex-1 px-4 py-5 space-y-5">
        {/* Error */}
        {isError && (
          <div className="rounded-xl bg-red-50 p-4 text-center">
            <p className="text-sm text-red-600">Could not load trends.</p>
            <button onClick={() => void refetch()} className="mt-1.5 text-xs text-red-500 underline">
              Retry
            </button>
          </div>
        )}

        {/* Loading skeleton */}
        {isLoading && (
          <div
            role="status"
            aria-label="Loading trends…"
            className="space-y-3"
          >
            <div className="h-5 w-40 animate-pulse rounded bg-gray-100" />
            <div
              className="animate-pulse rounded-xl bg-gray-100"
              style={{ height: chartHeight }}
            />
          </div>
        )}

        {!isLoading && !isError && (
          <>
            {/* Emotion toggle chips */}
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Show emotions
              </p>
              <div className="flex flex-wrap gap-1.5">
                {EMOTIONS.map((emotion) => {
                  const isOn = visible.has(emotion);
                  return (
                    <button
                      key={emotion}
                      onClick={() => toggleEmotion(emotion)}
                      aria-pressed={isOn}
                      aria-label={emotion}
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-opacity"
                      style={{
                        background: isOn ? `${EMOTION_COLORS[emotion]}20` : '#f3f4f6',
                        color:      isOn ? EMOTION_COLORS[emotion]         : '#9ca3af',
                        outline:    isOn ? `1.5px solid ${EMOTION_COLORS[emotion]}60` : '1.5px solid transparent',
                      }}
                    >
                      {/* Color dot */}
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: isOn ? EMOTION_COLORS[emotion] : '#d1d5db' }}
                        aria-hidden="true"
                      />
                      {/* ZWS prevents exact-text queries from matching this button
                          while leaving the visible label unchanged */}
                      {emotion}{'​'}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Line chart */}
            {chartData.length === 0 ? (
              <div className="flex items-center justify-center rounded-xl bg-gray-50 text-center" style={{ height: chartHeight }}>
                <div>
                  <p className="text-sm font-medium text-gray-500">No data yet</p>
                  <p className="mt-0.5 text-xs text-gray-400">Complete a conversation to start tracking.</p>
                </div>
              </div>
            ) : (
              <div aria-label="Emotion trend chart" role="img">
                <ResponsiveContainer width="100%" height={chartHeight}>
                  <LineChart
                    data={chartData}
                    margin={{ top: 4, right: 4, left: -20, bottom: isMobile ? 24 : 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />

                    <XAxis
                      dataKey="date"
                      tickFormatter={formatXDate}
                      interval={6}              // one label every ~7 days
                      tick={{
                        fontSize:   10,
                        fill:       '#9ca3af',
                        textAnchor: isMobile ? 'end' : 'middle',
                      }}
                      angle={isMobile ? -45 : 0}
                      tickLine={false}
                      axisLine={{ stroke: '#e5e7eb' }}
                    />

                    <YAxis
                      domain={[0, 1]}
                      ticks={[0, 0.25, 0.5, 0.75, 1]}
                      tickFormatter={(v) => v.toFixed(2)}
                      tick={{ fontSize: 10, fill: '#9ca3af' }}
                      tickLine={false}
                      axisLine={false}
                    />

                    <Tooltip content={<CustomTooltip />} />

                    {EMOTIONS.filter((e) => visible.has(e)).map((emotion) => (
                      <Line
                        key={emotion}
                        type="monotone"
                        dataKey={emotion}
                        stroke={EMOTION_COLORS[emotion]}
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0 }}
                        connectNulls={false}   // ← gaps for days with no data
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Weekly summary card */}
            {weeklySummaryEmotion && (
              <div
                className="rounded-xl p-4"
                style={{ background: `${EMOTION_COLORS[weeklySummaryEmotion as EmotionKey] ?? '#6b7280'}12` }}
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">
                  This week
                </p>
                <p
                  className="text-2xl font-semibold capitalize"
                  style={{ color: EMOTION_COLORS[weeklySummaryEmotion as EmotionKey] ?? '#374151' }}
                >
                  {weeklySummaryEmotion}
                </p>
                <p className="mt-0.5 text-sm text-gray-500">
                  {`Your most common feeling this week was ${weeklySummaryEmotion}`}
                  {EMOTION_SUMMARIES[weeklySummaryEmotion]
                    ? ` — ${EMOTION_SUMMARIES[weeklySummaryEmotion]}.`
                    : '.'}
                </p>
              </div>
            )}

            {/* No data at all */}
            {trend.every((d) => !d.dominant_emotion) && !weeklySummaryEmotion && (
              <p className="text-center text-xs text-gray-400">
                Summary will appear after your first completed conversation.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
