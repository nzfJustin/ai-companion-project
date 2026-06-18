/**
 * src/screens/__tests__/RegisterScreen.test.tsx
 *
 * register() is mocked at the module level — these tests never touch
 * apiFetch/fetch, so no VITE_API_BASE_URL or network mocking is needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RegisterScreen } from '../RegisterScreen';
import { ApiError } from '../../api/client';

vi.mock('../../api/auth', () => ({
  register: vi.fn(),
}));

import { register } from '../../api/auth';

function renderRegisterScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/register']}>
        <Routes>
          <Route path="/register" element={<RegisterScreen />} />
          <Route path="/login" element={<div data-testid="login-screen">Login screen</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(register).mockReset();
});

describe('RegisterScreen', () => {
  it('renders name, email, and password fields with associated labels', () => {
    renderRegisterScreen();
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('shows field-level errors and does not call the API on an empty submit', async () => {
    renderRegisterScreen();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/enter your name/i)).toBeInTheDocument();
    expect(screen.getByText(/valid email address/i)).toBeInTheDocument();
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it('shows an inline error for an invalid email format', async () => {
    renderRegisterScreen();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/name/i), 'Alice');
    await user.type(screen.getByLabelText(/email/i), 'not-an-email');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/valid email address/i)).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it('shows an inline error for a password under 8 characters', async () => {
    renderRegisterScreen();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/name/i), 'Alice');
    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'short');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it('clears a field error as soon as that field is edited', async () => {
    renderRegisterScreen();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText(/enter your name/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/name/i), 'A');
    expect(screen.queryByText(/enter your name/i)).not.toBeInTheDocument();
  });

  it('calls register() with trimmed values on a valid submit', async () => {
    vi.mocked(register).mockResolvedValue({ id: '1', display_name: 'Alice' });
    renderRegisterScreen();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/name/i), '  Alice  ');
    await user.type(screen.getByLabelText(/email/i), '  alice@example.com  ');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() =>
      expect(register).toHaveBeenCalledWith(
        { display_name: 'Alice', email: 'alice@example.com', password: 'password123' },
        expect.anything(),
      ),
    );
  });

  it('navigates to /login on successful registration', async () => {
    vi.mocked(register).mockResolvedValue({ id: '1', display_name: 'Alice' });
    renderRegisterScreen();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/name/i), 'Alice');
    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByTestId('login-screen')).toBeInTheDocument();
  });

  it('shows a human-readable message for EMAIL_ALREADY_EXISTS — never the raw code', async () => {
    vi.mocked(register).mockRejectedValue(new ApiError(409, 'EMAIL_ALREADY_EXISTS'));
    renderRegisterScreen();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/name/i), 'Alice');
    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(screen.queryByText('EMAIL_ALREADY_EXISTS')).not.toBeInTheDocument();
  });

  it('shows a generic message for a 500 error', async () => {
    vi.mocked(register).mockRejectedValue(new ApiError(500, 'INTERNAL_SERVER_ERROR'));
    renderRegisterScreen();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/name/i), 'Alice');
    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  });

  it('disables the submit button and shows a spinner while the request is in flight', async () => {
    let resolveRegister!: (value: { id: string; display_name: string }) => void;
    vi.mocked(register).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRegister = resolve;
        }),
    );
    renderRegisterScreen();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/name/i), 'Alice');
    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    const pendingButton = screen.getByRole('button', { name: /creating account/i });
    expect(pendingButton).toBeDisabled();
    expect(pendingButton).toHaveAttribute('aria-busy', 'true');

    resolveRegister({ id: '1', display_name: 'Alice' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /creating account/i })).not.toBeInTheDocument(),
    );
  });
});
