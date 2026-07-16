/**
 * src/screens/__tests__/InsightReportScreen.test.tsx
 *
 * Tests for F2-002 · Insight Report Detail Screen.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../api/insights', () => ({
  getInsightReport: vi.fn(),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InsightReportScreen } from '../InsightReportScreen';
import { ApiError } from '../../api/client';
import { getInsightReport } from '../../api/insights';
import type { InsightReportDetail } from '../../api/insights';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const BASE_REPORT: InsightReportDetail = {
  id:           'rep-abc',
  report_type:  'weekly',
  period_start: '2026-01-08',
  period_end:   '2026-01-14',
  created_at:   new Date().toISOString(),
  content: [
    'This week you engaged in three meaningful conversations, each touching on themes of work pressure and the desire for balance.',
    'Your emotional scores showed a gradual shift toward calm by mid-week, suggesting that the strategies you discussed — taking short breaks, naming your feelings — may be having a positive effect.',
    'Anxiety remained elevated on Monday and Tuesday but decreased notably by Thursday.',
  ].join('\n\n'),
  patterns: [
    {
      description:    'Elevated anxiety on Monday mornings',
      severity:       'medium',
      first_observed: '2026-01-08',
      frequency:      '3 times in the last 4 weeks',
    },
    {
      description:    'Positive mood shift after physical activity',
      severity:       'low',
      first_observed: '2026-01-10',
      frequency:      'Observed twice this week',
    },
  ],
  goal_progress: [
    {
      goal:       'Reduce work-related stress',
      assessment: 'improving',
      evidence:   'Your anxiety scores on work days decreased from 0.8 to 0.5 over the reporting period.',
    },
  ],
  meta: {
    pattern_data_insufficient: false,
    word_count:                187,
  },
};

const MONTHLY_REPORT: InsightReportDetail = {
  ...BASE_REPORT,
  id:           'rep-monthly',
  report_type:  'monthly',
  period_start: '2026-01-01',
  period_end:   '2026-01-31',
  meta:         { pattern_data_insufficient: false, word_count: 423 },
};

const INSUFFICIENT_DATA_REPORT: InsightReportDetail = {
  ...BASE_REPORT,
  patterns: [],
  meta:     { pattern_data_insufficient: true, word_count: 98 },
};

const NO_GOALS_REPORT: InsightReportDetail = {
  ...BASE_REPORT,
  goal_progress: [],
};

// ── Helper ─────────────────────────────────────────────────────────────────────

function renderScreen(id = 'rep-abc') {
  const client = new QueryClient({
    // retry: false has no effect here — InsightReportScreen sets its own
    // per-query retry function (skip retry on 404/403, else retry twice).
    // retryDelay: 0 keeps those retries from waiting on real backoff timers.
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/insights/${id}`]}>
        <Routes>
          <Route path="/insights/:id" element={<InsightReportScreen />} />
          <Route path="/insights"     element={<div data-testid="insights-list">Insights List</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getInsightReport).mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Loading state
// ─────────────────────────────────────────────────────────────────────────────

describe('InsightReportScreen — loading', () => {
  it('shows a loading skeleton while the report is fetching', () => {
    vi.mocked(getInsightReport).mockImplementation(() => new Promise(() => {}));
    renderScreen();
    expect(screen.getByRole('status', { name: /loading report/i })).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────────────

describe('InsightReportScreen — header', () => {
  beforeEach(() => {
    vi.mocked(getInsightReport).mockResolvedValue(BASE_REPORT);
  });

  it('renders a "Back to Insights" link', async () => {
    renderScreen();
    const link = await screen.findByRole('link', { name: /back to insights/i });
    expect(link).toBeInTheDocument();
    expect((link as HTMLAnchorElement).href).toMatch(/\/insights$/);
  });

  it('shows a "weekly insight" badge for a weekly report', async () => {
    renderScreen();
    expect(await screen.findByText(/weekly insight/i)).toBeInTheDocument();
  });

  it('shows a "monthly insight" badge for a monthly report', async () => {
    vi.mocked(getInsightReport).mockResolvedValue(MONTHLY_REPORT);
    renderScreen();
    expect(await screen.findByText(/monthly insight/i)).toBeInTheDocument();
  });

  it('displays the date range as the page heading', async () => {
    renderScreen();
    expect(await screen.findByRole('heading', { name: /jan 8.*jan 14/i })).toBeInTheDocument();
  });

  it('shows the word count metadata', async () => {
    renderScreen();
    expect(await screen.findByText(/187 words/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Narrative section
// ─────────────────────────────────────────────────────────────────────────────

describe('InsightReportScreen — narrative section', () => {
  beforeEach(() => {
    vi.mocked(getInsightReport).mockResolvedValue(BASE_REPORT);
  });

  it('renders a "Summary" section heading', async () => {
    renderScreen();
    expect(await screen.findByRole('region', { name: /summary/i })).toBeInTheDocument();
  });

  it('renders all paragraphs of the narrative', async () => {
    renderScreen();
    // Each paragraph should be visible — check the first and last
    expect(
      await screen.findByText(/three meaningful conversations/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Anxiety remained elevated/),
    ).toBeInTheDocument();
  });

  it('renders three separate paragraph elements (split on double newlines)', async () => {
    renderScreen();
    await screen.findByText(/three meaningful conversations/i);
    // The content has 3 paragraphs joined by \n\n
    const region = screen.getByRole('region', { name: /summary/i });
    const paras = region.querySelectorAll('p');
    expect(paras.length).toBe(3);
  });

  it('does not truncate the narrative text', async () => {
    renderScreen();
    // All text from all paragraphs must appear, not just a prefix
    expect(await screen.findByText(/Observed twice this week/)).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Patterns section
// ─────────────────────────────────────────────────────────────────────────────

describe('InsightReportScreen — patterns section', () => {
  beforeEach(() => {
    vi.mocked(getInsightReport).mockResolvedValue(BASE_REPORT);
  });

  it('renders a "Patterns" section', async () => {
    renderScreen();
    expect(await screen.findByRole('region', { name: /patterns/i })).toBeInTheDocument();
  });

  it('renders each detected pattern', async () => {
    renderScreen();
    expect(
      await screen.findByText(/elevated anxiety on monday mornings/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/positive mood shift after physical activity/i),
    ).toBeInTheDocument();
  });

  it('shows a severity chip for each pattern', async () => {
    renderScreen();
    await screen.findByText(/elevated anxiety/i);
    expect(screen.getByText('Medium')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
  });

  it('shows the first_observed date and frequency for each pattern', async () => {
    renderScreen();
    expect(await screen.findByText(/first observed.*jan 8/i)).toBeInTheDocument();
    expect(screen.getByText(/3 times in the last 4 weeks/i)).toBeInTheDocument();
  });

  it('shows "not enough data yet" when meta.pattern_data_insufficient is true', async () => {
    vi.mocked(getInsightReport).mockResolvedValue(INSUFFICIENT_DATA_REPORT);
    renderScreen();
    expect(await screen.findByText(/not enough data yet/i)).toBeInTheDocument();
    expect(screen.getByText(/14 days of conversations/i)).toBeInTheDocument();
  });

  it('does not show the "not enough data" message when patterns are available', async () => {
    renderScreen();
    await screen.findByText(/elevated anxiety/i);
    expect(screen.queryByText(/not enough data yet/i)).not.toBeInTheDocument();
  });

  it('shows a "no patterns identified" message for sufficient data with empty patterns', async () => {
    vi.mocked(getInsightReport).mockResolvedValue({
      ...BASE_REPORT,
      patterns: [],
      meta: { pattern_data_insufficient: false, word_count: 180 },
    });
    renderScreen();
    expect(
      await screen.findByText(/no recurring patterns were identified/i),
    ).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Goal progress section
// ─────────────────────────────────────────────────────────────────────────────

describe('InsightReportScreen — goal progress section', () => {
  it('renders the Goal Progress section when goals exist', async () => {
    vi.mocked(getInsightReport).mockResolvedValue(BASE_REPORT);
    renderScreen();
    expect(await screen.findByRole('region', { name: /goal progress/i })).toBeInTheDocument();
  });

  it('shows each goal with its assessment pill and evidence', async () => {
    vi.mocked(getInsightReport).mockResolvedValue(BASE_REPORT);
    renderScreen();
    expect(await screen.findByText('Reduce work-related stress')).toBeInTheDocument();
    expect(screen.getByText('improving')).toBeInTheDocument();
    expect(screen.getByText(/anxiety scores.*decreased from/i)).toBeInTheDocument();
  });

  it('hides the Goal Progress section entirely when goal_progress is empty', async () => {
    vi.mocked(getInsightReport).mockResolvedValue(NO_GOALS_REPORT);
    renderScreen();
    await screen.findByText(/three meaningful conversations/i); // wait for load
    expect(screen.queryByRole('region', { name: /goal progress/i })).not.toBeInTheDocument();
  });

  it('shows correct pill for each assessment type', async () => {
    vi.mocked(getInsightReport).mockResolvedValue({
      ...BASE_REPORT,
      goal_progress: [
        { goal: 'Goal A', assessment: 'improving',  evidence: 'Better' },
        { goal: 'Goal B', assessment: 'stable',     evidence: 'Same' },
        { goal: 'Goal C', assessment: 'regressing', evidence: 'Worse' },
      ],
    });
    renderScreen();
    expect(await screen.findByText('improving')).toBeInTheDocument();
    expect(screen.getByText('stable')).toBeInTheDocument();
    expect(screen.getByText('regressing')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Back navigation
// ─────────────────────────────────────────────────────────────────────────────

describe('InsightReportScreen — back navigation', () => {
  it('clicking the back link navigates to /insights (not -1)', async () => {
    vi.mocked(getInsightReport).mockResolvedValue(BASE_REPORT);
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('link', { name: /back to insights/i }));
    expect(await screen.findByTestId('insights-list')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error states
// ─────────────────────────────────────────────────────────────────────────────

describe('InsightReportScreen — error states', () => {
  it('shows "Report not found" for a 404 response', async () => {
    vi.mocked(getInsightReport).mockRejectedValue(new ApiError(404, 'NOT_FOUND'));
    renderScreen();
    expect(await screen.findByText(/report not found/i)).toBeInTheDocument();
  });

  it('shows a "Back to Insights" link in the 404 state', async () => {
    vi.mocked(getInsightReport).mockRejectedValue(new ApiError(404, 'NOT_FOUND'));
    renderScreen();
    expect(
      await screen.findByRole('link', { name: /back to insights/i }),
    ).toBeInTheDocument();
  });

  it('shows a generic error message for non-404 errors', async () => {
    vi.mocked(getInsightReport).mockRejectedValue(new ApiError(500, 'INTERNAL_SERVER_ERROR'));
    renderScreen();
    expect(await screen.findByText(/could not load this report/i)).toBeInTheDocument();
  });

  it('does not retry on 404 errors', async () => {
    vi.mocked(getInsightReport).mockRejectedValue(new ApiError(404, 'NOT_FOUND'));
    renderScreen();
    await screen.findByText(/report not found/i);
    // If retries happened we'd see multiple calls
    expect(vi.mocked(getInsightReport)).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers (indirectly via the component)
// ─────────────────────────────────────────────────────────────────────────────

describe('InsightReportScreen — date formatting', () => {
  it('shows current-year dates without the year suffix', async () => {
    vi.mocked(getInsightReport).mockResolvedValue(BASE_REPORT);
    renderScreen();
    // period 2026-01-08 to 2026-01-14 in current year → no year
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).not.toMatch(/2026/);
  });

  it('includes the year suffix for dates from a previous year', async () => {
    vi.mocked(getInsightReport).mockResolvedValue({
      ...BASE_REPORT,
      period_start: '2024-06-01',
      period_end:   '2024-06-07',
    });
    renderScreen();
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toMatch(/2024/);
  });
});
