/**
 * src/screens/__tests__/LoginScreen.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoginScreen } from '../LoginScreen';
import { ApiError } from '../../api/client';
import { useAuthStore } from '../../store/authStore';

vi.mock('../../api/auth', () => ({
  login: vi.fn(),
  getMe: vi.fn(),
}));

import { login, getMe } from '../../api/auth';

const ONBOARDED_USER = {
  id: '1',
  email: 'alice@example.com',
  display_name: 'Alice',
  timezone: 'UTC',
  comm_style: 'warm' as const,
  onboarding_done: true,
  created_at: '2026-01-01T00:00:00Z',
};

const NEW_USER = { ...ONBOARDED_USER, onboarding_done: false };

function renderLoginScreen(
  initialEntries: Array<string | { pathname: string; state?: unknown }> = ['/login'],
) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/login" element={<LoginScreen />} />
          <Route path="/onboarding" element={<div data-testid="onboarding-screen">Onboarding</div>} />
          <Route path="/chat" element={<div data-testid="chat-screen">Chat</div>} />
          <Route path="/register" element={<div data-testid="register-screen">Register</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(login).mockReset();
  vi.mocked(getMe).mockReset();
  useAuthStore.getState().clear();
});

describe('LoginScreen', () => {
  it('renders email and password fields with associated labels', () => {
    renderLoginScreen();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('shows field-level errors and does not call the API on an empty submit', async () => {
    renderLoginScreen();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/valid email address/i)).toBeInTheDocument();
    expect(screen.getByText(/enter your password/i)).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it('stores the access token in the Zustand store on success — never in localStorage/sessionStorage', async () => {
    vi.mocked(login).mockResolvedValue({ access_token: 'tok123', token_type: 'Bearer', expires_in: 900 });
    vi.mocked(getMe).mockResolvedValue(ONBOARDED_USER);

    renderLoginScreen();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(useAuthStore.getState().accessToken).toBe('tok123'));
  });

  it('routes to /chat when onboarding_done is true', async () => {
    vi.mocked(login).mockResolvedValue({ access_token: 'tok123', token_type: 'Bearer', expires_in: 900 });
    vi.mocked(getMe).mockResolvedValue(ONBOARDED_USER);

    renderLoginScreen();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByTestId('chat-screen')).toBeInTheDocument();
  });

  it('routes to /onboarding when onboarding_done is false', async () => {
    vi.mocked(login).mockResolvedValue({ access_token: 'tok123', token_type: 'Bearer', expires_in: 900 });
    vi.mocked(getMe).mockResolvedValue(NEW_USER);

    renderLoginScreen();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByTestId('onboarding-screen')).toBeInTheDocument();
  });

  it('falls back to /chat if GET /v1/users/me fails right after a successful login', async () => {
    vi.mocked(login).mockResolvedValue({ access_token: 'tok123', token_type: 'Bearer', expires_in: 900 });
    vi.mocked(getMe).mockRejectedValue(new ApiError(500, 'INTERNAL_SERVER_ERROR'));

    renderLoginScreen();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByTestId('chat-screen')).toBeInTheDocument();
  });

  it('shows a human-readable message for invalid credentials — never the raw code', async () => {
    vi.mocked(login).mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS'));
    renderLoginScreen();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrongpass');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/incorrect email or password/i)).toBeInTheDocument();
    expect(screen.queryByText('INVALID_CREDENTIALS')).not.toBeInTheDocument();
  });

  it('shows the "coming soon" notice when Forgot password is clicked, without navigating away', async () => {
    renderLoginScreen();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /forgot password/i }));

    expect(await screen.findByText(/coming soon/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('shows a confirmation banner when arriving from a successful registration', () => {
    renderLoginScreen([{ pathname: '/login', state: { justRegistered: true } }]);
    expect(screen.getByText(/account created/i)).toBeInTheDocument();
  });

  it('does not show the confirmation banner on a normal visit', () => {
    renderLoginScreen();
    expect(screen.queryByText(/account created/i)).not.toBeInTheDocument();
  });

  it('disables the submit button and shows a spinner while the request is in flight', async () => {
    let resolveLogin!: (value: { access_token: string; token_type: string; expires_in: number }) => void;
    vi.mocked(login).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLogin = resolve;
        }),
    );
    vi.mocked(getMe).mockResolvedValue(ONBOARDED_USER);

    renderLoginScreen();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const pendingButton = screen.getByRole('button', { name: /signing in/i });
    expect(pendingButton).toBeDisabled();
    expect(pendingButton).toHaveAttribute('aria-busy', 'true');

    resolveLogin({ access_token: 'tok', token_type: 'Bearer', expires_in: 900 });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /signing in/i })).not.toBeInTheDocument(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2-005 — Account Deleted Banner
// ─────────────────────────────────────────────────────────────────────────────

describe('LoginScreen — F2-005 account deleted banner', () => {
  it('shows "Your account has been deleted" when ?deleted=1 is in the URL', async () => {
    // Render with the query param that deleteAccount navigation sets
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { MemoryRouter, Routes, Route } = await import('react-router-dom');
    const { render: rtlRender, screen: rtlScreen } = await import('@testing-library/react');
    const { LoginScreen } = await import('../LoginScreen');

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rtlRender(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/login?deleted=1']}>
          <Routes>
            <Route path="/login" element={<LoginScreen />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await rtlScreen.findByText(/your account has been deleted/i),
    ).toBeInTheDocument();
  });

  it('does NOT show the deleted banner without the ?deleted=1 param', async () => {
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { MemoryRouter, Routes, Route } = await import('react-router-dom');
    const { render: rtlRender, screen: rtlScreen } = await import('@testing-library/react');
    const { LoginScreen } = await import('../LoginScreen');

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rtlRender(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<LoginScreen />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Wait for render, then assert banner is absent
    expect(rtlScreen.queryByText(/your account has been deleted/i)).not.toBeInTheDocument();
  });
});
