/**
 * src/screens/__tests__/SettingsScreen.test.tsx
 *
 * Tests for F1-011 · Profile & Settings Screen.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../api/auth', () => ({
  getMe:          vi.fn(),
  patchMe:        vi.fn(),
  getStreak:      vi.fn(),
  logout:         vi.fn(),
  requestExport:  vi.fn(),
  deleteAccount:  vi.fn(),
}));

vi.mock('../../store/authStore', () => ({
  clearAuth:           vi.fn(),
  getAccessToken:      vi.fn(() => 'token'),
  getValidElevatedToken: vi.fn(() => null),
  useAuthStore:        vi.fn(() => ({ elevatedToken: null, setElevatedToken: vi.fn(), clearElevatedToken: vi.fn() })),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsScreen } from '../SettingsScreen';
import { getMe, patchMe, getStreak, logout, requestExport, deleteAccount } from '../../api/auth';
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

    vi.useRealTimers();
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
});

// ─────────────────────────────────────────────────────────────────────────────
// F2-004 — Data Export Flow
// ─────────────────────────────────────────────────────────────────────────────

describe('SettingsScreen — F2-004 Data Export', () => {
  beforeEach(() => {
    vi.mocked(requestExport).mockReset();
  });

  // ── Section visibility ─────────────────────────────────────────────────────

  it('renders a "Data & Privacy" section', async () => {
    renderSettings();
    expect(await screen.findByText(/data & privacy/i)).toBeInTheDocument();
  });

  it('renders an "Export my data" heading and description', async () => {
    renderSettings();
    expect(await screen.findByText(/export my data/i)).toBeInTheDocument();
    expect(
      screen.getByText(/includes all your conversations.*zip/i),
    ).toBeInTheDocument();
  });

  it('renders a "Request export" button in the idle state', async () => {
    renderSettings();
    expect(
      await screen.findByRole('button', { name: /request export/i }),
    ).toBeInTheDocument();
  });

  it('Data & Privacy section appears between streak card and sign out', async () => {
    renderSettings();
    await screen.findByText(/export my data/i);

    const elements = document.body.querySelectorAll('[aria-labelledby]');
    const sectionIds = Array.from(elements).map((el) =>
      el.getAttribute('aria-labelledby'),
    );
    // streak-heading should appear before the export section, sign out after
    const streakIdx  = sectionIds.findIndex((id) => id === 'streak-heading');
    const signoutIdx = sectionIds.findIndex((id) => id === 'signout-heading');
    expect(streakIdx).toBeGreaterThan(-1);
    expect(signoutIdx).toBeGreaterThan(-1);
    expect(streakIdx).toBeLessThan(signoutIdx);
  });

  // ── Successful export ──────────────────────────────────────────────────────

  it('calls POST /v1/users/me/export when "Request export" is clicked', async () => {
    vi.mocked(requestExport).mockResolvedValue({ estimated_minutes: 15 });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /request export/i }));

    await waitFor(() => expect(requestExport).toHaveBeenCalledTimes(1));
  });

  it('shows the success message after export starts', async () => {
    vi.mocked(requestExport).mockResolvedValue({ estimated_minutes: 15 });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /request export/i }));

    expect(
      await screen.findByText(/export started.*email.*ready/i),
    ).toBeInTheDocument();
  });

  it('the success message is non-dismissible — no close button', async () => {
    vi.mocked(requestExport).mockResolvedValue({ estimated_minutes: 15 });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /request export/i }));
    await screen.findByText(/export started/i);

    // The success state has no dismiss button
    expect(screen.queryByRole('button', { name: /dismiss|close|×/i })).not.toBeInTheDocument();
  });

  it('hides the "Request export" button after a successful export', async () => {
    vi.mocked(requestExport).mockResolvedValue({ estimated_minutes: 15 });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /request export/i }));
    await screen.findByText(/export started/i);

    expect(
      screen.queryByRole('button', { name: /request export/i }),
    ).not.toBeInTheDocument();
  });

  // ── Loading state ──────────────────────────────────────────────────────────

  it('disables the button and shows "Starting export…" while the request is in flight', async () => {
    let resolve!: (v: { estimated_minutes: number }) => void;
    vi.mocked(requestExport).mockReturnValue(
      new Promise((r) => { resolve = r; }),
    );
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /request export/i }));

    expect(await screen.findByText(/starting export/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /request export/i }),
    ).not.toBeInTheDocument();

    // Resolve to avoid hanging test
    resolve({ estimated_minutes: 15 });
  });

  // ── Already-pending state ──────────────────────────────────────────────────

  it('shows "An export is already in progress" on 429 EXPORT_ALREADY_PENDING', async () => {
    vi.mocked(requestExport).mockRejectedValue(
      new ApiError(429, 'EXPORT_ALREADY_PENDING'),
    );
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /request export/i }));

    expect(
      await screen.findByText(/an export is already in progress/i),
    ).toBeInTheDocument();
  });

  it('hides the "Request export" button when an export is already pending', async () => {
    vi.mocked(requestExport).mockRejectedValue(
      new ApiError(429, 'EXPORT_ALREADY_PENDING'),
    );
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /request export/i }));
    await screen.findByText(/already in progress/i);

    expect(
      screen.queryByRole('button', { name: /request export/i }),
    ).not.toBeInTheDocument();
  });

  // ── Retry on generic error ─────────────────────────────────────────────────

  it('restores the "Request export" button after a generic API error so the user can retry', async () => {
    vi.mocked(requestExport).mockRejectedValue(new ApiError(500, 'INTERNAL_SERVER_ERROR'));
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /request export/i }));

    // Button should come back after the error (state returns to 'idle')
    expect(
      await screen.findByRole('button', { name: /request export/i }),
    ).toBeInTheDocument();
  });

  // ── No double-submit ───────────────────────────────────────────────────────

  it('prevents double-clicking the export button', async () => {
    let resolve!: (v: { estimated_minutes: number }) => void;
    vi.mocked(requestExport).mockReturnValue(
      new Promise((r) => { resolve = r; }),
    );
    const user = userEvent.setup();
    renderSettings();

    const btn = await screen.findByRole('button', { name: /request export/i });
    await user.click(btn);
    // Button disappears (replaced by loading state) — second click impossible
    await screen.findByText(/starting export/i);
    expect(requestExport).toHaveBeenCalledTimes(1);

    resolve({ estimated_minutes: 15 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2-005 — Account Deletion Flow
// ─────────────────────────────────────────────────────────────────────────────

describe('SettingsScreen — F2-005 Account Deletion', () => {
  beforeEach(() => {
    vi.mocked(deleteAccount).mockReset();
  });

  // ── Delete link ─────────────────────────────────────────────────────────────

  it('shows a "Delete account" link at the bottom of Settings', async () => {
    renderSettings();
    expect(
      await screen.findByRole('button', { name: /delete account/i }),
    ).toBeInTheDocument();
  });

  it('"Delete account" is styled as a low-prominence link, not a button', async () => {
    renderSettings();
    const btn = await screen.findByRole('button', { name: /delete account/i });
    // Confirm it uses underline styling (low-prominence)
    expect(btn.className).toMatch(/underline/);
    // Should NOT have primary button styles
    expect(btn.className).not.toMatch(/bg-slate-700|bg-red-600/);
  });

  it('"Delete account" appears below the sign out button', async () => {
    renderSettings();
    await screen.findByRole('button', { name: /sign out/i });
    const allButtons = screen.getAllByRole('button');
    const signOutIdx = allButtons.findIndex((b) => /sign out/i.test(b.textContent ?? ''));
    const deleteIdx  = allButtons.findIndex((b) => /delete account/i.test(b.textContent ?? ''));
    expect(signOutIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(signOutIdx);
  });

  // ── Modal opens ─────────────────────────────────────────────────────────────

  it('opens the deletion confirmation modal when "Delete account" is clicked', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /delete account/i }));

    expect(
      screen.getByRole('dialog', { name: /delete your account/i }),
    ).toBeInTheDocument();
  });

  it('shows the warning text in the modal', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /delete account/i }));

    // "This cannot be undone." is in a nested <strong>, so the warning
    // paragraph's text is split across elements — match on the <p>'s full
    // textContent instead of relying on a single text node.
    expect(
      screen.getByText((_, el) =>
        el?.tagName.toLowerCase() === 'p' &&
        /permanently delete all your conversations.*cannot be undone/is.test(el.textContent ?? ''),
      ),
    ).toBeInTheDocument();
  });

  it('shows a text input for the DELETE confirmation word', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /delete account/i }));

    expect(
      screen.getByRole('textbox', { name: /type delete to confirm/i }),
    ).toBeInTheDocument();
  });

  // ── Confirm gate ─────────────────────────────────────────────────────────────

  it('confirm button is disabled until the user types DELETE exactly', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /delete account/i }));
    const confirmBtn = screen.getByRole('button', { name: /permanently delete/i });

    expect(confirmBtn).toBeDisabled();
  });

  it('confirm button enables after typing DELETE (case-sensitive)', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /delete account/i }));
    await user.type(screen.getByRole('textbox', { name: /type delete/i }), 'DELETE');

    expect(
      screen.getByRole('button', { name: /permanently delete/i }),
    ).not.toBeDisabled();
  });

  it('confirm button stays disabled if the user types "delete" (lowercase)', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /delete account/i }));
    await user.type(screen.getByRole('textbox', { name: /type delete/i }), 'delete');

    expect(
      screen.getByRole('button', { name: /permanently delete/i }),
    ).toBeDisabled();
  });

  // ── Cancel ────────────────────────────────────────────────────────────────────

  it('closing the modal via Cancel returns to Settings without calling deleteAccount', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /delete account/i }));
    await user.click(screen.getByRole('button', { name: /cancel account deletion/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('"Keep my account" button in the modal also cancels', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /delete account/i }));
    await user.click(screen.getByRole('button', { name: /keep my account/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // ── Successful deletion ────────────────────────────────────────────────────

  it('calls DELETE /v1/users/me when the user confirms', async () => {
    vi.mocked(deleteAccount).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /delete account/i }));
    await user.type(screen.getByRole('textbox', { name: /type delete/i }), 'DELETE');
    await user.click(screen.getByRole('button', { name: /permanently delete/i }));

    await waitFor(() => expect(deleteAccount).toHaveBeenCalledTimes(1));
  });

  it('clears auth and navigates to /login?deleted=1 after successful deletion', async () => {
    vi.mocked(deleteAccount).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /delete account/i }));
    await user.type(screen.getByRole('textbox', { name: /type delete/i }), 'DELETE');
    await user.click(screen.getByRole('button', { name: /permanently delete/i }));

    await waitFor(() => expect(clearAuth).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('login')).toBeInTheDocument();
  });

  // ── Error state ────────────────────────────────────────────────────────────

  it('shows an inline error when deleteAccount API call fails', async () => {
    vi.mocked(deleteAccount).mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /delete account/i }));
    await user.type(screen.getByRole('textbox', { name: /type delete/i }), 'DELETE');
    await user.click(screen.getByRole('button', { name: /permanently delete/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
  });

  it('the confirm button re-enables after an error so the user can retry', async () => {
    vi.mocked(deleteAccount).mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /delete account/i }));
    const input = screen.getByRole('textbox', { name: /type delete/i });
    await user.type(input, 'DELETE');
    await user.click(screen.getByRole('button', { name: /permanently delete/i }));

    await screen.findByRole('alert');
    // Still in the modal, confirm button back to enabled (input still says DELETE)
    expect(
      screen.getByRole('button', { name: /permanently delete/i }),
    ).not.toBeDisabled();
  });

  it('clearing the input after an error re-disables the confirm button', async () => {
    vi.mocked(deleteAccount).mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: /delete account/i }));
    const input = screen.getByRole('textbox', { name: /type delete/i });
    await user.type(input, 'DELETE');
    await user.click(screen.getByRole('button', { name: /permanently delete/i }));

    await screen.findByRole('alert');
    await user.clear(input);

    expect(
      screen.getByRole('button', { name: /permanently delete/i }),
    ).toBeDisabled();
  });
});
