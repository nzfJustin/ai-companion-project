/**
 * src/screens/LoginScreen.tsx
 *
 * F1-002 acceptance criteria covered here:
 *   - Collects { email, password }
 *   - On success, stores the access token in the Zustand auth store
 *     (in memory only — never localStorage/sessionStorage). The refresh
 *     token is an httpOnly cookie the frontend never touches directly.
 *   - Reads onboarding_done from GET /v1/users/me and routes to
 *     /onboarding (false) or /chat (true)
 *   - "Forgot password?" leads to a "Coming soon" state — no route exists
 *     for it in Phase 1
 */

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { AuthLayout } from '../components/AuthLayout';
import { TextField } from '../components/TextField';
import { Button } from '../components/Button';
import { login, getMe } from '../api/auth';
import { getErrorMessage } from '../api/errorMessages';
import { isValidEmail, isNonEmpty } from '../utils/validation';
import { useAuthStore } from '../store/authStore';

interface FieldErrors {
  email?: string;
  password?: string;
}

interface LocationState {
  justRegistered?: boolean;
}

export function LoginScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = (location.state as LocationState | null) ?? null;

  const setAccessToken = useAuthStore((s) => s.setAccessToken);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [showForgotPasswordNotice, setShowForgotPasswordNotice] = useState(false);

  const mutation = useMutation({
    mutationFn: login,
    onSuccess: async (data) => {
      setAccessToken(data.access_token);
      try {
        const me = await getMe();
        navigate(me.onboarding_done ? '/chat' : '/onboarding', { replace: true });
      } catch {
        // /v1/users/me failing right after a successful login is
        // unexpected, but shouldn't strand the user on the login screen.
        // F1-003's <ProtectedRoute> will re-validate the session anyway.
        navigate('/chat', { replace: true });
      }
    },
    onError: (error) => {
      setApiError(getErrorMessage(error));
    },
  });

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!isValidEmail(email)) errors.email = 'Enter a valid email address.';
    if (!isNonEmpty(password)) errors.password = 'Enter your password.';
    return errors;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setApiError(null);

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    mutation.mutate({ email: email.trim(), password });
  }

  return (
    <AuthLayout title="Welcome back">
      {locationState?.justRegistered && (
        <p className="mb-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          Account created — sign in to continue.
        </p>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <TextField
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setFieldErrors((prev) => ({ ...prev, email: undefined }));
          }}
          error={fieldErrors.email}
        />
        <TextField
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setFieldErrors((prev) => ({ ...prev, password: undefined }));
          }}
          error={fieldErrors.password}
        />

        {apiError && (
          <p role="alert" className="text-sm text-red-600">
            {apiError}
          </p>
        )}

        <Button type="submit" loading={mutation.isPending}>
          {mutation.isPending ? 'Signing in…' : 'Sign in'}
        </Button>

        <div className="text-center text-sm">
          <button
            type="button"
            onClick={() => setShowForgotPasswordNotice(true)}
            className="font-medium text-blue-600 hover:underline"
          >
            Forgot password?
          </button>
          {showForgotPasswordNotice && (
            <p className="mt-1 text-gray-500">Coming soon — password reset isn&apos;t available yet.</p>
          )}
        </div>

        <p className="text-center text-sm text-gray-500">
          Don&apos;t have an account?{' '}
          <Link to="/register" className="font-medium text-blue-600 hover:underline">
            Create one
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
