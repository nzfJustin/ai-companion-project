/**
 * src/screens/__tests__/MemoriesScreen.test.tsx
 *
 * Tests for F1-008 · Memory List Screen.
 * API calls are mocked; uses MemoryRouter with initialEntries so URL params
 * can be set and observed.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../api/memories', () => ({
  listMemories: vi.fn(),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoriesScreen } from '../MemoriesScreen';
import { listMemories } from '../../api/memories';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const MEM_L1 = {
  id: 'mem-1', conversation_id: 'conv-1',
  title: 'A quiet afternoon',
  level: 1 as const, dominant_emotion: 'calm',
  created_at: '2026-01-15T14:00:00Z',
  period_start: '2026-01-15', period_end: '2026-01-15',
};
const MEM_L3 = {
  id: 'mem-3', conversation_id: 'conv-3',
  title: 'Dealing with work pressure',
  level: 3 as const, dominant_emotion: 'anxiety',
  created_at: '2026-01-14T10:00:00Z',
  period_start: '2026-01-14', period_end: '2026-01-14',
};
const MEM_L4 = {
  id: 'mem-4', conversation_id: 'conv-4',
  title: 'A very private moment',
  level: 4 as const, dominant_emotion: 'sadness',
  created_at: '2026-01-13T09:00:00Z',
  period_start: '2026-01-13', period_end: '2026-01-13',
};
const MEM_L5 = {
  id: 'mem-5', conversation_id: 'conv-5',
  title: 'My deepest thoughts',
  level: 5 as const, dominant_emotion: 'joy',
  created_at: '2026-01-12T08:00:00Z',
  period_start: '2026-01-12', period_end: '2026-01-12',
};

const RESP_EMPTY  = { memories: [], page: 1, per_page: 20, has_more: false };
const RESP_SINGLE = { memories: [MEM_L1], page: 1, per_page: 20, has_more: false };
const RESP_MIXED  = { memories: [MEM_L1, MEM_L3, MEM_L4, MEM_L5], page: 1, per_page: 20, has_more: false };
const RESP_PAGE1  = { memories: [MEM_L1], page: 1, per_page: 20, has_more: true };
const RESP_PAGE2  = { memories: [MEM_L3], page: 2, per_page: 20, has_more: false };

// ── Render helper ─────────────────────────────────────────────────────────────

function renderScreen(initialSearch = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/memories${initialSearch}`]}>
        <Routes>
          <Route path="/memories"    element={<MemoriesScreen />} />
          <Route path="/memories/:id" element={<div data-testid="detail">Detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(listMemories).mockReset();
  vi.mocked(listMemories).mockResolvedValue(RESP_EMPTY);
});

// ─────────────────────────────────────────────────────────────────────────────
// Header + structure
// ─────────────────────────────────────────────────────────────────────────────

describe('MemoriesScreen — structure', () => {
  it('renders the "Memories" heading', async () => {
    renderScreen();
    expect(await screen.findByRole('heading', { name: /memories/i })).toBeInTheDocument();
  });

  it('shows loading skeleton while fetching', () => {
    vi.mocked(listMemories).mockImplementation(() => new Promise(() => {}));
    renderScreen();
    expect(screen.getByRole('status', { name: /loading memories/i })).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory cards
// ─────────────────────────────────────────────────────────────────────────────

describe('MemoriesScreen — memory cards', () => {
  it('renders a card for each memory', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_MIXED);
    renderScreen();
    expect(await screen.findByText('A quiet afternoon')).toBeInTheDocument();
    expect(screen.getByText('Dealing with work pressure')).toBeInTheDocument();
    expect(screen.getByText('A very private moment')).toBeInTheDocument();
    expect(screen.getByText('My deepest thoughts')).toBeInTheDocument();
  });

  it('each card links to /memories/:id', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_SINGLE);
    renderScreen();
    await screen.findByText('A quiet afternoon');
    const link = screen.getByRole('link', { name: /A quiet afternoon/ }) as HTMLAnchorElement;
    expect(link.href).toMatch(/\/memories\/mem-1$/);
  });

  it('shows the level badge for each card', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_MIXED);
    renderScreen();
    await screen.findByText('A quiet afternoon');
    expect(screen.getByText('L1')).toBeInTheDocument();
    expect(screen.getByText('L3')).toBeInTheDocument();
  });

  it('shows the dominant emotion chip for L1–3 cards', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_SINGLE);
    renderScreen();
    await screen.findByText('A quiet afternoon');
    expect(screen.getByText('calm')).toBeInTheDocument();
  });

  it('shows the date range for L1–3 cards', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_SINGLE);
    renderScreen();
    await screen.findByText('A quiet afternoon');
    expect(screen.getByText(/Jan 15, 2026/)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Level 4–5 locked cards
// ─────────────────────────────────────────────────────────────────────────────

describe('MemoriesScreen — locked Level 4–5 cards', () => {
  beforeEach(() => {
    vi.mocked(listMemories).mockResolvedValue(RESP_MIXED);
  });

  it('shows the title on L4 cards', async () => {
    renderScreen();
    expect(await screen.findByText('A very private moment')).toBeInTheDocument();
  });

  it('shows the level badge on L4 cards', async () => {
    renderScreen();
    await screen.findByText('A very private moment');
    expect(screen.getByText('L4')).toBeInTheDocument();
  });

  it('does NOT show the emotion chip on L4 cards', async () => {
    renderScreen();
    await screen.findByText('A very private moment');
    // 'sadness' is the emotion for L4 — should not appear
    expect(screen.queryByText('sadness')).not.toBeInTheDocument();
  });

  it('does NOT show the emotion chip on L5 cards', async () => {
    renderScreen();
    await screen.findByText('My deepest thoughts');
    // 'joy' is the emotion for L5 — should not appear
    expect(screen.queryByText('joy')).not.toBeInTheDocument();
  });

  it('shows a "Requires PIN to view" hint on locked cards', async () => {
    renderScreen();
    const hints = await screen.findAllByText(/requires pin to view/i);
    expect(hints.length).toBeGreaterThanOrEqual(2); // one for L4, one for L5
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Filter bar
// ─────────────────────────────────────────────────────────────────────────────

describe('MemoriesScreen — filter bar', () => {
  it('renders 5 level chips (L1–L5), all pressed by default', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: /memories/i });
    await waitFor(() => {
      for (let i = 1; i <= 5; i++) {
        const btn = screen.getByRole('button', { name: new RegExp(`L${i}`, 'i') });
        expect(btn).toHaveAttribute('aria-pressed', 'true');
      }
    });
  });

  it('renders "From" and "To" date inputs', async () => {
    renderScreen();
    expect(await screen.findByLabelText(/filter from date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/filter to date/i)).toBeInTheDocument();
  });

  it('deselects a level chip when clicked', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_EMPTY);
    const user = userEvent.setup();
    renderScreen();

    await screen.findByRole('heading', { name: /memories/i });
    const l3btn = screen.getByRole('button', { name: /L3/i });
    await user.click(l3btn);

    expect(l3btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('re-fetches with the new level filter when a chip is toggled', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_EMPTY);
    const user = userEvent.setup();
    renderScreen();

    await screen.findByRole('heading', { name: /memories/i });
    const initialCallCount = vi.mocked(listMemories).mock.calls.length;

    await user.click(screen.getByRole('button', { name: /L3/i }));

    await waitFor(() =>
      expect(vi.mocked(listMemories).mock.calls.length).toBeGreaterThan(initialCallCount),
    );
  });

  it('re-fetches when from date changes', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_EMPTY);
    const user = userEvent.setup();
    renderScreen();

    await screen.findByRole('heading', { name: /memories/i });
    const fromInput = screen.getByLabelText(/filter from date/i);
    const initialCount = vi.mocked(listMemories).mock.calls.length;

    await user.type(fromInput, '2026-01-01');

    await waitFor(() =>
      expect(vi.mocked(listMemories).mock.calls.length).toBeGreaterThan(initialCount),
    );
  });

  it('shows "Clear filters" when any filter is active', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_EMPTY);
    const user = userEvent.setup();
    renderScreen();

    await screen.findByRole('heading', { name: /memories/i });

    // Initially no clear button
    expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument();

    // Deselect one level
    await user.click(screen.getByRole('button', { name: /L2/i }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /clear filters/i })).toBeInTheDocument(),
    );
  });

  it('resets all filters when "Clear filters" is clicked', async () => {
    // Render with a pre-set level filter in the URL
    vi.mocked(listMemories).mockResolvedValue(RESP_EMPTY);
    const user = userEvent.setup();
    renderScreen('?level=1,2');

    await screen.findByRole('heading', { name: /memories/i });

    await user.click(screen.getByRole('button', { name: /clear filters/i }));

    await waitFor(() => {
      // All level chips should now be selected again
      const l3btn = screen.getByRole('button', { name: /L3/i });
      expect(l3btn).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('reads initial filters from the URL on mount', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_EMPTY);
    renderScreen('?level=1,2&from=2026-01-01');

    await screen.findByRole('heading', { name: /memories/i });

    await waitFor(() => {
      expect(vi.mocked(listMemories)).toHaveBeenCalledWith(
        expect.objectContaining({ levels: '1,2', from: '2026-01-01' }),
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Empty states
// ─────────────────────────────────────────────────────────────────────────────

describe('MemoriesScreen — empty states', () => {
  it('shows "No memories yet" when there are no memories and no filters', async () => {
    renderScreen();
    expect(await screen.findByText(/no memories yet/i)).toBeInTheDocument();
  });

  it('shows a date-specific message when date filters are active but produce no results', async () => {
    renderScreen('?from=2026-01-01&to=2026-01-02');
    expect(await screen.findByText(/no memories in this date range/i)).toBeInTheDocument();
  });

  it('shows a level-specific message when level filter produces no results', async () => {
    renderScreen('?level=1');
    expect(await screen.findByText(/no memories at this level yet/i)).toBeInTheDocument();
  });

  it('shows "Clear filters" button in the empty state when filters are active', async () => {
    renderScreen('?level=1');
    await screen.findByText(/no memories at this level yet/i);
    const clearBtns = screen.getAllByRole('button', { name: /clear filters/i });
    expect(clearBtns.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Load more pagination
// ─────────────────────────────────────────────────────────────────────────────

describe('MemoriesScreen — load more', () => {
  it('shows "Load more" when has_more is true', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_PAGE1);
    renderScreen();
    expect(await screen.findByRole('button', { name: /load more/i })).toBeInTheDocument();
  });

  it('does not show "Load more" when has_more is false', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_SINGLE);
    renderScreen();
    await screen.findByText('A quiet afternoon');
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('appends the next page when "Load more" is clicked', async () => {
    vi.mocked(listMemories)
      .mockResolvedValueOnce(RESP_PAGE1)
      .mockResolvedValueOnce(RESP_PAGE2);
    const user = userEvent.setup();
    renderScreen();

    expect(await screen.findByText('A quiet afternoon')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText('Dealing with work pressure')).toBeInTheDocument();
    // Original card still present
    expect(screen.getByText('A quiet afternoon')).toBeInTheDocument();
  });

  it('hides "Load more" after the last page is loaded', async () => {
    vi.mocked(listMemories)
      .mockResolvedValueOnce(RESP_PAGE1)
      .mockResolvedValueOnce(RESP_PAGE2);
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /load more/i }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument(),
    );
  });

  it('filter changes re-fetch from page 1 and replace existing results', async () => {
    vi.mocked(listMemories)
      .mockResolvedValueOnce(RESP_PAGE1)  // initial load
      .mockResolvedValueOnce(RESP_PAGE2)  // load more (now in view)
      .mockResolvedValueOnce({ memories: [MEM_L4], page: 1, per_page: 20, has_more: false }); // after filter change

    const user = userEvent.setup();
    renderScreen();

    // Initial + load more
    await user.click(await screen.findByRole('button', { name: /load more/i }));
    expect(await screen.findByText('Dealing with work pressure')).toBeInTheDocument();
    expect(screen.getByText('A quiet afternoon')).toBeInTheDocument();

    // Toggle L3 off — should replace results
    await user.click(screen.getByRole('button', { name: /L3/i }));

    await waitFor(() => {
      // The final call should be with levels excluding 3
      const lastCall = vi.mocked(listMemories).mock.calls.at(-1)![0];
      expect(lastCall.levels).not.toContain('3');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2-003 — Semantic Memory Search tests
// ─────────────────────────────────────────────────────────────────────────────

describe('MemoriesScreen — F2-003 semantic search', () => {
  beforeEach(() => {
    vi.mocked(listMemories).mockResolvedValue(RESP_EMPTY);
  });

  // ── Search input always visible ──────────────────────────────────────────

  it('renders the search input above the filter bar', async () => {
    renderScreen();
    expect(await screen.findByRole('searchbox', { name: /search memories/i })).toBeInTheDocument();
  });

  it('shows the search input even when memories list is empty', async () => {
    renderScreen();
    await screen.findByText(/no memories yet/i);
    expect(screen.getByRole('searchbox', { name: /search memories/i })).toBeInTheDocument();
  });

  // ── Submit behaviour ─────────────────────────────────────────────────────

  it('pressing Enter with text in the search input adds ?q= to the URL', async () => {
    const user = userEvent.setup();
    renderScreen();

    const input = await screen.findByRole('searchbox', { name: /search memories/i });
    await user.type(input, 'work anxiety');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(vi.mocked(listMemories)).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'work anxiety' }),
      ),
    );
  });

  it('calls listMemories with the q param when search is submitted', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_SINGLE);
    const user = userEvent.setup();
    renderScreen();

    const input = await screen.findByRole('searchbox', { name: /search memories/i });
    await user.type(input, 'peaceful');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(vi.mocked(listMemories)).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'peaceful' }),
      ),
    );
  });

  it('does NOT submit when the input is empty', async () => {
    const user = userEvent.setup();
    renderScreen();

    await screen.findByRole('searchbox');
    const callsBefore = vi.mocked(listMemories).mock.calls.length;

    await user.keyboard('{Enter}');

    // Should not have added another call
    expect(vi.mocked(listMemories).mock.calls.length).toBe(callsBefore);
  });

  // ── Initialise from URL ?q= ───────────────────────────────────────────────

  it('populates the input from the URL ?q= param on mount', async () => {
    renderScreen('?q=hello%20world');
    const input = await screen.findByRole('searchbox', { name: /search memories/i });
    expect((input as HTMLInputElement).value).toBe('hello world');
  });

  it('fetches with the q param from the URL on mount', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_SINGLE);
    renderScreen('?q=calm+afternoon');
    await waitFor(() =>
      expect(vi.mocked(listMemories)).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'calm afternoon' }),
      ),
    );
  });

  // ── Filter bar hidden in search mode ─────────────────────────────────────

  it('hides the level chips while a search query is active', async () => {
    renderScreen('?q=hello');
    await screen.findByRole('searchbox');
    expect(screen.queryByRole('button', { name: /^L1$/i })).not.toBeInTheDocument();
  });

  it('hides the date range pickers while a search query is active', async () => {
    renderScreen('?q=hello');
    await screen.findByRole('searchbox');
    expect(screen.queryByLabelText(/filter from date/i)).not.toBeInTheDocument();
  });

  it('shows the filter bar when no search is active', async () => {
    renderScreen();
    expect(await screen.findByRole('button', { name: /^L1$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/filter from date/i)).toBeInTheDocument();
  });

  // ── Active search indicator ───────────────────────────────────────────────

  it('shows "Results for..." indicator when search is active', async () => {
    renderScreen('?q=work+stress');
    expect(await screen.findByText(/results for/i)).toBeInTheDocument();
    // The quoted query also appears in the empty-state message below, so
    // there are two matches by design — assert at least one is present.
    expect(screen.getAllByText(/"work stress"/).length).toBeGreaterThan(0);
  });

  it('shows a "Clear search" link in the active search indicator', async () => {
    renderScreen('?q=anxiety');
    // Two elements match /clear search/i by design: the × icon button in the
    // input (aria-label only, no visible text) and the text link in the
    // indicator — find the one with visible "Clear search" text.
    const buttons = await screen.findAllByRole('button', { name: /clear search/i });
    expect(buttons.some((b) => b.textContent === 'Clear search')).toBe(true);
  });

  // ── Clear search ──────────────────────────────────────────────────────────

  it('clicking the × button clears both the input and the search query', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_EMPTY);
    const user = userEvent.setup();
    renderScreen('?q=hello');

    await screen.findByRole('searchbox');
    // The × icon button renders before the text link in DOM order.
    const [clearIconButton] = screen.getAllByRole('button', { name: /clear search/i });
    await user.click(clearIconButton);

    await waitFor(() =>
      expect(screen.queryByText(/results for/i)).not.toBeInTheDocument(),
    );
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  });

  it('clearing search restores the previous filter state (level chips visible again)', async () => {
    const user = userEvent.setup();
    renderScreen('?level=1,2&q=hello');

    await screen.findByRole('searchbox');
    const [clearButton] = screen.getAllByRole('button', { name: /clear search/i });
    await user.click(clearButton);

    // Level chips should reappear
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^L1$/i })).toBeInTheDocument(),
    );
    // Level filter should still be active (2 of 5 selected)
    expect(screen.getByRole('button', { name: /^L1$/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^L3$/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('pressing Escape in the search input clears the search', async () => {
    const user = userEvent.setup();
    renderScreen('?q=test');

    const input = await screen.findByRole('searchbox');
    await user.type(input, '{Escape}');

    await waitFor(() =>
      expect(screen.queryByText(/results for/i)).not.toBeInTheDocument(),
    );
  });

  // ── No Load more in search mode ───────────────────────────────────────────

  it('does not show Load more when in search mode even if has_more is true', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_PAGE1); // has_more: true
    renderScreen('?q=calm');

    await screen.findByText('A quiet afternoon'); // wait for results
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  // ── Search empty state ────────────────────────────────────────────────────

  it('shows the search query in the empty state message', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_EMPTY);
    renderScreen('?q=something+obscure');

    expect(await screen.findByText(/"something obscure"/i)).toBeInTheDocument();
    expect(screen.getByText(/try different words/i)).toBeInTheDocument();
  });

  it('shows a "Clear search" button in the search empty state', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_EMPTY);
    renderScreen('?q=xyz123');

    await screen.findByText(/"xyz123"/i);
    const clearBtns = screen.getAllByRole('button', { name: /clear search/i });
    expect(clearBtns.length).toBeGreaterThanOrEqual(1);
  });

  // ── Search does not pass level/date params ────────────────────────────────

  it('does not send level or date params when in search mode', async () => {
    vi.mocked(listMemories).mockResolvedValue(RESP_EMPTY);
    renderScreen('?level=1,2&from=2026-01-01&q=hello');

    await waitFor(() => {
      const call = vi.mocked(listMemories).mock.calls.find(
        ([p]) => p.q === 'hello',
      );
      expect(call).toBeDefined();
      const params = call![0];
      expect(params.levels).toBeUndefined();
      expect(params.from).toBeUndefined();
      expect(params.to).toBeUndefined();
    });
  });
});
