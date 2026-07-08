/**
 * src/screens/OnboardingScreen.tsx
 *
 * F1-004 acceptance criteria covered here:
 *
 *   ✓ Guard: reads onboarding_done from GET /v1/users/me.  If true (user
 *     somehow navigated directly to /onboarding after finishing), they are
 *     immediately redirected to /chat — staleTime: 0 ensures we always get
 *     a fresh value, not a cached one from the login flow.
 *
 *   ✓ Display: app name, welcoming headline, 3 value-prop lines, one CTA.
 *     No form fields, no multi-step wizard, no comm_style picker — the AI
 *     handles all of that through conversation.
 *
 *   ✓ CTA: calls POST /v1/conversations, navigates to /chat/:conversationId.
 *     Button is disabled + shows a spinner during the API call (prevents
 *     double-tap).
 *
 *   ✓ Post-onboarding: once the backend sets onboarding_done = true, the
 *     next fresh call to GET /v1/users/me returns the updated value.  React
 *     Query's cache is updated, subsequent renders see onboarding_done = true,
 *     and the guard redirects to /chat.  Subsequent app opens land on /chat
 *     via the router's root redirect (/) and the LoginScreen's post-login
 *     routing — /onboarding is never shown to a completed user.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getMe } from '../api/auth';
import { createConversation } from '../api/conversations';
import { getErrorMessage } from '../api/errorMessages';

// ─── Value propositions ───────────────────────────────────────────────────────

const VALUE_PROPS = [
  'Process what you\'re feeling — any time, without judgement.',
  'Build understanding of yourself that deepens over time.',
  'Remember what matters, so you can return to it.',
] as const;

// ─── Loading state ─────────────────────────────────────────────────────────────

function FullPageSpinner() {
  return (
    <div
      className="flex min-h-screen items-center justify-center"
      style={{ background: '#F4F6F2' }}
      role="status"
      aria-label="Loading…"
    >
      <span
        className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
        aria-hidden="true"
      />
    </div>
  );
}

// ─── OnboardingScreen ─────────────────────────────────────────────────────────

export function OnboardingScreen() {
  const navigate = useNavigate();

  // Always fetch fresh — we need to know the authoritative onboarding_done value,
  // not a value cached from login flow (which might have changed since).
  const { data: user, isLoading: userLoading } = useQuery({
    queryKey:  ['me'],
    queryFn:   getMe,
    staleTime: 0,
    retry:     false, // ProtectedRoute handles session failures upstream
  });

  // Redirect guard — fires as soon as we have a confirmed onboarding_done = true.
  useEffect(() => {
    if (user?.onboarding_done) {
      navigate('/chat', { replace: true });
    }
  }, [user, navigate]);

  const mutation = useMutation({
    mutationFn: createConversation,
    onSuccess: (data) => {
      navigate(`/chat/${data.id}`, { replace: true });
    },
  });

  // Show spinner while we verify onboarding status — avoids a flash of the
  // welcome screen for users who are already past onboarding.
  if (userLoading) return <FullPageSpinner />;

  const errorMessage = mutation.error ? getErrorMessage(mutation.error) : null;

  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center px-6 py-16"
      style={{ background: '#F4F6F2' }}
    >
      <div className="w-full max-w-sm">

        {/* App name */}
        <p
          className="mb-10 text-xs font-semibold uppercase tracking-[0.2em]"
          style={{ color: '#6B8F71' }}
        >
          AI Companion
        </p>

        {/* Headline — serif to slow the reader down, feel personal */}
        <h1
          className="mb-2 font-serif text-4xl font-normal leading-snug"
          style={{ color: '#1D2620' }}
        >
          A space that's
          <br />
          just for you.
        </h1>

        {/* Thin rule — structural, not decorative */}
        <div
          className="mb-8 mt-8 h-px w-12"
          style={{ background: '#3D6646' }}
          aria-hidden="true"
        />

        {/* Value propositions */}
        <ul className="mb-12 space-y-4" aria-label="What you can do here">
          {VALUE_PROPS.map((prop) => (
            <li key={prop} className="flex items-start gap-3">
              {/* Dot marker */}
              <span
                className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: '#6B8F71' }}
                aria-hidden="true"
              />
              <span className="text-base leading-relaxed" style={{ color: '#374840' }}>
                {prop}
              </span>
            </li>
          ))}
        </ul>

        {/* Error message */}
        {errorMessage && (
          <p
            role="alert"
            className="mb-4 text-sm"
            style={{ color: '#9B3333' }}
          >
            {errorMessage}
          </p>
        )}

        {/* CTA */}
        <button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          aria-busy={mutation.isPending || undefined}
          className="flex w-full items-center justify-center gap-2 rounded-lg px-6 py-3.5 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
          style={{ background: '#3D6646' }}
        >
          {mutation.isPending && (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
              aria-hidden="true"
            />
          )}
          {mutation.isPending ? 'Starting your conversation…' : 'Start your first conversation'}
        </button>

        {/* Privacy reassurance — small, out of the way */}
        <p
          className="mt-6 text-center text-xs leading-relaxed"
          style={{ color: '#7A8F7D' }}
        >
          Everything you share stays private.
          <br />
          Only you can see your conversations.
        </p>
      </div>
    </div>
  );
}
