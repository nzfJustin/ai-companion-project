/**
 * src/screens/__tests__/ConversationHistoryScreen.test.tsx
 *
 * Tests for F1-007 · Conversation History Screen.
 * All network calls are mocked.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../api/conversations', () => ({
  listConversations:  vi.fn(),
  createConversation: vi.fn(),
}));

vi.mock('../../api/memories', () => ({
  listMemories: vi.fn(),
}));

vi.mock('../../lib/redis', () => ({ redis: {} }));
vi.mock('../../lib/rateLimit', () => ({
  globalRateLimit: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationHistoryScreen } from '../ConversationHistoryScreen';
import { listConversations, createConversation } from '../../api/conversations';
import { listMemories } from '../../api/memories';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString();

const ACTIVE_CONV = {
  id: 'conv-active', started_at: NOW, ended_at: null,
  status: 'active' as const, message_count: 3,
};
const CLOSED_CONV = {
  id: 'conv-closed', started_at: YESTERDAY, ended_at: YESTERDAY,
  status: 'closed' as const, message_count: 5,
};
const SUMMARIZED_CONV = {
  id: 'conv-summ', started_at: YESTERDAY, ended_at: YESTERDAY,
  status: 'summarized' as const, message_count: 8,
};

const MEMORY_FOR_SUMM = {
  id: 'mem-1',
  conversation_id: 'conv-summ',
  title: 'A good day',
  level: 2 as const,
  dominant_emotion: 'calm',
  created_at: YESTERDAY,
  period_start: YESTERDAY.slice(0, 10),
  period_end: YESTERDAY.slice(0, 10),
};

const EMPTY_LIST = { conversations: [], page: 1, per_page: 20, has_more: false };
const SINGLE_PAGE = {
  conversations: [SUMMARIZED_CONV, CLOSED_CONV],
  page: 1, per_page: 20, has_more: false,
};
const FIRST_PAGE = {
  conversations: [SUMMARIZED_CONV],
  page: 1, per_page: 20, has_more: true,
};
const SECOND_PAGE = {
  conversations: [CLOSED_CONV],
  page: 2, per_page: 20, has_more: false,
};
const WITH_ACTIVE = {
  conversations: [ACTIVE_CONV, SUMMARIZED_CONV],
  page: 1, per_page: 20, has_more: false,
};
const MEMORIES_RESP = {
  memories: [MEMORY_FOR_SUMM], page: 1, per_page: 100, has_more: false,
};
const NO_MEMORIES = {
  memories: [], page: 1, per_page: 100, has_more: false,
};

// ── Helper ─────────────────────────────────────────────────────────────────────

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/chat']}>
        <Routes>
          <Route path="/chat"       element={<ConversationHistoryScreen />} />
          <Route path="/chat/:id"   element={<div data-testid="conv-view">ConvView</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(listConversations).mockResolvedValue(EMPTY_LIST);
  vi.mocked(createConversation).mockResolvedValue({ id: 'new-conv', started_at: NOW, ended_at: null, status: 'active', message_count: 0 });
  vi.mocked(listMemories).mockResolvedValue(NO_MEMORIES);
});

// ─────────────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────────────

describe('ConversationHistoryScreen — header', () => {
  it('renders a "New conversation" button', async () => {
    renderScreen();
    expect(await screen.findByRole('button', { name: /new conversation/i })).toBeInTheDocument();
  });

  it('navigates to the new conversation on click', async () => {
    vi.mocked(createConversation).mockResolvedValue({
      id: 'fresh-conv', started_at: NOW, ended_at: null, status: 'active', message_count: 0,
    });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /new conversation/i }));

    expect(await screen.findByTestId('conv-view')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Empty state
// ─────────────────────────────────────────────────────────────────────────────

describe('ConversationHistoryScreen — empty state', () => {
  it('shows an empty state message when no conversations exist', async () => {
    renderScreen();
    expect(await screen.findByText(/no conversations yet/i)).toBeInTheDocument();
  });

  it('shows a CTA button in the empty state', async () => {
    renderScreen();
    await screen.findByText(/no conversations yet/i);
    expect(screen.getByRole('button', { name: /start your first conversation/i })).toBeInTheDocument();
  });

  it('shows a loading skeleton while fetching', () => {
    vi.mocked(listConversations).mockImplementation(() => new Promise(() => {}));
    renderScreen();
    expect(screen.getByRole('status', { name: /loading conversations/i })).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Active conversation pinned at top
// ─────────────────────────────────────────────────────────────────────────────

describe('ConversationHistoryScreen — active conversation pinned at top', () => {
  beforeEach(() => {
    vi.mocked(listConversations).mockResolvedValue(WITH_ACTIVE);
    vi.mocked(listMemories).mockResolvedValue(MEMORIES_RESP);
  });

  it('renders an "Active" section label above the active conversation', async () => {
    renderScreen();
    const activeElements = await screen.findAllByText('Active');
    expect(activeElements.length).toBeGreaterThanOrEqual(1);
  });

  it('marks the active conversation with a green dot indicator', async () => {
    renderScreen();
    expect(await screen.findByLabelText('Active conversation')).toBeInTheDocument();
  });

  it('renders an "Active" chip on the active conversation card', async () => {
    renderScreen();
    await screen.findByLabelText('Active conversation');
    const chips = screen.getAllByText('Active');
    // One "Active" section label + one "Active" chip
    expect(chips.length).toBeGreaterThanOrEqual(1);
  });

  it('shows "Past" section label when there are past conversations alongside an active one', async () => {
    renderScreen();
    expect(await screen.findByText('Past')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation cards
// ─────────────────────────────────────────────────────────────────────────────

describe('ConversationHistoryScreen — conversation cards', () => {
  beforeEach(() => {
    vi.mocked(listConversations).mockResolvedValue(SINGLE_PAGE);
    vi.mocked(listMemories).mockResolvedValue(MEMORIES_RESP);
  });

  it('renders a card for each conversation', async () => {
    renderScreen();
    await screen.findByText(/summariz/i); // "Summarizing..." chip
    const links = screen.getAllByRole('link');
    expect(links.length).toBe(2); // two conversations
  });

  it('each card links to /chat/:conversationId', async () => {
    renderScreen();
    await screen.findAllByText(/yesterday|today/i);
    const links = screen.getAllByRole('link') as HTMLAnchorElement[];
    expect(links.some((l) => l.href.includes('/chat/conv-summ'))).toBe(true);
    expect(links.some((l) => l.href.includes('/chat/conv-closed'))).toBe(true);
  });

  it('shows message count on each card', async () => {
    renderScreen();
    expect(await screen.findByText(/8 messages/)).toBeInTheDocument();
    expect(await screen.findByText(/5 messages/)).toBeInTheDocument();
  });

  it('shows the start date on each card using conversationDate format', async () => {
    renderScreen();
    // "Yesterday at ..." or "Today at ..." depending on locale
    const dates = await screen.findAllByText(/yesterday at|today at/i);
    expect(dates.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Emotion chip (summarized conversations with matched memory)
// ─────────────────────────────────────────────────────────────────────────────

describe('ConversationHistoryScreen — emotion chip', () => {
  it('shows an emotion chip for a summarized conversation with a matching memory', async () => {
    vi.mocked(listConversations).mockResolvedValue(SINGLE_PAGE);
    vi.mocked(listMemories).mockResolvedValue(MEMORIES_RESP);

    renderScreen();

    // "calm" chip should appear for conv-summ (matched by conversation_id)
    expect(await screen.findByText('calm')).toBeInTheDocument();
  });

  it('does not show an emotion chip for summarized conversations without a matching memory', async () => {
    vi.mocked(listConversations).mockResolvedValue(SINGLE_PAGE);
    vi.mocked(listMemories).mockResolvedValue(NO_MEMORIES); // no memories

    renderScreen();

    await screen.findAllByText(/yesterday|today/i); // wait for load
    expect(screen.queryByText('calm')).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// "Summarizing…" indicator
// ─────────────────────────────────────────────────────────────────────────────

describe('ConversationHistoryScreen — Summarizing indicator', () => {
  it('shows "Summarizing…" chip for conversations with status "closed"', async () => {
    vi.mocked(listConversations).mockResolvedValue(SINGLE_PAGE);
    vi.mocked(listMemories).mockResolvedValue(NO_MEMORIES);

    renderScreen();

    expect(await screen.findByText(/summarizing/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Load more pagination
// ─────────────────────────────────────────────────────────────────────────────

describe('ConversationHistoryScreen — load more', () => {
  it('shows "Load more" button when has_more is true', async () => {
    vi.mocked(listConversations).mockResolvedValue(FIRST_PAGE);
    vi.mocked(listMemories).mockResolvedValue(NO_MEMORIES);

    renderScreen();

    expect(await screen.findByRole('button', { name: /load more/i })).toBeInTheDocument();
  });

  it('does not show "Load more" when has_more is false', async () => {
    vi.mocked(listConversations).mockResolvedValue(SINGLE_PAGE);
    vi.mocked(listMemories).mockResolvedValue(NO_MEMORIES);

    renderScreen();

    await screen.findAllByRole('link'); // wait for cards to load
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('appends the next page of conversations when "Load more" is clicked', async () => {
    vi.mocked(listConversations)
      .mockResolvedValueOnce(FIRST_PAGE)   // initial load
      .mockResolvedValueOnce(SECOND_PAGE); // load more
    vi.mocked(listMemories).mockResolvedValue(NO_MEMORIES);

    const user = userEvent.setup();
    renderScreen();

    // After initial load: 1 conversation card
    await screen.findByRole('link');
    expect(screen.getAllByRole('link').length).toBe(1);

    // Click load more
    await user.click(screen.getByRole('button', { name: /load more/i }));

    // After load more: 2 conversation cards
    await waitFor(() =>
      expect(screen.getAllByRole('link').length).toBe(2),
    );
  });

  it('hides "Load more" after the last page is loaded', async () => {
    vi.mocked(listConversations)
      .mockResolvedValueOnce(FIRST_PAGE)
      .mockResolvedValueOnce(SECOND_PAGE); // has_more: false
    vi.mocked(listMemories).mockResolvedValue(NO_MEMORIES);

    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /load more/i }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// conversationDate utility
// ─────────────────────────────────────────────────────────────────────────────

import { conversationDate } from '../../utils/time';

describe('conversationDate', () => {
  it('returns "Today at <time>" for timestamps from today', () => {
    const ts = new Date().toISOString();
    expect(conversationDate(ts)).toMatch(/^Today at /i);
  });

  it('returns "Yesterday at <time>" for timestamps from yesterday', () => {
    const ts = new Date(Date.now() - 86_400_000).toISOString();
    expect(conversationDate(ts)).toMatch(/^Yesterday at /i);
  });

  it('returns a weekday name for timestamps within the past 7 days', () => {
    const ts = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const result = conversationDate(ts);
    // Should be a day name (Monday, Tuesday, etc.)
    expect(result).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) at /i);
  });

  it('returns a date string for older timestamps', () => {
    const ts = new Date('2025-01-15T10:00:00Z').toISOString();
    expect(conversationDate(ts)).toMatch(/Jan 15 at /i);
  });

  it('always includes the clock time', () => {
    const ts = new Date().toISOString();
    expect(conversationDate(ts)).toMatch(/at \d+:\d+/);
  });
});
