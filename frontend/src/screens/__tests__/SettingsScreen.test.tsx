/**
 * src/screens/__tests__/SettingsScreen.test.tsx
 *
 * Tests for F1-011 · Profile & Settings Screen.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../api/auth', () => ({
  getMe:      vi.fn(),
  patchMe:    vi.fn(),
  getStreak:  vi.fn(),
  logout:     vi.fn(),
}));

vi.mock('../../store/authStore', () => ({
  clearAuth:           vi.fn(),
  getAccessToken:      vi.fn(() => 'token'),
  getValidElevatedToken: vi.fn(() => null),
  useAuthStore:        vi.fn(() => ({ elevatedToken: null, setElevatedToken: vi.fn(), clearElevatedToken: vi.fn() })),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsScreen } from '../SettingsScreen';
import { getMe, patchMe, getStreak, logout } from '../../api/auth';
import { clearAuth } from '../../store/authStore';
import { ApiError } from '../../api/client';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const USER = {
  id: 'u-1', email: 'alice@example.com', display_name: 'Alice',
  timezone: 'America/New_York', comm_style: 'warm' as const,
  onboarding_done: true, created_at: '2026-01-01T00:00:00Z',
};
const STREAK_3 = { current_streak: 3, longest_streak: 5, last_active_date: '2026-01-15' };
const STREAK_0 = { current_streak: 0, longest_streak: 0, last_active_date: null };

// ── Helper ─────────────────────────────────────────────────────────────────────

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="/login"    element={<div data-testid="login">Login</div>} />
          <Route path="/chat"     element={<div data-testid="chat">Chat</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.mocked(getMe).mockResolvedValue(USER);
  vi.mocked(patchMe).mockResolvedValue(USER);
  vi.mocked(getStreak).mockResolvedValue(STREAK_3);
  vi.mocked(logout).mockResolvedValue(undefined);
  vi.mocked(clearAuth).mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Loading and structure
// ─────────────────────────────────────────────────────────────────────────────

describe('SettingsScreen — structure', () => {
  it('shows a loading spinner while fetching user data', () => {
    vi.mocked(getMe).mockImplementation(() => new Promise(() => {}));
    renderSettings();
    expect(screen.getByRole('status', { name: /loading settings/i })).toBeInTheDocument();
  });

  it('renders the "Profile & Settings" heading', async () => {
    renderSettings();
    expect(await screen.findByRole('heading', { name: /profile & settings/i })).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Editable fields — pre-populated
// ─────────────────────────────────────────────────────────────────────────────

describe('SettingsScreen — pre-populated fields', () => {
  it('pre-populates the display name from GET /v1/users/me', async () => {
    renderSettings();
    const input = await screen.findByLabelText(/display name/i);
    expect((input as HTMLInputElement).value).toBe('Alice');
  });

  it('pre-populates the timezone', async () => {
    renderSettings();
    const input = await screen.findByLabelText(/timezone/i);
    expect((input as HTMLInputElement).value).toBe('America/New_York');
  });

  it('pre-selects the communication style matching the user profile', async () => {
    renderSettings();
    await screen.findByLabelText(/display name/i);
    const warmCard = screen.getByRole('radio', { name: /warm/i });
    expect(warmCard).toHaveAttribute('aria-checked', 'true');
  });

  it('other comm styles are not selected by default', async () => {
    renderSettings();
    await screen.findByLabelText(/display name/i);
    expect(screen.getByRole('radio', { name: /direct/i })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: /reflective/i })).toHaveAttribute('aria-checked', 'false');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Save action
// ─────────────────────────────────────────────────────────────────────────────

describe('SettingsScreen — save', () => {
  it('Save button is disabled when no fields have changed', async () => {
    renderSettings();
    expect(await screen.findByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  it('Save button enables after a field is changed', async () => {
    const user = userEvent.setup();
    renderSettings();

    const nameInput = await screen.findByLabelText(/display name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Bob');

    expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled();
  });

  it('calls PATCH /v1/users/me with the modified fields', async () => {
    const user = userEvent.setup();
    renderSettings();

    const nameInput = await screen.findByLabelText(/display name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Bob');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(patchMe).toHaveBeenCalledWith(
        expect.objectContaining({ display_name: 'Bob' }),
      ),
    );
  });

  it('shows inline "Saved" confirmation after successful save', async () => {
    const user = userEvent.setup();
    renderSettings();

    const nameInput = await screen.findByLabelText(/display name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Bob');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('status', { name: '' })).toHaveTextContent(/saved/i);
  });

  it('"Saved" confirmation disappears after ~2 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ delay: null });
    renderSettings();

    const nameInput = await screen.findByLabelText(/display name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Bob');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // Flush microtasks so the mutation promise resolves
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText(/saved/i)).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(2100); });

    await waitFor(() =>
      expect(screen.queryByText(/^saved$/i)).not.toBeInTheDocument(),
    );
  });

  it('shows a field-level error when the API returns INVALID_COMM_STYLE', async () => {
    vi.mocked(patchMe).mockRejectedValue(new ApiError(400, 'INVALID_COMM_STYLE'));
    const user = userEvent.setup();
    renderSettings();

    // Change comm style to trigger dirty state
    await user.click(await screen.findByRole('radio', { name: /direct/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid communication style/i);
  });

  it('shows a general error for other API failures', async () => {
    vi.mocked(patchMe).mockRejectedValue(new ApiError(500, 'INTERNAL_SERVER_ERROR'));
    const user = userEvent.setup();
    renderSettings();

    await user.type(await screen.findByLabelText(/display name/i), '!');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/failed to save/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Communication style
// ─────────────────────────────────────────────────────────────────────────────

describe('SettingsScreen — communication style', () => {
  it('shows all three style options (Warm, Direct, Reflective)', async () => {
    renderSettings();
    expect(await screen.findByRole('radio', { name: /warm/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /direct/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /reflective/i })).toBeInTheDocument();
  });

  it('each option has a one-sentence description', async () => {
    renderSettings();
    await screen.findByRole('radio', { name: /warm/i });
    expect(screen.getByText(/friendly and empathetic/i)).toBeInTheDocument();
    expect(screen.getByText(/clear and concise/i)).toBeInTheDocument();
    expect(screen.getByText(/thoughtful and exploratory/i)).toBeInTheDocument();
  });

  it('shows the persistent info callout about comm style impact', async () => {
    renderSettings();
    expect(
      await screen.findByText(/this changes how your ai companion speaks/i),
    ).toBeInTheDocument();
  });

  it('selecting a different style marks it as checked', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('radio', { name: /reflective/i }));
    expect(screen.getByRole('radio', { name: /reflective/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /warm/i })).toHaveAttribute('aria-checked', 'false');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Streak stat card
// ─────────────────────────────────────────────────────────────────────────────

describe('SettingsScreen — streak card', () => {
  it('shows the streak number when current_streak > 0', async () => {
    renderSettings();
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('day streak')).toBeInTheDocument();
  });

  it('shows "Start your streak — chat today" when current_streak is 0', async () => {
    vi.mocked(getStreak).mockResolvedValue(STREAK_0);
    renderSettings();
    expect(await screen.findByText(/start your streak — chat today/i)).toBeInTheDocument();
  });

  it('the streak card links to /chat', async () => {
    renderSettings();
    await screen.findByText('3');
    const link = screen.getByRole('link', { name: /3 day streak/i }) as HTMLAnchorElement;
    expect(link.href).toMatch(/\/chat$/);
  });

  it('defaults to 0 streak when the endpoint is unavailable', async () => {
    vi.mocked(getStreak).mockResolvedValue({ current_streak: 0, longest_streak: 0, last_active_date: null });
    renderSettings();
    expect(await screen.findByText(/start your streak/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sign out
// ─────────────────────────────────────────────────────────────────────────────

describe('SettingsScreen — sign out', () => {
  it('renders a Sign out button', async () => {
    renderSettings();
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('calls POST /v1/auth/logout when Sign out is clicked', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });

  it('clears the Zustand auth store on sign out', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(clearAuth).toHaveBeenCalledTimes(1));
  });

  it('navigates to /login after sign out', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /sign out/i }));

    expect(await screen.findByTestId('login')).toBeInTheDocument();
  });

  it('signs out even if the logout API call fails', async () => {
    vi.mocked(logout).mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /sign out/i }));

    // Should still clear auth and redirect
    await waitFor(() => expect(clearAuth).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('login')).toBeInTheDocument();
  });

  it('does NOT show account deletion UI', async () => {
    renderSettings();
    await screen.findByRole('button', { name: /sign out/i });
    expect(screen.queryByText(/delete account/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/deactivate/i)).not.toBeInTheDocument();
  });
});
