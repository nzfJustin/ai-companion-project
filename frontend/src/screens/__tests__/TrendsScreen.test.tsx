/**
 * src/screens/__tests__/TrendsScreen.test.tsx
 *
 * Tests for F1-010 · Emotion Trends Dashboard.
 *
 * Recharts is mocked to a simple functional stub so we can test data flow
 * without fighting SVG rendering in jsdom. The chart itself is tested
 * structurally (correct data passed, correct emotions rendered) not visually.
 */

// ── Mock Recharts (SVG components don't render in jsdom) ──────────────────────

vi.mock('recharts', () => {
  const React = require('react');
  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'chart-container' }, children),
    LineChart: ({ data, children }: { data: unknown[]; children: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'line-chart', 'data-points': data.length }, children),
    Line: ({ dataKey, stroke, connectNulls }: { dataKey: string; stroke: string; connectNulls: boolean }) =>
      React.createElement('div', {
        'data-testid': `line-${dataKey}`,
        'data-stroke': stroke,
        'data-connect-nulls': String(connectNulls),
      }),
    XAxis:       () => null,
    YAxis:       () => null,
    CartesianGrid: () => null,
    Tooltip:     () => null,
  };
});

// ── Mock API ───────────────────────────────────────────────────────────────────

vi.mock('../../api/insights', () => ({
  getTrends: vi.fn(),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TrendsScreen } from '../TrendsScreen';
import { getTrends }   from '../../api/insights';
import type { TrendDay } from '../../api/insights';

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeTrend(overrides: Partial<TrendDay> = {}, dateOffset = 0): TrendDay {
  const d = new Date();
  d.setDate(d.getDate() - dateOffset);
  return {
    date:             d.toISOString().slice(0, 10),
    dominant_emotion: 'calm',
    emotion_scores: {
      joy: 0.5, sadness: 0.2, anxiety: 0.3, anger: 0.1, calm: 0.7, excitement: 0.4,
    },
    ...overrides,
  };
}

/** 30-day array: 5 days with data, 25 days null */
function make30DayTrend(): TrendDay[] {
  const result: TrendDay[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    result.push(
      i % 5 === 0
        ? makeTrend({}, i)
        : { date: d.toISOString().slice(0, 10), dominant_emotion: null, emotion_scores: null },
    );
  }
  return result;
}

const FULL_TREND = make30DayTrend();

// ── Helper ─────────────────────────────────────────────────────────────────────

function renderTrends() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TrendsScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getTrends).mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Structure
// ─────────────────────────────────────────────────────────────────────────────

describe('TrendsScreen — structure', () => {
  it('shows "Emotion Trends" heading', async () => {
    vi.mocked(getTrends).mockResolvedValue(FULL_TREND);
    renderTrends();
    expect(await screen.findByRole('heading', { name: /emotion trends/i })).toBeInTheDocument();
  });

  it('shows a loading state while fetching', () => {
    vi.mocked(getTrends).mockImplementation(() => new Promise(() => {}));
    renderTrends();
    expect(screen.getByRole('status', { name: /loading trends/i })).toBeInTheDocument();
  });

  it('shows an error state if the API fails', async () => {
    vi.mocked(getTrends).mockRejectedValue(new Error('Network error'));
    renderTrends();
    expect(await screen.findByText(/could not load trends/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chart data — 30 points, gaps for null days
// ─────────────────────────────────────────────────────────────────────────────

describe('TrendsScreen — chart data', () => {
  it('passes 30 data points to the chart', async () => {
    vi.mocked(getTrends).mockResolvedValue(FULL_TREND);
    renderTrends();
    const chart = await screen.findByTestId('line-chart');
    expect(chart.getAttribute('data-points')).toBe('30');
  });

  it('renders line components for the visible emotions (default: anxiety + calm)', async () => {
    vi.mocked(getTrends).mockResolvedValue(FULL_TREND);
    renderTrends();
    await screen.findByTestId('line-chart');
    expect(screen.getByTestId('line-anxiety')).toBeInTheDocument();
    expect(screen.getByTestId('line-calm')).toBeInTheDocument();
  });

  it('does NOT render lines for hidden emotions by default (joy, sadness, anger, excitement)', async () => {
    vi.mocked(getTrends).mockResolvedValue(FULL_TREND);
    renderTrends();
    await screen.findByTestId('line-chart');
    expect(screen.queryByTestId('line-joy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('line-sadness')).not.toBeInTheDocument();
    expect(screen.queryByTestId('line-anger')).not.toBeInTheDocument();
    expect(screen.queryByTestId('line-excitement')).not.toBeInTheDocument();
  });

  it('each Line has connectNulls=false so null days render as gaps', async () => {
    vi.mocked(getTrends).mockResolvedValue(FULL_TREND);
    renderTrends();
    await screen.findByTestId('line-chart');
    const anxietyLine = screen.getByTestId('line-anxiety');
    expect(anxietyLine.getAttribute('data-connect-nulls')).toBe('false');
  });

  it('each emotion Line has a distinct stroke color', async () => {
    vi.mocked(getTrends).mockResolvedValue(FULL_TREND);
    const user = userEvent.setup();
    renderTrends();

    // Toggle on all emotions first
    for (const emotion of ['joy', 'sadness', 'anger', 'excitement']) {
      await user.click(await screen.findByRole('button', { name: new RegExp(emotion, 'i') }));
    }

    const colors = new Set(
      ['joy', 'sadness', 'anxiety', 'anger', 'calm', 'excitement'].map((e) =>
        screen.getByTestId(`line-${e}`).getAttribute('data-stroke'),
      ),
    );
    expect(colors.size).toBe(6); // all unique
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Emotion toggle row
// ─────────────────────────────────────────────────────────────────────────────

describe('TrendsScreen — emotion toggle row', () => {
  beforeEach(() => {
    vi.mocked(getTrends).mockResolvedValue(FULL_TREND);
  });

  it('renders 6 toggle chips', async () => {
    renderTrends();
    await screen.findByTestId('line-chart');
    for (const e of ['joy', 'sadness', 'anxiety', 'anger', 'calm', 'excitement']) {
      expect(screen.getByRole('button', { name: new RegExp(e, 'i') })).toBeInTheDocument();
    }
  });

  it('anxiety and calm chips are pressed by default', async () => {
    renderTrends();
    await screen.findByTestId('line-chart');
    expect(screen.getByRole('button', { name: /anxiety/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /calm/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('joy, sadness, anger, excitement chips are NOT pressed by default', async () => {
    renderTrends();
    await screen.findByTestId('line-chart');
    for (const e of ['joy', 'sadness', 'anger', 'excitement']) {
      expect(screen.getByRole('button', { name: new RegExp(e, 'i') }))
        .toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('toggling a chip on adds its line to the chart', async () => {
    const user = userEvent.setup();
    renderTrends();
    await screen.findByTestId('line-chart');

    expect(screen.queryByTestId('line-joy')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^joy$/i }));
    expect(screen.getByTestId('line-joy')).toBeInTheDocument();
  });

  it('toggling a chip off removes its line from the chart', async () => {
    const user = userEvent.setup();
    renderTrends();
    await screen.findByTestId('line-chart');

    expect(screen.getByTestId('line-calm')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^calm$/i }));
    expect(screen.queryByTestId('line-calm')).not.toBeInTheDocument();
  });

  it('cannot deselect the last visible emotion', async () => {
    const user = userEvent.setup();
    renderTrends();
    await screen.findByTestId('line-chart');

    // Turn off calm (leaving anxiety as the only visible)
    await user.click(screen.getByRole('button', { name: /^calm$/i }));
    // Now try to turn off anxiety too
    await user.click(screen.getByRole('button', { name: /^anxiety$/i }));
    // Anxiety should still be visible
    expect(screen.getByTestId('line-anxiety')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Weekly summary card
// ─────────────────────────────────────────────────────────────────────────────

describe('TrendsScreen — weekly summary card', () => {
  it('shows the most frequent dominant_emotion from the past 7 days', async () => {
    // 5 days ago: calm; 3 days ago: anxiety; today: calm → calm wins
    const trend = make30DayTrend();
    const today = new Date();
    const d5 = new Date(today); d5.setDate(d5.getDate() - 5);
    const d3 = new Date(today); d3.setDate(d3.getDate() - 3);

    const patchedTrend = trend.map((day) => {
      if (day.date === d5.toISOString().slice(0, 10)) {
        return { ...day, dominant_emotion: 'calm' };
      }
      if (day.date === d3.toISOString().slice(0, 10)) {
        return { ...day, dominant_emotion: 'anxiety' };
      }
      if (day.date === today.toISOString().slice(0, 10)) {
        return { ...day, dominant_emotion: 'calm' };
      }
      return { ...day, dominant_emotion: null };
    });

    vi.mocked(getTrends).mockResolvedValue(patchedTrend);
    renderTrends();

    expect(await screen.findByText('calm')).toBeInTheDocument();
    expect(screen.getByText(/most common feeling this week was/i)).toBeInTheDocument();
  });

  it('does not make a second API call for the summary (derived from chart data)', async () => {
    vi.mocked(getTrends).mockResolvedValue(FULL_TREND);
    renderTrends();
    await screen.findByTestId('line-chart');
    expect(vi.mocked(getTrends)).toHaveBeenCalledTimes(1);
  });

  it('shows no summary card when there is no data in the past 7 days', async () => {
    // All days have null dominant_emotion
    const emptyTrend: TrendDay[] = FULL_TREND.map((d) => ({
      ...d,
      dominant_emotion: null,
      emotion_scores: null,
    }));
    vi.mocked(getTrends).mockResolvedValue(emptyTrend);
    renderTrends();

    await screen.findByTestId('line-chart');
    expect(screen.queryByText(/most common feeling/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/summary will appear after/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getWeeklySummary utility (indirectly tested via component above,
// but tested directly here for edge cases)
// ─────────────────────────────────────────────────────────────────────────────

// Import the pure function if it were exported; instead test via the component
describe('TrendsScreen — summary edge cases', () => {
  it('ignores days older than 7 days when computing the summary', async () => {
    const trend = FULL_TREND.map((day, i) => ({
      ...day,
      // Old entries: joy; recent entries: calm
      dominant_emotion: i < 23 ? 'joy' : 'calm',
    }));
    vi.mocked(getTrends).mockResolvedValue(trend);
    renderTrends();

    // The summary should be "calm" (from the past 7 days), not "joy"
    const summaryEl = await screen.findByText(/most common feeling this week was/i);
    expect(summaryEl.textContent).toMatch(/calm/i);
    expect(summaryEl.textContent).not.toMatch(/joy/i);
  });
});
