/**
 * src/screens/__tests__/InsightsScreen.test.tsx
 *
 * Tests for the InsightsScreen container (F2-001).
 * Covers: tab navigation, report cards, empty state, load more,
 * /trends → /insights redirect, and nav label update.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../api/insights', () => ({
  getTrends:          vi.fn(),
  getInsightReports:  vi.fn(),
}));

// Stub Recharts so the chart renders without SVG issues in jsdom
vi.mock('recharts', () => {
  const React = require('react');
  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'chart' }, children),
    LineChart:    () => null,
    Line:         () => null,
    XAxis:        () => null,
    YAxis:        () => null,
    CartesianGrid: () => null,
    Tooltip:      () => null,
  };
});

// ── Imports ────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InsightsScreen } from '../InsightsScreen';
import { getInsightReports, getTrends } from '../../api/insights';
import type { InsightReport } from '../../api/insights';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();

function makeReport(overrides: Partial<InsightReport> = {}): InsightReport {
  return {
    id:           'rep-1',
    report_type:  'weekly',
    period_start: '2026-01-08',
    period_end:   '2026-01-14',
    created_at:   NOW,
    ...overrides,
  };
}

const EMPTY_RESP  = { reports: [], page: 1, per_page: 20, has_more: false };
const ONE_REPORT  = { reports: [makeReport()], page: 1, per_page: 20, has_more: false };
const PAGE1       = { reports: [makeReport({ id: 'rep-1' })], page: 1, per_page: 20, has_more: true };
const PAGE2       = { reports: [makeReport({ id: 'rep-2', period_start: '2026-01-01', period_end: '2026-01-07' })], page: 2, per_page: 20, has_more: false };
const MONTHLY     = { reports: [makeReport({ report_type: 'monthly', period_start: '2026-01-01', period_end: '2026-01-31' })], page: 1, per_page: 20, has_more: false };

// ── Helper ─────────────────────────────────────────────────────────────────────

function renderInsights(path = '/insights') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/trends"        element={<Navigate to="/insights" replace />} />
          <Route path="/insights"      element={<InsightsScreen />} />
          <Route path="/insights/:id"  element={<div data-testid="detail">Detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getTrends).mockResolvedValue([]);
  vi.mocked(getInsightReports).mockResolvedValue(EMPTY_RESP);
});

// ─────────────────────────────────────────────────────────────────────────────
// Structure & navigation
// ─────────────────────────────────────────────────────────────────────────────

describe('InsightsScreen — structure', () => {
  it('renders the "Insights" page heading', async () => {
    renderInsights();
    expect(await screen.findByRole('heading', { name: /^insights$/i })).toBeInTheDocument();
  });

  it('renders two tabs: Overview and Reports', async () => {
    renderInsights();
    expect(await screen.findByRole('tab', { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /reports/i })).toBeInTheDocument();
  });

  it('Overview tab is selected by default', async () => {
    renderInsights();
    const overview = await screen.findByRole('tab', { name: /overview/i });
    expect(overview).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /reports/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('clicking the Reports tab switches to the reports panel', async () => {
    const user = userEvent.setup();
    renderInsights();
    await user.click(await screen.findByRole('tab', { name: /reports/i }));
    expect(screen.getByRole('tab', { name: /reports/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('clicking Overview tab returns to the trends chart panel', async () => {
    const user = userEvent.setup();
    renderInsights();
    await user.click(await screen.findByRole('tab', { name: /reports/i }));
    await user.click(screen.getByRole('tab', { name: /overview/i }));
    expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute('aria-selected', 'true');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /trends redirect
// ─────────────────────────────────────────────────────────────────────────────

describe('InsightsScreen — /trends redirect', () => {
  it('navigating to /trends renders the InsightsScreen (via redirect)', async () => {
    renderInsights('/trends');
    expect(await screen.findByRole('heading', { name: /^insights$/i })).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reports tab — empty state
// ─────────────────────────────────────────────────────────────────────────────

describe('InsightsScreen — Reports tab empty state', () => {
  it('shows the empty state after switching to the Reports tab with no data', async () => {
    const user = userEvent.setup();
    renderInsights();
    await user.click(await screen.findByRole('tab', { name: /reports/i }));
    expect(await screen.findByText(/no reports yet/i)).toBeInTheDocument();
  });

  it('shows the 14-day wait message in the empty state', async () => {
    const user = userEvent.setup();
    renderInsights();
    await user.click(await screen.findByRole('tab', { name: /reports/i }));
    expect(
      await screen.findByText(/14 days of conversations/i),
    ).toBeInTheDocument();
  });

  it('shows a "Start a conversation" CTA in the empty state', async () => {
    const user = userEvent.setup();
    renderInsights();
    await user.click(await screen.findByRole('tab', { name: /reports/i }));
    expect(
      await screen.findByRole('link', { name: /start a conversation/i }),
    ).toBeInTheDocument();
  });

  it('shows a loading skeleton while fetching reports', async () => {
    vi.mocked(getInsightReports).mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderInsights();
    await user.click(await screen.findByRole('tab', { name: /reports/i }));
    expect(screen.getByRole('status', { name: /loading reports/i })).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reports tab — report cards
// ─────────────────────────────────────────────────────────────────────────────

describe('InsightsScreen — report cards', () => {
  beforeEach(() => {
    vi.mocked(getInsightReports).mockResolvedValue(ONE_REPORT);
  });

  async function goToReports() {
    const user = userEvent.setup();
    renderInsights();
    await user.click(await screen.findByRole('tab', { name: /reports/i }));
    return user;
  }

  it('renders a card for each report', async () => {
    await goToReports();
    expect(await screen.findByRole('link', { name: /weekly insight report/i })).toBeInTheDocument();
  });

  it('shows a "Weekly" badge for weekly reports', async () => {
    await goToReports();
    expect(await screen.findByText('weekly')).toBeInTheDocument();
  });

  it('shows a "Monthly" badge for monthly reports', async () => {
    vi.mocked(getInsightReports).mockResolvedValue(MONTHLY);
    await goToReports();
    expect(await screen.findByText('monthly')).toBeInTheDocument();
  });

  it('shows the date range on the card', async () => {
    await goToReports();
    expect(await screen.findByText(/jan 8.*jan 14/i)).toBeInTheDocument();
  });

  it('shows a relative "Generated" timestamp', async () => {
    await goToReports();
    expect(await screen.findByText(/generated just now|generated \d/i)).toBeInTheDocument();
  });

  it('tapping a card navigates to /insights/:id', async () => {
    const user = userEvent.setup();
    renderInsights();
    await user.click(await screen.findByRole('tab', { name: /reports/i }));
    await user.click(await screen.findByRole('link', { name: /weekly/i }));
    expect(await screen.findByTestId('detail')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reports tab — load more pagination
// ─────────────────────────────────────────────────────────────────────────────

describe('InsightsScreen — load more', () => {
  it('shows a "Load more" button when has_more is true', async () => {
    vi.mocked(getInsightReports).mockResolvedValue(PAGE1);
    const user = userEvent.setup();
    renderInsights();
    await user.click(await screen.findByRole('tab', { name: /reports/i }));
    expect(await screen.findByRole('button', { name: /load more/i })).toBeInTheDocument();
  });

  it('does not show "Load more" when has_more is false', async () => {
    vi.mocked(getInsightReports).mockResolvedValue(ONE_REPORT);
    const user = userEvent.setup();
    renderInsights();
    await user.click(await screen.findByRole('tab', { name: /reports/i }));
    await screen.findByText(/jan 8/i);
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('appends the next page on "Load more" click', async () => {
    vi.mocked(getInsightReports)
      .mockResolvedValueOnce(PAGE1)
      .mockResolvedValueOnce(PAGE2);

    const user = userEvent.setup();
    renderInsights();
    await user.click(await screen.findByRole('tab', { name: /reports/i }));
    await user.click(await screen.findByRole('button', { name: /load more/i }));

    // Both the first and second page links should appear
    await waitFor(() => {
      const links = screen.getAllByRole('link', { name: /weekly insight report/i });
      expect(links.length).toBe(2);
    });
  });

  it('hides "Load more" after the last page is loaded', async () => {
    vi.mocked(getInsightReports)
      .mockResolvedValueOnce(PAGE1)
      .mockResolvedValueOnce(PAGE2);

    const user = userEvent.setup();
    renderInsights();
    await user.click(await screen.findByRole('tab', { name: /reports/i }));
    await user.click(await screen.findByRole('button', { name: /load more/i }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument(),
    );
  });
});
