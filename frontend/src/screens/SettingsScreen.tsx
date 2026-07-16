/**
 * src/screens/SettingsScreen.tsx
 *
 * F1-011 · Profile & Settings Screen
 * F2-004 · Data Export (enhancement — Data & Privacy section)
 *
 * Acceptance criteria (F1-011):
 *   ✓ Editable fields pre-populated from GET /v1/users/me:
 *       display name (text), timezone (searchable IANA datalist),
 *       communication style (three-card selector with descriptions)
 *   ✓ PATCH /v1/users/me on save; inline "Saved ✓" fades after 2 s;
 *     API errors map to field-level messages
 *   ✓ Persistent info callout on comm style
 *   ✓ Streak stat card (read-only), taps to /chat
 *   ✓ Sign out — POST /v1/auth/logout, clears Zustand, redirects /login
 *
 * Acceptance criteria (F2-004):
 *   ✓ "Data & Privacy" section between streak card and sign out
 *   ✓ "Request export" → POST /v1/users/me/export (202 Accepted)
 *   ✓ Success: non-dismissible "Export started" message for the session
 *   ✓ 429 EXPORT_ALREADY_PENDING → "An export is already in progress"
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMe, patchMe, getStreak, logout, requestExport, deleteAccount } from '../api/auth';
import { ApiError } from '../api/client';
import { clearAuth } from '../store/authStore';

// ─── IANA timezone list ────────────────────────────────────────────────────────
// Use Intl.supportedValuesOf if available (Chrome 99+, FF 93+, Safari 15.4+),
// otherwise fall back to a curated list of common zones.

const TIMEZONES: string[] = (() => {
  try {
    return (Intl as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
})().length > 0
  ? (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf!('timeZone')
  : [
      'UTC',
      'America/New_York', 'America/Chicago', 'America/Denver',
      'America/Los_Angeles', 'America/Toronto', 'America/Vancouver',
      'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
      'Europe/Rome', 'Europe/Amsterdam', 'Europe/Stockholm',
      'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Seoul', 'Asia/Kolkata',
      'Asia/Dubai', 'Asia/Singapore', 'Asia/Hong_Kong',
      'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland',
    ];

// ─── Communication style config ───────────────────────────────────────────────

type CommStyle = 'warm' | 'direct' | 'reflective';

const COMM_STYLES: Array<{
  value: CommStyle;
  label: string;
  desc:  string;
}> = [
  {
    value: 'warm',
    label: 'Warm',
    desc:  'Friendly and empathetic — conversations feel supportive and gentle.',
  },
  {
    value: 'direct',
    label: 'Direct',
    desc:  'Clear and concise — responses stay focused and avoid unnecessary softening.',
  },
  {
    value: 'reflective',
    label: 'Reflective',
    desc:  'Thoughtful and exploratory — encourages you to dig deeper into your experiences.',
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
      {children}
    </p>
  );
}

function StreakCard({ streak }: { streak: number }) {
  const hasStreak = streak > 0;
  return (
    <Link
      to="/chat"
      className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
      aria-label={hasStreak ? `${streak} day streak — go to chat` : 'Start your streak — go to chat'}
    >
      {/* Flame icon */}
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl"
        style={{ background: '#FFF3E8' }}
        aria-hidden="true"
      >
        🔥
      </span>
      <div>
        {hasStreak ? (
          <>
            <p className="text-2xl font-bold leading-none text-gray-900">
              {streak}
            </p>
            <p className="text-xs text-gray-400">day streak</p>
          </>
        ) : (
          <p className="text-sm font-medium text-gray-500">
            Start your streak — chat today
          </p>
        )}
      </div>
      {/* Chevron */}
      <svg viewBox="0 0 20 20" fill="currentColor" className="ml-auto h-5 w-5 text-gray-300" aria-hidden="true">
        <path fillRule="evenodd" d="M8.22 5.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 010-1.06z" clipRule="evenodd" />
      </svg>
    </Link>
  );
}

// ─── SettingsScreen ───────────────────────────────────────────────────────────

// ─── DeleteAccountModal (F2-005) ──────────────────────────────────────────────
//
// Full-screen overlay (fixed, inset-0) that sits on top of the Settings screen.
// The user must type the word DELETE exactly (case-sensitive) before the
// confirm button enables — a deliberate friction gate for an irreversible action.

const CONFIRM_WORD = 'DELETE';

interface DeleteAccountModalProps {
  onCancel: () => void;
}

function DeleteAccountModal({ onCancel }: DeleteAccountModalProps) {
  const navigate    = useNavigate();
  const [text,       setText]      = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const canConfirm = text === CONFIRM_WORD && !isDeleting;

  async function handleConfirm() {
    if (!canConfirm) return;
    setIsDeleting(true);
    setError(null);
    try {
      await deleteAccount();
      clearAuth();
      // Navigate with replace so the user can't go "back" to a deleted session
      navigate('/login?deleted=1', { replace: true });
    } catch {
      setError('Something went wrong. Please try again.');
      setIsDeleting(false);
    }
  }

  return (
    /* Full-screen white overlay — no outside-click dismiss, same pattern
       as the memory PIN gate so users can't accidentally dismiss it */
    <div
      className="fixed inset-0 z-50 flex flex-col bg-white"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-dialog-title"
    >
      {/* Header */}
      <div className="flex items-center border-b border-gray-100 px-4 py-3">
        <button
          onClick={onCancel}
          disabled={isDeleting}
          className="text-sm text-gray-500 hover:text-gray-800 disabled:opacity-40"
          aria-label="Cancel account deletion"
        >
          ← Cancel
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        {/* Warning icon */}
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-red-50">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            className="h-7 w-7 text-red-500"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
        </div>

        <h2
          id="delete-dialog-title"
          className="mb-2 text-lg font-semibold text-gray-900"
        >
          Delete your account?
        </h2>

        <p className="mb-6 max-w-xs text-sm leading-relaxed text-gray-500">
          This will permanently delete all your conversations, memories, and
          insights. <strong className="text-gray-700">This cannot be undone.</strong>
        </p>

        {/* Confirmation input */}
        <div className="w-full max-w-xs">
          <p className="mb-2 text-xs text-gray-400">
            Type <span className="font-mono font-semibold text-gray-700">DELETE</span> to confirm
          </p>
          <input
            type="text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && canConfirm) void handleConfirm(); }}
            placeholder="DELETE"
            aria-label="Type DELETE to confirm"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={isDeleting}
            className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-center font-mono text-sm tracking-widest focus:border-red-300 focus:bg-white focus:outline-none disabled:opacity-50"
          />

          {error && (
            <p role="alert" className="mt-2 text-xs text-red-600">
              {error}
            </p>
          )}

          {/* Confirm button */}
          <button
            onClick={() => void handleConfirm()}
            disabled={!canConfirm}
            className="
              mt-4 w-full rounded-xl bg-red-600 py-3 text-sm font-semibold
              text-white transition-opacity hover:bg-red-700
              disabled:cursor-not-allowed disabled:opacity-40
            "
          >
            {isDeleting ? (
              <span className="inline-flex items-center gap-2">
                <span
                  className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
                  aria-hidden="true"
                />
                Deleting…
              </span>
            ) : (
              'Permanently delete account'
            )}
          </button>

          <button
            onClick={onCancel}
            disabled={isDeleting}
            className="mt-3 w-full py-2.5 text-sm text-gray-400 hover:text-gray-600 disabled:opacity-40"
          >
            Keep my account
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SettingsScreen ────────────────────────────────────────────────────────────

export function SettingsScreen() {
  const navigate     = useNavigate();
  const queryClient  = useQueryClient();

  // ── Server state ─────────────────────────────────────────────────────────
  const { data: user, isLoading: userLoading } = useQuery({
    queryKey: ['me'],
    queryFn:  getMe,
    staleTime: 60_000,
  });

  const { data: streakData } = useQuery({
    queryKey: ['streak'],
    queryFn:  getStreak,
    staleTime: 5 * 60_000,
    retry: false,
  });

  // ── Form state ────────────────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState('');
  const [timezone,    setTimezone]    = useState('UTC');
  const [commStyle,   setCommStyle]   = useState<CommStyle>('warm');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [savedVisible, setSavedVisible] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  // ── Export state (F2-004) ─────────────────────────────────────────────────
  // 'idle'    → show button
  // 'loading' → button disabled + spinner
  // 'started' → success message (persists for session, non-dismissible)
  // 'pending' → already-in-progress message
  type ExportState = 'idle' | 'loading' | 'started' | 'pending';
  const [exportState, setExportState] = useState<ExportState>('idle');

  // ── Delete modal (F2-005) ─────────────────────────────────────────────────
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  // Populate form once user data arrives
  useEffect(() => {
    if (user) {
      setDisplayName(user.display_name);
      setTimezone(user.timezone ?? 'UTC');
      setCommStyle(user.comm_style ?? 'warm');
    }
  }, [user]);

  // ── Dirty check ───────────────────────────────────────────────────────────
  const isDirty = user
    ? displayName !== user.display_name ||
      timezone    !== user.timezone     ||
      commStyle   !== user.comm_style
    : false;

  // ── Save ──────────────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: () =>
      patchMe({
        display_name: displayName.trim() || undefined,
        timezone:     timezone || undefined,
        comm_style:   commStyle,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['me'], updated);
      setSavedVisible(true);
      setFieldErrors({});
      setTimeout(() => setSavedVisible(false), 2000);
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        if (err.code === 'INVALID_COMM_STYLE') {
          setFieldErrors({ commStyle: 'Invalid communication style. Please select one of the options.' });
        } else if (err.code === 'VALIDATION_ERROR') {
          setFieldErrors({ general: 'Please check your entries and try again.' });
        } else {
          setFieldErrors({ general: 'Failed to save. Please try again.' });
        }
      } else {
        setFieldErrors({ general: 'Failed to save. Please try again.' });
      }
    },
  });

  // ── Export (F2-004) ───────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    if (exportState !== 'idle') return;
    setExportState('loading');
    try {
      await requestExport();
      setExportState('started');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EXPORT_ALREADY_PENDING') {
        setExportState('pending');
      } else {
        // Other errors: reset to idle so the user can retry
        setExportState('idle');
      }
    }
  }, [exportState]);

  // ── Sign out ──────────────────────────────────────────────────────────────
  const handleSignOut = useCallback(async () => {
    setIsSigningOut(true);
    try {
      await logout();
    } catch {
      // Server-side logout failures are non-fatal — clear client state regardless
    }
    clearAuth();
    navigate('/login', { replace: true });
  }, [navigate]);

  // ─────────────────────────────────────────────────────────────────────────

  if (userLoading) {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-label="Loading settings…">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-gray-600" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Header */}
      <div className="border-b border-gray-100 px-4 py-4">
        <h1 className="text-base font-semibold text-gray-900">Profile & Settings</h1>
      </div>

      <div className="flex-1 space-y-8 px-4 py-6">
        {/* ── Profile fields ───────────────────────────────────────────── */}
        <section aria-labelledby="profile-heading">
          <h2 id="profile-heading" className="sr-only">Profile</h2>

          {/* Display name */}
          <div className="mb-5">
            <SectionLabel>Display name</SectionLabel>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              aria-label="Display name"
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-900 focus:border-gray-400 focus:bg-white focus:outline-none"
              maxLength={80}
            />
          </div>

          {/* Timezone */}
          <div className="mb-5">
            <SectionLabel>Timezone</SectionLabel>
            <input
              type="text"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              list="timezone-datalist"
              aria-label="Timezone"
              placeholder="e.g. America/New_York"
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-900 focus:border-gray-400 focus:bg-white focus:outline-none"
            />
            <datalist id="timezone-datalist">
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </div>

          {/* Communication style */}
          <div className="mb-1">
            <div className="mb-2.5 flex items-start justify-between gap-2">
              <SectionLabel>Communication style</SectionLabel>
            </div>

            {/* Info callout — always visible */}
            <div className="mb-3 flex items-start gap-2 rounded-lg bg-blue-50 px-3 py-2.5 text-xs text-blue-700">
              <svg viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
              </svg>
              This changes how your AI companion speaks with you. You can update it any time.
            </div>

            {/* Style cards */}
            <div className="space-y-2.5" role="radiogroup" aria-label="Communication style">
              {COMM_STYLES.map(({ value, label, desc }) => {
                const selected = commStyle === value;
                return (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={selected}
                    onClick={() => { setCommStyle(value); setFieldErrors((e) => ({ ...e, commStyle: undefined })); }}
                    className={`
                      w-full rounded-xl border p-3.5 text-left transition-colors
                      ${selected
                        ? 'border-slate-700 bg-slate-700 text-white'
                        : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50'}
                    `}
                  >
                    <p className="text-sm font-semibold">{label}</p>
                    <p className={`mt-0.5 text-xs leading-relaxed ${selected ? 'text-white/70' : 'text-gray-400'}`}>
                      {desc}
                    </p>
                  </button>
                );
              })}
            </div>

            {fieldErrors.commStyle && (
              <p role="alert" className="mt-1.5 text-xs text-red-600">
                {fieldErrors.commStyle}
              </p>
            )}
          </div>

          {/* General error */}
          {fieldErrors.general && (
            <p role="alert" className="mt-3 text-sm text-red-600">
              {fieldErrors.general}
            </p>
          )}

          {/* Save button */}
          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={() => saveMutation.mutate()}
              disabled={!isDirty || saveMutation.isPending}
              aria-label="Save changes"
              className="flex items-center gap-2 rounded-lg bg-slate-700 px-5 py-2.5 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saveMutation.isPending && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />
              )}
              Save changes
            </button>

            {/* Inline "Saved" confirmation — visible for 2 s then fades */}
            {savedVisible && (
              <span
                className="flex items-center gap-1 text-sm font-medium text-emerald-600"
                role="status"
                aria-live="polite"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                  <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                </svg>
                Saved
              </span>
            )}
          </div>
        </section>

        {/* ── Streak stat card ──────────────────────────────────────────── */}
        <section aria-labelledby="streak-heading">
          <SectionLabel>Your streak</SectionLabel>
          <StreakCard streak={streakData?.current_streak ?? 0} />
        </section>

        {/* ── Data & Privacy (F2-004) ──────────────────────────────────── */}
        <section aria-labelledby="privacy-heading">
          <SectionLabel>Data &amp; Privacy</SectionLabel>

          <div className="rounded-xl border border-gray-100 bg-white p-4">
            <p className="text-sm font-medium text-gray-900">Export my data</p>
            <p className="mt-0.5 text-xs leading-relaxed text-gray-400">
              Includes all your conversations, memories, and emotional trends
              in a downloadable ZIP.
            </p>

            <div className="mt-3">
              {/* Idle — show the export button */}
              {exportState === 'idle' && (
                <button
                  onClick={() => void handleExport()}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                >
                  Request export
                </button>
              )}

              {/* Loading — spinner */}
              {exportState === 'loading' && (
                <button
                  disabled
                  className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-500 opacity-60"
                >
                  <span
                    className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
                    aria-hidden="true"
                  />
                  Starting export…
                </button>
              )}

              {/* Started — success, non-dismissible, persists for session */}
              {exportState === 'started' && (
                <div
                  className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5"
                  role="status"
                  aria-live="polite"
                >
                  <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500"
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <p className="text-xs leading-relaxed text-emerald-700">
                    Export started — you'll receive an email when it's ready.
                  </p>
                </div>
              )}

              {/* Pending — already in progress */}
              {exportState === 'pending' && (
                <div
                  className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5"
                  role="status"
                  aria-live="polite"
                >
                  <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <p className="text-xs leading-relaxed text-amber-700">
                    An export is already in progress.
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ── Sign out ──────────────────────────────────────────────────── */}
        <section aria-labelledby="signout-heading">
          <h2 id="signout-heading" className="sr-only">Account</h2>
          <button
            onClick={() => void handleSignOut()}
            disabled={isSigningOut}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 py-3 text-sm font-medium text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-50 disabled:opacity-60"
          >
            {isSigningOut ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" aria-hidden="true" />
            ) : (
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-gray-400" aria-hidden="true">
                <path fillRule="evenodd" d="M3 4.25A2.25 2.25 0 015.25 2h5.5A2.25 2.25 0 0113 4.25v2a.75.75 0 01-1.5 0v-2a.75.75 0 00-.75-.75h-5.5a.75.75 0 00-.75.75v11.5c0 .414.336.75.75.75h5.5a.75.75 0 00.75-.75v-2a.75.75 0 011.5 0v2A2.25 2.25 0 0110.75 18h-5.5A2.25 2.25 0 013 15.75V4.25z" clipRule="evenodd" />
                <path fillRule="evenodd" d="M19 10a.75.75 0 00-.75-.75H8.704l1.048-.943a.75.75 0 10-1.004-1.114l-2.5 2.25a.75.75 0 000 1.114l2.5 2.25a.75.75 0 101.004-1.114l-1.048-.943h9.546A.75.75 0 0019 10z" clipRule="evenodd" />
              </svg>
            )}
            Sign out
          </button>
        </section>

        {/* ── Delete account (F2-005) ── */}
        <div className="pb-2 text-center">
          <button
            onClick={() => setShowDeleteModal(true)}
            className="text-xs text-gray-400 underline transition-colors hover:text-red-500"
          >
            Delete account
          </button>
        </div>
      </div>

      {/* Delete confirmation modal (F2-005) */}
      {showDeleteModal && (
        <DeleteAccountModal onCancel={() => setShowDeleteModal(false)} />
      )}
    </div>
  );
}
