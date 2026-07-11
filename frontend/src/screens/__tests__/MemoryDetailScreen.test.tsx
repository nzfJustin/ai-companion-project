/**
 * src/screens/__tests__/MemoryDetailScreen.test.tsx
 *
 * Tests for F1-009 · Memory Detail & Step-Up PIN Flow.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../api/memories', () => ({
  getMemory:    vi.fn(),
  deleteMemory: vi.fn(),
}));

vi.mock('../../api/auth', () => ({
  verifyMemoryPin: vi.fn(),
}));

// localStorage mock
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem:    (key: string) => store[key] ?? null,
    setItem:    (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
    clear:      () => { store = {}; },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// ── Imports ────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { MemoryDetailScreen } from '../MemoryDetailScreen';
import { ApiError } from '../../api/client';
import { getMemory, deleteMemory } from '../../api/memories';
import { verifyMemoryPin } from '../../api/auth';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const MEM_L2: import('../../api/memories').MemoryDetail = {
  id: 'mem-2', conversation_id: 'conv-2',
  title: 'A good afternoon',
  level: 2,
  dominant_emotion: 'calm',
  summary: 'I had a really peaceful afternoon today. Work felt manageable.',
  key_events: ['Finished a difficult task', 'Took a walk at lunchtime'],
  emotional_tags: ['calm', 'productive', 'grateful'],
  created_at: '2026-01-15T14:00:00Z',
  period_start: '2026-01-15',
  period_end: '2026-01-15',
};

const MEM_L4: import('../../api/memories').MemoryDetail = {
  ...MEM_L2,
  id: 'mem-4',
  level: 4,
  title: 'A very private moment',
  summary: 'This is the full content of a sensitive memory.',
};

const ELEVATED_TOKEN = 'eyJ.elevated.jwt';
const WRONG_PIN_ERROR = new ApiError(401, 'WRONG_PIN');
const LOCKED_ERROR    = new ApiError(429, 'PIN_LOCKED');
const ACCESS_DENIED   = new ApiError(403, 'MEMORY_ACCESS_DENIED');

// ── Helpers ────────────────────────────────────────────────────────────────────

function renderDetail(memoryId = 'mem-2') {
  return render(
    <MemoryRouter initialEntries={[`/memories/${memoryId}`]}>
      <Routes>
        <Route path="/memories/:id" element={<MemoryDetailScreen />} />
        <Route path="/memories"      element={<div data-testid="list">List</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(getMemory).mockReset();
  vi.mocked(deleteMemory).mockReset();
  vi.mocked(verifyMemoryPin).mockReset();
  localStorageMock.clear();
  // Reset Zustand elevated token between tests
  const { useAuthStore } = require('../../store/authStore');
  useAuthStore.getState().clearElevatedToken();
});

// ─────────────────────────────────────────────────────────────────────────────
// L1–3 detail view
// ─────────────────────────────────────────────────────────────────────────────

describe('MemoryDetailScreen — L1-3 detail view', () => {
  beforeEach(() => {
    vi.mocked(getMemory).mockResolvedValue(MEM_L2);
  });

  it('shows a loading state on mount', () => {
    vi.mocked(getMemory).mockImplementation(() => new Promise(() => {}));
    renderDetail();
    expect(screen.getByRole('status', { name: /loading memory/i })).toBeInTheDocument();
  });

  it('renders the memory title', async () => {
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'A good afternoon' })).toBeInTheDocument();
  });

  it('renders the decrypted summary as prose', async () => {
    renderDetail();
    expect(await screen.findByText(/peaceful afternoon/i)).toBeInTheDocument();
  });

  it('renders a "Key moments" section with key_events', async () => {
    renderDetail();
    expect(await screen.findByRole('heading', { name: /key moments/i })).toBeInTheDocument();
    expect(screen.getByText('Finished a difficult task')).toBeInTheDocument();
    expect(screen.getByText('Took a walk at lunchtime')).toBeInTheDocument();
  });

  it('renders an "Emotional tags" section', async () => {
    renderDetail();
    expect(await screen.findByRole('heading', { name: /emotional tags/i })).toBeInTheDocument();
    expect(screen.getByText('calm')).toBeInTheDocument();
    expect(screen.getByText('productive')).toBeInTheDocument();
    expect(screen.getByText('grateful')).toBeInTheDocument();
  });

  it('renders the date range', async () => {
    renderDetail();
    expect(await screen.findByText(/Jan 15, 2026/)).toBeInTheDocument();
  });

  it('renders a back button', async () => {
    renderDetail();
    expect(await screen.findByRole('button', { name: /back/i })).toBeInTheDocument();
  });

  it('does NOT show the PIN gate for L1-3 memories', async () => {
    renderDetail();
    await screen.findByText('A good afternoon');
    expect(screen.queryByRole('dialog', { name: /pin/i })).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L4–5 PIN gate — initial display
// ─────────────────────────────────────────────────────────────────────────────

describe('MemoryDetailScreen — PIN gate (L4-5)', () => {
  beforeEach(() => {
    // First fetch returns 403 (no elevated token) — triggers PIN gate
    vi.mocked(getMemory).mockRejectedValue(ACCESS_DENIED);
  });

  it('shows the PIN gate immediately when the API returns 403', async () => {
    renderDetail('mem-4');
    expect(await screen.findByRole('dialog', { name: /pin verification/i })).toBeInTheDocument();
  });

  it('shows a PIN input in the gate', async () => {
    renderDetail('mem-4');
    expect(await screen.findByLabelText(/pin/i)).toBeInTheDocument();
  });

  it('shows a Verify button', async () => {
    renderDetail('mem-4');
    expect(await screen.findByRole('button', { name: /verify/i })).toBeInTheDocument();
  });

  it('shows a "Go back" link', async () => {
    renderDetail('mem-4');
    expect(await screen.findByRole('button', { name: /go back/i })).toBeInTheDocument();
  });

  it('does NOT show any memory content while the gate is open', async () => {
    renderDetail('mem-4');
    await screen.findByRole('dialog');
    expect(screen.queryByText('A very private moment')).not.toBeInTheDocument();
  });

  it('only accepts numeric input in the PIN field', async () => {
    vi.mocked(getMemory).mockRejectedValue(ACCESS_DENIED);
    const user = userEvent.setup();
    renderDetail('mem-4');

    const input = await screen.findByLabelText(/pin/i);
    await user.type(input, 'abc123def');
    expect((input as HTMLInputElement).value).toBe('123');
  });

  it('Verify button is disabled when PIN is shorter than 4 digits', async () => {
    const user = userEvent.setup();
    renderDetail('mem-4');

    const input = await screen.findByLabelText(/pin/i);
    await user.type(input, '123');
    expect(screen.getByRole('button', { name: /verify/i })).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PIN verification — success path
// ─────────────────────────────────────────────────────────────────────────────

describe('MemoryDetailScreen — successful PIN verification', () => {
  it('closes the PIN gate and shows memory content after correct PIN', async () => {
    vi.mocked(getMemory)
      .mockRejectedValueOnce(ACCESS_DENIED)        // first fetch — no token
      .mockResolvedValueOnce(MEM_L4);              // second fetch — with token
    vi.mocked(verifyMemoryPin).mockResolvedValue({ elevated_token: ELEVATED_TOKEN });

    const user = userEvent.setup();
    renderDetail('mem-4');

    await user.type(await screen.findByLabelText(/pin/i), '1234');
    await user.click(screen.getByRole('button', { name: /verify/i }));

    expect(await screen.findByRole('heading', { name: 'A very private moment' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /pin/i })).not.toBeInTheDocument();
  });

  it('stores the elevated token in the auth store', async () => {
    vi.mocked(getMemory)
      .mockRejectedValueOnce(ACCESS_DENIED)
      .mockResolvedValueOnce(MEM_L4);
    vi.mocked(verifyMemoryPin).mockResolvedValue({ elevated_token: ELEVATED_TOKEN });

    const user = userEvent.setup();
    renderDetail('mem-4');

    await user.type(await screen.findByLabelText(/pin/i), '1234');
    await user.click(screen.getByRole('button', { name: /verify/i }));

    await screen.findByText('A very private moment');

    const { getValidElevatedToken } = require('../../store/authStore');
    expect(getValidElevatedToken()).toBe(ELEVATED_TOKEN);
  });

  it('skips the PIN gate when a valid elevated token is already in the store', async () => {
    // Pre-set a valid elevated token
    const { useAuthStore } = require('../../store/authStore');
    useAuthStore.getState().setElevatedToken(ELEVATED_TOKEN);

    // API called with the stored token → succeeds immediately
    vi.mocked(getMemory).mockResolvedValue(MEM_L4);

    renderDetail('mem-4');

    expect(await screen.findByText('A very private moment')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(vi.mocked(verifyMemoryPin)).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wrong PIN and lockout
// ─────────────────────────────────────────────────────────────────────────────

describe('MemoryDetailScreen — wrong PIN and lockout', () => {
  beforeEach(() => {
    vi.mocked(getMemory).mockRejectedValue(ACCESS_DENIED);
  });

  it('shows an error after one wrong PIN', async () => {
    vi.mocked(verifyMemoryPin).mockRejectedValue(WRONG_PIN_ERROR);
    const user = userEvent.setup();
    renderDetail('mem-4');

    await user.type(await screen.findByLabelText(/pin/i), '0000');
    await user.click(screen.getByRole('button', { name: /verify/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect pin/i);
  });

  it('shows remaining attempts in the error message', async () => {
    vi.mocked(verifyMemoryPin).mockRejectedValue(WRONG_PIN_ERROR);
    const user = userEvent.setup();
    renderDetail('mem-4');

    await user.type(await screen.findByLabelText(/pin/i), '0000');
    await user.click(screen.getByRole('button', { name: /verify/i }));

    // After 1 wrong attempt: 2 remaining
    expect(await screen.findByText(/2 attempts remaining/i)).toBeInTheDocument();
  });

  it('shows the lockout countdown after 3 wrong attempts', async () => {
    vi.mocked(verifyMemoryPin).mockRejectedValue(WRONG_PIN_ERROR);
    const user = userEvent.setup();
    renderDetail('mem-4');

    const input = await screen.findByLabelText(/pin/i);
    for (let i = 0; i < 3; i++) {
      await user.clear(input);
      await user.type(input, '0000');
      await user.click(screen.getByRole('button', { name: /verify/i }));
      // Wait for re-render
      if (i < 2) await screen.findByRole('alert');
    }

    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument();
    expect(screen.getByRole('timer')).toBeInTheDocument();
  });

  it('hides the Verify button during lockout', async () => {
    vi.mocked(verifyMemoryPin).mockRejectedValue(WRONG_PIN_ERROR);
    const user = userEvent.setup();
    renderDetail('mem-4');

    const input = await screen.findByLabelText(/pin/i);
    for (let i = 0; i < 3; i++) {
      await user.clear(input);
      await user.type(input, '0000');
      await user.click(screen.getByRole('button', { name: /verify/i }));
      if (i < 2) await screen.findByRole('alert');
    }

    await screen.findByText(/too many attempts/i);
    expect(screen.queryByRole('button', { name: /verify/i })).not.toBeInTheDocument();
  });

  it('persists lockout state in localStorage', async () => {
    vi.mocked(verifyMemoryPin).mockRejectedValue(WRONG_PIN_ERROR);
    const user = userEvent.setup();
    renderDetail('mem-4');

    const input = await screen.findByLabelText(/pin/i);
    for (let i = 0; i < 3; i++) {
      await user.clear(input);
      await user.type(input, '0000');
      await user.click(screen.getByRole('button', { name: /verify/i }));
      if (i < 2) await screen.findByRole('alert');
    }

    await screen.findByText(/too many attempts/i);
    expect(localStorageMock.getItem('pin_lockout')).not.toBeNull();
  });

  it('shows the lockout immediately if localStorage has an active lockout on mount', async () => {
    const lockedUntil = Date.now() + 5 * 60 * 1000; // 5 minutes from now
    localStorageMock.setItem('pin_lockout', JSON.stringify({ lockedUntil }));

    renderDetail('mem-4');

    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument();
    expect(screen.getByRole('timer')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delete action
// ─────────────────────────────────────────────────────────────────────────────

describe('MemoryDetailScreen — delete action', () => {
  beforeEach(() => {
    vi.mocked(getMemory).mockResolvedValue(MEM_L2);
    vi.mocked(deleteMemory).mockResolvedValue(undefined);
  });

  it('opens a confirmation dialog when "Delete memory" is chosen from the menu', async () => {
    const user = userEvent.setup();
    renderDetail();

    await screen.findByText('A good afternoon');
    await user.click(screen.getByRole('button', { name: /more options/i }));
    await user.click(screen.getByRole('button', { name: /delete memory/i }));

    expect(screen.getByRole('dialog', { name: /delete memory/i })).toBeInTheDocument();
    expect(screen.getByText(/this cannot be undone/i)).toBeInTheDocument();
  });

  it('calls the delete API and navigates back when "Delete" is confirmed', async () => {
    const user = userEvent.setup();
    renderDetail();

    await screen.findByText('A good afternoon');
    await user.click(screen.getByRole('button', { name: /more options/i }));
    await user.click(screen.getByRole('button', { name: /delete memory/i }));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(vi.mocked(deleteMemory)).toHaveBeenCalledWith('mem-2');
    expect(await screen.findByTestId('list')).toBeInTheDocument();
  });

  it('dismisses the dialog without deleting when "Cancel" is clicked', async () => {
    const user = userEvent.setup();
    renderDetail();

    await screen.findByText('A good afternoon');
    await user.click(screen.getByRole('button', { name: /more options/i }));
    await user.click(screen.getByRole('button', { name: /delete memory/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(vi.mocked(deleteMemory)).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /delete memory/i })).not.toBeInTheDocument();
  });
});
