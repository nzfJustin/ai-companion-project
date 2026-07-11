/**
 * src/screens/MemoryDetailScreen.tsx
 *
 * F1-009 · Memory Detail & Step-Up PIN Flow
 *
 * Route: /memories/:id
 *
 * Acceptance criteria:
 *   ✓ L1–3 memory: title, decrypted summary, "Key moments" (key_events),
 *     "Emotional tags", date range, back button (navigate(-1) preserves filters)
 *   ✓ L4–5 memory: full-screen PIN gate mounted BEFORE any content renders
 *     (403 from the API triggers the gate; no flash of content possible)
 *   ✓ No way to dismiss the PIN modal by clicking outside or pressing Escape
 *   ✓ Successful PIN verification → elevated token in Zustand (10-min window)
 *     → navigate to another L4–5 memory in the window → skip modal entirely
 *   ✓ 3 consecutive wrong PINs → 15-minute countdown lockout, persisted in
 *     localStorage so it survives page refresh
 *   ✓ Delete action: three-dot menu → confirmation dialog → DELETE → /memories
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getMemory, deleteMemory, type MemoryDetail } from '../api/memories';
import { verifyMemoryPin } from '../api/auth';
import { ApiError } from '../api/client';
import { useAuthStore, getValidElevatedToken } from '../store/authStore';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_WRONG_ATTEMPTS = 3;
const LOCKOUT_MS         = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_KEY        = 'pin_lockout';
const PIN_MIN_LEN        = 4;
const PIN_MAX_LEN        = 6;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(yyyymmdd: string): string {
  const d = new Date(`${yyyymmdd}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function isPinGateRequired(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return (
    (err.status === 403 && err.code === 'MEMORY_ACCESS_DENIED') ||
    (err.status === 401 && err.code === 'ELEVATED_TOKEN_EXPIRED')
  );
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function loadLockout(): number {
  try {
    const raw = localStorage.getItem(LOCKOUT_KEY);
    if (!raw) return 0;
    const { lockedUntil } = JSON.parse(raw) as { lockedUntil: number };
    return lockedUntil > Date.now() ? lockedUntil : 0;
  } catch {
    return 0;
  }
}

function saveLockout(until: number): void {
  localStorage.setItem(LOCKOUT_KEY, JSON.stringify({ lockedUntil: until }));
}

function clearLockout(): void {
  localStorage.removeItem(LOCKOUT_KEY);
}

// ─── PIN Gate ─────────────────────────────────────────────────────────────────
//
// Full-screen overlay that covers the entire viewport. The overlay has
// pointer-events:all so clicks cannot pass through to content behind it,
// and there is no close button or outside-click handler — the only exits
// are "Verify" (success path) and "Go back" (navigate away).

interface PinGateProps {
  onVerified: (elevatedToken: string) => void;
  onGoBack:   () => void;
}

function PinGate({ onVerified, onGoBack }: PinGateProps) {
  const [pin,          setPin]          = useState('');
  const [pinError,     setPinError]     = useState('');
  const [isVerifying,  setIsVerifying]  = useState(false);
  const [wrongCount,   setWrongCount]   = useState(0);
  const [lockedUntil,  setLockedUntil]  = useState<number>(loadLockout);
  const [msLeft,       setMsLeft]       = useState(() => Math.max(0, loadLockout() - Date.now()));
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the PIN input on mount
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Live countdown ticker
  useEffect(() => {
    if (!lockedUntil) return;
    const ms = lockedUntil - Date.now();
    if (ms <= 0) {
      clearLockout();
      setLockedUntil(0);
      setMsLeft(0);
      setWrongCount(0);
      return;
    }
    setMsLeft(ms);
    const id = setInterval(() => {
      const remaining = lockedUntil - Date.now();
      if (remaining <= 0) {
        clearInterval(id);
        clearLockout();
        setLockedUntil(0);
        setMsLeft(0);
        setWrongCount(0);
      } else {
        setMsLeft(remaining);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  const isLocked = lockedUntil > Date.now();
  const canSubmit = !isLocked && pin.length >= PIN_MIN_LEN && !isVerifying;

  async function handleVerify() {
    if (!canSubmit) return;
    setIsVerifying(true);
    setPinError('');
    try {
      const { elevated_token } = await verifyMemoryPin(pin);
      onVerified(elevated_token);
    } catch (err) {
      const newCount = wrongCount + 1;
      setPin('');
      inputRef.current?.focus();

      if (
        newCount >= MAX_WRONG_ATTEMPTS ||
        (err instanceof ApiError && err.status === 429)
      ) {
        const until = Date.now() + LOCKOUT_MS;
        saveLockout(until);
        setLockedUntil(until);
        setMsLeft(LOCKOUT_MS);
        setWrongCount(0); // reset counter after locking
      } else {
        setWrongCount(newCount);
        const remaining = MAX_WRONG_ATTEMPTS - newCount;
        setPinError(
          `Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
        );
      }
    } finally {
      setIsVerifying(false);
    }
  }

  return (
    /* The outer div covers the full screen and blocks all pointer events.
       No onClick handler on the backdrop — clicking outside does nothing. */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-white"
      role="dialog"
      aria-modal="true"
      title="PIN verification required"
    >
      <div className="w-full max-w-xs px-6 py-10 text-center">
        {/* Lock icon */}
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-amber-50">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-7 w-7 text-amber-500" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
        </div>

        <h2 className="mb-1 text-lg font-semibold text-gray-900">Enter your PIN</h2>
        <p className="mb-6 text-sm text-gray-400">
          This memory is protected. Enter your memory PIN to continue.
        </p>

        {isLocked ? (
          /* Lockout state — countdown visible, input hidden, verify hidden */
          <div aria-live="assertive" aria-atomic="true">
            <p className="mb-2 text-sm font-medium text-red-600">Too many attempts.</p>
            <p className="text-3xl font-mono font-semibold text-gray-700" role="timer">
              {formatCountdown(msLeft)}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Try again in {formatCountdown(msLeft)}
            </p>
          </div>
        ) : (
          <>
            {/* PIN input */}
            <input
              ref={inputRef}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              minLength={PIN_MIN_LEN}
              maxLength={PIN_MAX_LEN}
              value={pin}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, PIN_MAX_LEN);
                setPin(v);
                setPinError('');
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleVerify(); }}
              placeholder="••••"
              aria-label="PIN"
              className="mb-3 w-full rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-center text-xl font-mono tracking-[0.3em] text-gray-900 focus:border-gray-400 focus:bg-white focus:outline-none"
            />

            {pinError && (
              <p role="alert" className="mb-3 text-xs text-red-600">
                {pinError}
              </p>
            )}

            {/* Verify button */}
            <button
              onClick={() => void handleVerify()}
              disabled={!canSubmit}
              className="w-full rounded-lg bg-slate-700 px-4 py-3 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isVerifying ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />
                  Verifying…
                </span>
              ) : 'Verify'}
            </button>
          </>
        )}

        {/* Go back — always visible */}
        <button
          onClick={onGoBack}
          className="mt-5 text-sm text-gray-400 hover:text-gray-600 underline"
        >
          Go back
        </button>
      </div>
    </div>
  );
}

// ─── Delete confirm dialog ─────────────────────────────────────────────────────

interface DeleteDialogProps {
  isDeleting: boolean;
  onConfirm:  () => void;
  onCancel:   () => void;
}

function DeleteDialog({ isDeleting, onConfirm, onCancel }: DeleteDialogProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Delete memory confirmation"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-full max-w-sm rounded-t-2xl bg-white p-6 sm:rounded-2xl">
        <h3 className="mb-1 text-base font-semibold text-gray-900">Delete this memory?</h3>
        <p className="mb-5 text-sm text-gray-500">This cannot be undone.</p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isDeleting}
            className="flex-1 rounded-lg bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
          >
            {isDeleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Memory content view (L1–3 or unlocked L4/5) ──────────────────────────────

function MemoryContent({ memory, onDelete }: { memory: MemoryDetail; onDelete: () => void }) {
  const navigate       = useNavigate();
  const [showMenu, setShowMenu] = useState(false);

  function formatDateRange(): string {
    if (memory.period_start === memory.period_end) return formatDate(memory.period_start);
    return `${formatDate(memory.period_start)} – ${formatDate(memory.period_end)}`;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
          aria-label="Back to memories"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
            <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" />
          </svg>
          Back
        </button>

        {/* Three-dot menu */}
        <div className="relative">
          <button
            onClick={() => setShowMenu((v) => !v)}
            aria-label="More options"
            className="flex h-8 w-8 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
              <path d="M3 10a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0zm5.5 0a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0zm5.5 0a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0z" />
            </svg>
          </button>
          {showMenu && (
            <>
              {/* Backdrop */}
              <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
              <div className="absolute right-0 top-9 z-20 w-40 rounded-xl border border-gray-100 bg-white shadow-lg">
                <button
                  onClick={() => { setShowMenu(false); onDelete(); }}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-red-600 hover:bg-red-50 rounded-xl"
                >
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                    <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                  </svg>
                  Delete memory
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-6">
        {/* Title + date range */}
        <div>
          <h1 className="text-lg font-semibold leading-snug text-gray-900">
            {memory.title}
          </h1>
          <p className="mt-1 text-xs text-gray-400">{formatDateRange()}</p>
        </div>

        {/* Summary */}
        <section aria-labelledby="summary-heading">
          <h2 id="summary-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Summary
          </h2>
          <p className="text-sm leading-relaxed text-gray-700">{memory.summary}</p>
        </section>

        {/* Key moments */}
        {memory.key_events.length > 0 && (
          <section aria-labelledby="moments-heading">
            <h2 id="moments-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Key moments
            </h2>
            <ul className="space-y-2">
              {memory.key_events.map((event, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gray-300" aria-hidden="true" />
                  {event}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Emotional tags */}
        {memory.emotional_tags.length > 0 && (
          <section aria-labelledby="emotions-heading">
            <h2 id="emotions-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Emotional tags
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {memory.emotional_tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600"
                >
                  {tag}
                </span>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ─── MemoryDetailScreen ───────────────────────────────────────────────────────

type Phase = 'loading' | 'pin_required' | 'ready' | 'error';

export function MemoryDetailScreen() {
  const { id }   = useParams<{ id: string }>();
  const navigate  = useNavigate();
  const { setElevatedToken } = useAuthStore();

  const [phase,   setPhase]   = useState<Phase>('loading');
  const [memory,  setMemory]  = useState<MemoryDetail | null>(null);
  const [errMsg,  setErrMsg]  = useState('');
  const [showDel, setShowDel] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // ── Fetch memory (with or without elevated token) ────────────────────────

  const fetchMemory = useCallback(async (elevatedToken?: string) => {
    setPhase('loading');
    try {
      const data = await getMemory(id!, elevatedToken);
      setMemory(data);
      setPhase('ready');
    } catch (err) {
      if (isPinGateRequired(err)) {
        setPhase('pin_required');
      } else {
        const msg = err instanceof ApiError
          ? `Could not load this memory (${err.code}).`
          : 'Could not load this memory.';
        setErrMsg(msg);
        setPhase('error');
      }
    }
  }, [id]);

  // On mount: check for a valid session elevated token first to skip the PIN gate
  useEffect(() => {
    const token = getValidElevatedToken();
    void fetchMemory(token ?? undefined);
  }, [fetchMemory]);

  // ── PIN verified ─────────────────────────────────────────────────────────

  async function handlePinVerified(elevatedToken: string) {
    // Store in Zustand for subsequent L4/5 navigations
    setElevatedToken(elevatedToken);
    // Re-fetch the memory now that we have the token
    await fetchMemory(elevatedToken);
  }

  // ── Delete ───────────────────────────────────────────────────────────────

  async function handleDelete() {
    setIsDeleting(true);
    try {
      await deleteMemory(id!);
      navigate('/memories', { replace: true });
    } catch {
      setIsDeleting(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="relative flex h-full flex-col">
      {/* PIN gate — rendered OVER the content (which hasn't loaded yet anyway) */}
      {phase === 'pin_required' && (
        <PinGate
          onVerified={(token) => { void handlePinVerified(token); }}
          onGoBack={() => navigate(-1)}
        />
      )}

      {/* Loading */}
      {phase === 'loading' && (
        <div
          className="flex h-full items-center justify-center"
          role="status"
          aria-label="Loading memory…"
        >
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-gray-600" />
        </div>
      )}

      {/* Error */}
      {phase === 'error' && (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm text-red-500">{errMsg}</p>
          <button onClick={() => navigate(-1)} className="text-sm text-gray-500 underline">
            Go back
          </button>
        </div>
      )}

      {/* Ready */}
      {phase === 'ready' && memory && (
        <MemoryContent memory={memory} onDelete={() => setShowDel(true)} />
      )}

      {/* Delete confirmation dialog */}
      {showDel && (
        <DeleteDialog
          isDeleting={isDeleting}
          onConfirm={() => void handleDelete()}
          onCancel={() => setShowDel(false)}
        />
      )}
    </div>
  );
}
