/**
 * src/components/ProtectedRoute.tsx
 *
 * Wraps all authenticated routes. Handles the page-refresh case where
 * the access token is gone from Zustand's in-memory store: on mount it
 * attempts a silent token refresh before deciding whether to render the
 * child or redirect to /login.
 *
 * Flow:
 *   1. Token in store → authorized immediately, no network call.
 *   2. No token → show full-page spinner, call /v1/auth/refresh.
 *       a. Refresh succeeds → store gets the new token → render child.
 *       b. Refresh fails (expired/revoked) → redirect to /login,
 *          preserving the intended path in router state so the user
 *          is returned here after a successful login (F1-003 spec).
 */

import { useState, useEffect } from 'react';
import { Outlet, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { refreshSession } from '../api/auth';

type AuthStatus = 'checking' | 'authorized' | 'unauthorized';

// ─── Full-page loading state ──────────────────────────────────────────────────
// Shown during the silent refresh so users never see a flash of the
// login screen while the refresh cookie is being verified.

function FullPageSpinner() {
  return (
    <div
      role="status"
      aria-label="Verifying your session…"
      className="flex min-h-screen items-center justify-center bg-gray-50"
    >
      <div className="flex flex-col items-center gap-3">
        <span
          className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-blue-500"
          aria-hidden="true"
        />
        <p className="text-sm text-gray-400">Just a moment…</p>
      </div>
    </div>
  );
}

// ─── ProtectedRoute ───────────────────────────────────────────────────────────

export function ProtectedRoute() {
  const location = useLocation();

  // Read token at mount time without subscribing to future changes.
  // getState() is a synchronous non-hook call — valid inside useState's
  // lazy initializer, which runs synchronously before the first render.
  const [status, setStatus] = useState<AuthStatus>(() =>
    useAuthStore.getState().accessToken ? 'authorized' : 'checking',
  );

  useEffect(() => {
    if (status !== 'checking') return;

    refreshSession()
      .then(() => setStatus('authorized'))
      .catch(() => setStatus('unauthorized'));
    // Empty deps is intentional — we only want this to run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === 'checking') {
    return <FullPageSpinner />;
  }

  if (status === 'unauthorized') {
    // Save the intended path so LoginScreen can redirect back here after
    // a successful login.
    return (
      <Navigate
        to="/login"
        state={{ from: location.pathname }}
        replace
      />
    );
  }

  return <Outlet />;
}
