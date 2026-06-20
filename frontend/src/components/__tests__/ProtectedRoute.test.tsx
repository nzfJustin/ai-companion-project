/**
 * src/components/__tests__/ProtectedRoute.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProtectedRoute } from '../ProtectedRoute';
import { useAuthStore } from '../../store/authStore';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../api/auth', () => ({
  refreshSession: vi.fn(),
  logout: vi.fn(),
}));

import { refreshSession } from '../../api/auth';

// ── Helpers ────────────────────────────────────────────────────────────────────

function LocationDisplay() {
  const location = useLocation();
  return (
    <div>
      <div data-testid="pathname">{location.pathname}</div>
      <div data-testid="from-state">{(location.state as { from?: string } | null)?.from ?? ''}</div>
    </div>
  );
}

function renderProtectedRoute(
  initialPath: string,
  childContent = <div data-testid="protected-content">Protected content</div>,
) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="*" element={childContent} />
          </Route>
          <Route path="/login" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.getState().clear();
  vi.mocked(refreshSession).mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('ProtectedRoute', () => {
  it('renders children immediately when a token is already in the store', () => {
    useAuthStore.getState().setAccessToken('existing-token');

    renderProtectedRoute('/chat');

    // Children render synchronously — no loading state, no refresh call
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('shows a full-page loading state while refresh is in progress', () => {
    // refreshSession never resolves during this test
    vi.mocked(refreshSession).mockImplementation(
      () => new Promise(() => {}),
    );

    renderProtectedRoute('/chat');

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('renders children after a successful silent refresh', async () => {
    vi.mocked(refreshSession).mockResolvedValue(undefined);

    renderProtectedRoute('/chat');

    // Loading state shown first
    expect(screen.getByRole('status')).toBeInTheDocument();

    // Children appear once refresh resolves
    expect(await screen.findByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('redirects to /login when refresh fails', async () => {
    vi.mocked(refreshSession).mockRejectedValue(new Error('Refresh failed'));

    renderProtectedRoute('/chat');

    // After failure, should land on /login
    expect(await screen.findByTestId('pathname')).toHaveTextContent('/login');
  });

  it('preserves the intended path in router state so login can redirect back', async () => {
    vi.mocked(refreshSession).mockRejectedValue(new Error('Refresh failed'));

    renderProtectedRoute('/memories');

    // The { from } state should carry the path the user was trying to visit
    const fromState = await screen.findByTestId('from-state');
    expect(fromState).toHaveTextContent('/memories');
  });

  it('does not call refreshSession when a token is already present', () => {
    useAuthStore.getState().setAccessToken('valid-token');
    renderProtectedRoute('/settings');
    expect(refreshSession).not.toHaveBeenCalled();
  });
});
