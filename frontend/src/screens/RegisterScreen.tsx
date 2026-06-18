/**
 * src/screens/RegisterScreen.tsx
 *
 * F1-002 acceptance criteria covered here:
 *   - Collects { display_name, email, password }
 *   - Client-side validation on submit: RFC-ish email format, password >= 8 chars
 *   - Field-level error messages inline below each input, never a banner
 *   - Submit disabled + spinner while the request is in flight
 *
 * The backend's POST /v1/auth/register does not issue tokens (the user
 * still has to log in afterward), so on success we navigate to /login
 * with a flag in router state that shows a confirmation message there.
 */

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { AuthLayout } from '../components/AuthLayout';
import { TextField } from '../components/TextField';
import { Button } from '../components/Button';
import { register } from '../api/auth';
import { getErrorMessage } from '../api/errorMessages';
import { isValidEmail, isValidPassword, isNonEmpty, MIN_PASSWORD_LENGTH } from '../utils/validation';

interface FieldErrors {
  display_name?: string;
  email?: string;
  password?: string;
}

export function RegisterScreen() {
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [apiError, setApiError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: register,
    onSuccess: () => {
      navigate('/login', { state: { justRegistered: true }, replace: true });
    },
    onError: (error) => {
      setApiError(getErrorMessage(error));
    },
  });

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!isNonEmpty(displayName)) {
      errors.display_name = 'Please enter your name.';
    }
    if (!isValidEmail(email)) {
      errors.email = 'Enter a valid email address.';
    }
    if (!isValidPassword(password)) {
      errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    return errors;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setApiError(null);

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    mutation.mutate({
      display_name: displayName.trim(),
      email: email.trim(),
      password,
    });
  }

  return (
    <AuthLayout title="Create your account">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <TextField
          label="Name"
          name="display_name"
          autoComplete="name"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setFieldErrors((prev) => ({ ...prev, display_name: undefined }));
          }}
          error={fieldErrors.display_name}
        />
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
          autoComplete="new-password"
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
          {mutation.isPending ? 'Creating account…' : 'Create account'}
        </Button>

        <p className="text-center text-sm text-gray-500">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-blue-600 hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
