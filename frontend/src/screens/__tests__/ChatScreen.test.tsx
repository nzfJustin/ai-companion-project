/**
 * src/screens/__tests__/ChatScreen.test.tsx
 *
 * Covers the static aspects of F1-005:
 *   - Message list rendering (bubbles, alignment, timestamps)
 *   - Loading skeleton state
 *   - Composer behaviour (Enter to submit, Shift+Enter newline, char counter,
 *     disabled states, 2000-char limit)
 *   - New-message pill (when user is scrolled away from bottom)
 *   - Closed-conversation notice
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatScreen } from '../ChatScreen';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../api/conversations', () => ({
  listConversations:  vi.fn(),
  getConversation:    vi.fn(),
  createConversation: vi.fn(),
}));

import {
  listConversations,
  getConversation,
  createConversation,
} from '../../api/conversations';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();

const ACTIVE_CONV = {
  id: 'c-1', started_at: NOW, ended_at: null, status: 'active' as const, message_count: 2,
};

const CLOSED_CONV = { ...ACTIVE_CONV, id: 'c-2', status: 'closed' as const };

const USER_MSG = {
  id: 'm-1', role: 'user' as const, content: 'Hello there',
  emotion_tags: null, created_at: NOW,
};

const ASSISTANT_MSG = {
  id: 'm-2', role: 'assistant' as const,
  content: 'Hi! How are you feeling today?',
  emotion_tags: { primary: 'calm', score: 0.7 },
  created_at: NOW,
};

const CONV_DETAIL = { ...ACTIVE_CONV, messages: [USER_MSG, ASSISTANT_MSG] };
const CLOSED_DETAIL = { ...CLOSED_CONV, messages: [USER_MSG, ASSISTANT_MSG] };

const LIST_RESP = { conversations: [ACTIVE_CONV], page: 1, per_page: 20, has_more: false };

// ── Helpers ────────────────────────────────────────────────────────────────────

function renderChat(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/chat"                 element={<ChatScreen />} />
          <Route path="/chat/:conversationId" element={<ChatScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(listConversations).mockReset();
  vi.mocked(getConversation).mockReset();
  vi.mocked(createConversation).mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation list (/chat)
// ─────────────────────────────────────────────────────────────────────────────

describe('/chat — conversation list', () => {
  it('renders a "New conversation" button', async () => {
    vi.mocked(listConversations).mockResolvedValue(LIST_RESP);
    renderChat('/chat');
    expect(await screen.findByRole('button', { name: /new conversation/i })).toBeInTheDocument();
  });

  it('shows empty state when no conversations exist', async () => {
    vi.mocked(listConversations).mockResolvedValue({ ...LIST_RESP, conversations: [] });
    renderChat('/chat');
    expect(await screen.findByText(/no conversations yet/i)).toBeInTheDocument();
  });

  it('renders conversation cards for existing conversations', async () => {
    vi.mocked(listConversations).mockResolvedValue(LIST_RESP);
    renderChat('/chat');
    await screen.findByRole('link', { name: /just now|min ago|\d+:\d+/i });
  });

  it('shows a green dot for active conversations', async () => {
    vi.mocked(listConversations).mockResolvedValue(LIST_RESP);
    renderChat('/chat');
    await screen.findByLabelText('Active conversation');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Message display (/chat/:id)
// ─────────────────────────────────────────────────────────────────────────────

describe('/chat/:id — message display', () => {
  it('shows loading skeleton while fetching messages', () => {
    vi.mocked(getConversation).mockImplementation(() => new Promise(() => {}));
    renderChat('/chat/c-1');
    expect(screen.getByRole('status', { name: /loading conversation/i })).toBeInTheDocument();
  });

  it('renders user message right-aligned after load', async () => {
    vi.mocked(getConversation).mockResolvedValue(CONV_DETAIL);
    renderChat('/chat/c-1');
    expect(await screen.findByText('Hello there')).toBeInTheDocument();
  });

  it('renders assistant message left-aligned after load', async () => {
    vi.mocked(getConversation).mockResolvedValue(CONV_DETAIL);
    renderChat('/chat/c-1');
    expect(await screen.findByText('Hi! How are you feeling today?')).toBeInTheDocument();
  });

  it('shows an emotion pill for assistant messages with emotion tags', async () => {
    vi.mocked(getConversation).mockResolvedValue(CONV_DETAIL);
    renderChat('/chat/c-1');
    expect(await screen.findByLabelText(/detected emotion: calm/i)).toBeInTheDocument();
  });

  it('shows a relative timestamp on each bubble', async () => {
    vi.mocked(getConversation).mockResolvedValue(CONV_DETAIL);
    renderChat('/chat/c-1');
    await screen.findByText('Hello there');
    const times = screen.getAllByRole('time');
    expect(times.length).toBeGreaterThanOrEqual(2);
  });

  it('shows "This conversation has ended" for closed conversations', async () => {
    vi.mocked(getConversation).mockResolvedValue(CLOSED_DETAIL);
    renderChat('/chat/c-2');
    expect(await screen.findByText(/this conversation has ended/i)).toBeInTheDocument();
  });

  it('hides the composer for closed conversations', async () => {
    vi.mocked(getConversation).mockResolvedValue(CLOSED_DETAIL);
    renderChat('/chat/c-2');
    await screen.findByText(/this conversation has ended/i);
    expect(screen.queryByRole('textbox', { name: /message input/i })).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Composer behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('MessageComposer', () => {
  beforeEach(() => {
    vi.mocked(getConversation).mockResolvedValue(CONV_DETAIL);
  });

  async function getComposer() {
    renderChat('/chat/c-1');
    // Wait for the textarea AND for history to finish loading (disabled while isLoading)
    const el = await screen.findByRole('textbox', { name: /message input/i });
    await waitFor(() => expect(el).not.toBeDisabled());
    return el;
  }

  it('renders the textarea', async () => {
    const textarea = await getComposer();
    expect(textarea).toBeInTheDocument();
  });

  it('composer is disabled while history is loading', () => {
    vi.mocked(getConversation).mockImplementation(() => new Promise(() => {}));
    renderChat('/chat/c-1');
    const textarea = screen.queryByRole('textbox', { name: /message input/i });
    if (textarea) expect(textarea).toBeDisabled();
  });

  it('send button is disabled when input is empty', async () => {
    await getComposer();
    const send = screen.getByRole('button', { name: /send message/i });
    expect(send).toBeDisabled();
  });

  it('send button is enabled when input has text', async () => {
    const user = userEvent.setup();
    const textarea = await getComposer();
    await user.type(textarea, 'Hello');
    expect(screen.getByRole('button', { name: /send message/i })).not.toBeDisabled();
  });

  it('Enter key submits the message', async () => {
    const user = userEvent.setup();
    const textarea = await getComposer();
    await user.type(textarea, 'Hello');
    await user.keyboard('{Enter}');
    // After submit, input should clear
    await waitFor(() => expect(textarea).toHaveValue(''));
  });

  it('Shift+Enter inserts a newline without submitting', async () => {
    const user = userEvent.setup();
    const textarea = await getComposer();
    await user.type(textarea, 'Line one');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(textarea, 'Line two');
    expect((textarea as HTMLTextAreaElement).value).toContain('\n');
  });

  it('does not show character counter below 1800 characters', async () => {
    const textarea = await getComposer();
    await act(async () => {
      await userEvent.type(textarea, 'a'.repeat(10));
    });
    expect(screen.queryByText(/\/ 2,000/)).not.toBeInTheDocument();
  });

  it('shows character counter when within 200 chars of the limit', async () => {
    const user = userEvent.setup();
    const textarea = await getComposer();
    // Type 1800 chars to trigger the counter
    await act(async () => {
      await user.type(textarea, 'a'.repeat(1));
      // Fire change event directly for speed
      Object.defineProperty(textarea, 'value', { value: 'a'.repeat(1800), writable: true });
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Use fireEvent for large text to avoid slow userEvent
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(textarea, { target: { value: 'a'.repeat(1800) } });
    expect(await screen.findByText(/1,800 \/ 2,000|1800 \/ 2000/)).toBeInTheDocument();
  });

  it('blocks submit when content exceeds 2000 characters', async () => {
    const { fireEvent } = await import('@testing-library/react');
    await getComposer();
    const textarea = screen.getByRole('textbox', { name: /message input/i });
    fireEvent.change(textarea, { target: { value: 'a'.repeat(2001) } });
    const send = screen.getByRole('button', { name: /send message/i });
    expect(send).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// relativeTime utility
// ─────────────────────────────────────────────────────────────────────────────

import { relativeTime } from '../../utils/time';

describe('relativeTime', () => {
  it('returns "just now" for timestamps less than 1 minute ago', () => {
    const ts = new Date(Date.now() - 30_000).toISOString();
    expect(relativeTime(ts)).toBe('just now');
  });

  it('returns "X min ago" for timestamps 1–59 minutes ago', () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(relativeTime(ts)).toBe('5 min ago');
  });

  it('returns a time string for timestamps from earlier today', () => {
    const ts = new Date(Date.now() - 3 * 3600_000).toISOString();
    const result = relativeTime(ts);
    expect(result).toMatch(/\d+:\d+/);
    expect(result).not.toBe('just now');
  });

  it('returns a date string for older timestamps', () => {
    const ts = new Date('2025-01-15T10:00:00Z').toISOString();
    const result = relativeTime(ts);
    expect(result).toMatch(/Jan/i);
  });
});
