/**
 * src/components/__tests__/AppShell.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '../AppShell';
import { useAuthStore } from '../../store/authStore';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../api/auth', () => ({
  logout: vi.fn(),
  refreshSession: vi.fn(),
}));

import { logout } from '../../api/auth';

// ── Helpers ────────────────────────────────────────────────────────────────────

function renderAppShell(initialPath = '/chat') {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/chat"      element={<div>Chat content</div>} />
            <Route path="/memories"  element={<div>Memories content</div>} />
            <Route path="/insights"  element={<div>Insights content</div>} />
            <Route path="/settings"  element={<div>Settings content</div>} />
          </Route>
          <Route path="/login" element={<div data-testid="login-screen">Login</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.getState().setAccessToken('test-token');
  vi.mocked(logout).mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('AppShell — navigation', () => {
  it('renders all four nav items', () => {
    renderAppShell();
    // Both sidebar and bottom nav render the same labels — getAllByRole
    expect(screen.getAllByRole('link', { name: /chat/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: /memories/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: /insights/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: /settings/i }).length).toBeGreaterThan(0);
  });

  it('nav links point to the correct paths', () => {
    renderAppShell();
    const chatLinks = screen.getAllByRole('link', { name: /chat/i });
    expect(chatLinks[0]).toHaveAttribute('href', '/chat');

    const memoriesLinks = screen.getAllByRole('link', { name: /memories/i });
    expect(memoriesLinks[0]).toHaveAttribute('href', '/memories');

    const insightsLinks = screen.getAllByRole('link', { name: /insights/i });
    expect(insightsLinks[0]).toHaveAttribute('href', '/insights');

    const settingsLinks = screen.getAllByRole('link', { name: /settings/i });
    expect(settingsLinks[0]).toHaveAttribute('href', '/settings');
  });

  it('renders the Outlet (child route content)', () => {
    renderAppShell('/chat');
    expect(screen.getByText('Chat content')).toBeInTheDocument();
  });

  it('shows the app name in the sidebar', () => {
    renderAppShell();
    expect(screen.getByText(/ai companion/i)).toBeInTheDocument();
  });
});

describe('AppShell — logout', () => {
  it('renders a Sign out button', () => {
    renderAppShell();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('calls the logout API when Sign out is clicked', async () => {
    vi.mocked(logout).mockResolvedValue(undefined);
    renderAppShell();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });

  it('clears the auth store after logout', async () => {
    vi.mocked(logout).mockResolvedValue(undefined);
    renderAppShell();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() =>
      expect(useAuthStore.getState().accessToken).toBeNull(),
    );
  });

  it('navigates to /login after logout', async () => {
    vi.mocked(logout).mockResolvedValue(undefined);
    renderAppShell();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    expect(await screen.findByTestId('login-screen')).toBeInTheDocument();
  });

  it('still clears auth and navigates to /login even if the logout API call fails', async () => {
    vi.mocked(logout).mockRejectedValue(new Error('Network error'));
    renderAppShell();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    // Despite the API failure, the user should land on /login with a clear store
    expect(await screen.findByTestId('login-screen')).toBeInTheDocument();
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});
