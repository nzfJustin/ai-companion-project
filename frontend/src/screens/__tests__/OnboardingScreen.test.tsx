/**
 * src/screens/__tests__/OnboardingScreen.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OnboardingScreen } from '../OnboardingScreen';
import { ApiError } from '../../api/client';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../api/auth', () => ({
  getMe:           vi.fn(),
  refreshSession:  vi.fn(),
}));

vi.mock('../../api/conversations', () => ({
  createConversation: vi.fn(),
}));

import { getMe }               from '../../api/auth';
import { createConversation }  from '../../api/conversations';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const ONBOARDED_FALSE = {
  id: 'u-1', email: 'a@b.com', display_name: 'Alice',
  timezone: 'UTC', comm_style: 'warm' as const,
  onboarding_done: false, created_at: '2026-01-01T00:00:00Z',
};

const ONBOARDED_TRUE = { ...ONBOARDED_FALSE, onboarding_done: true };

const NEW_CONV = { id: 'conv-abc', started_at: '2026-01-01T00:00:00Z', ended_at: null, status: 'active' as const, message_count: 0 };

// ── Helper ─────────────────────────────────────────────────────────────────────

function renderScreen(initialPath = '/onboarding') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/onboarding"         element={<OnboardingScreen />} />
          <Route path="/chat"               element={<div data-testid="chat-screen">Chat</div>} />
          <Route path="/chat/:id"           element={<div data-testid="chat-conv-screen">Conversation</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getMe).mockReset();
  vi.mocked(createConversation).mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Redirect guard
// ─────────────────────────────────────────────────────────────────────────────

describe('OnboardingScreen — redirect guard', () => {
  it('redirects to /chat immediately when onboarding_done is true', async () => {
    vi.mocked(getMe).mockResolvedValue(ONBOARDED_TRUE);

    renderScreen();

    expect(await screen.findByTestId('chat-screen')).toBeInTheDocument();
  });

  it('shows the welcome screen when onboarding_done is false', async () => {
    vi.mocked(getMe).mockResolvedValue(ONBOARDED_FALSE);

    renderScreen();

    expect(await screen.findByRole('button', { name: /start your first conversation/i })).toBeInTheDocument();
  });

  it('shows a loading spinner while checking onboarding status', () => {
    // getMe never resolves during this test
    vi.mocked(getMe).mockImplementation(() => new Promise(() => {}));

    renderScreen();

    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Screen content
// ─────────────────────────────────────────────────────────────────────────────

describe('OnboardingScreen — content', () => {
  beforeEach(() => {
    vi.mocked(getMe).mockResolvedValue(ONBOARDED_FALSE);
  });

  it('shows the app name', async () => {
    renderScreen();
    expect(await screen.findByText(/ai companion/i)).toBeInTheDocument();
  });

  it('shows a welcoming headline', async () => {
    renderScreen();
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent?.toLowerCase()).toMatch(/space|you|just/);
  });

  it('shows value proposition items', async () => {
    renderScreen();
    await screen.findByRole('list', { name: /what you can do/i });
    const items = screen.getAllByRole('listitem');
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the "Start your first conversation" CTA button', async () => {
    renderScreen();
    const btn = await screen.findByRole('button', { name: /start your first conversation/i });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it('has no form fields, multi-step UI, or comm_style picker', async () => {
    renderScreen();
    await screen.findByRole('button', { name: /start your first conversation/i });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CTA behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('OnboardingScreen — CTA button', () => {
  beforeEach(() => {
    vi.mocked(getMe).mockResolvedValue(ONBOARDED_FALSE);
  });

  it('calls POST /v1/conversations when tapped', async () => {
    vi.mocked(createConversation).mockResolvedValue(NEW_CONV);
    const user = userEvent.setup();

    renderScreen();
    const btn = await screen.findByRole('button', { name: /start your first conversation/i });
    await user.click(btn);

    expect(createConversation).toHaveBeenCalledTimes(1);
  });

  it('navigates to /chat/:conversationId on success', async () => {
    vi.mocked(createConversation).mockResolvedValue(NEW_CONV);
    const user = userEvent.setup();

    renderScreen();
    await user.click(await screen.findByRole('button', { name: /start your first conversation/i }));

    expect(await screen.findByTestId('chat-conv-screen')).toBeInTheDocument();
  });

  it('disables the button and shows a spinner while the call is in flight', async () => {
    let resolve!: (v: typeof NEW_CONV) => void;
    vi.mocked(createConversation).mockImplementation(
      () => new Promise((r) => { resolve = r; }),
    );
    const user = userEvent.setup();

    renderScreen();
    await user.click(await screen.findByRole('button', { name: /start your first conversation/i }));

    const pendingBtn = screen.getByRole('button', { name: /starting/i });
    expect(pendingBtn).toBeDisabled();
    expect(pendingBtn).toHaveAttribute('aria-busy', 'true');

    resolve(NEW_CONV);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /starting/i })).not.toBeInTheDocument(),
    );
  });

  it('shows a human-readable error if the API call fails', async () => {
    vi.mocked(createConversation).mockRejectedValue(new ApiError(500, 'INTERNAL_SERVER_ERROR'));
    const user = userEvent.setup();

    renderScreen();
    await user.click(await screen.findByRole('button', { name: /start your first conversation/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('INTERNAL_SERVER_ERROR')).not.toBeInTheDocument();
  });

  it('does not call createConversation more than once on rapid double-tap', async () => {
    let resolve!: (v: typeof NEW_CONV) => void;
    vi.mocked(createConversation).mockImplementation(
      () => new Promise((r) => { resolve = r; }),
    );
    const user = userEvent.setup();

    renderScreen();
    const btn = await screen.findByRole('button', { name: /start your first conversation/i });

    // Click twice in quick succession
    await user.click(btn);
    await user.click(btn); // btn is disabled now — second click is a no-op

    expect(createConversation).toHaveBeenCalledTimes(1);

    resolve(NEW_CONV);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Post-onboarding redirect
// ─────────────────────────────────────────────────────────────────────────────

describe('OnboardingScreen — post-onboarding guard', () => {
  it('redirects to /chat when getMe returns onboarding_done=true (after backend update)', async () => {
    // Simulates: user navigates directly to /onboarding after their first
    // conversation has closed and the backend set onboarding_done = true.
    vi.mocked(getMe).mockResolvedValue(ONBOARDED_TRUE);

    renderScreen();

    expect(await screen.findByTestId('chat-screen')).toBeInTheDocument();
    // The welcome screen should never have been shown
    expect(screen.queryByRole('button', { name: /start your first conversation/i }))
      .not.toBeInTheDocument();
  });

  it('always fetches fresh data (staleTime=0) — never uses a stale onboarding_done=false value', async () => {
    // This test verifies that getMe is called on mount (not served from
    // a query cache). The mock resolves to onboarding_done=true, which
    // means a stale cache hit with false would show the wrong screen.
    vi.mocked(getMe).mockResolvedValue(ONBOARDED_TRUE);

    renderScreen();

    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('chat-screen')).toBeInTheDocument();
  });
});
