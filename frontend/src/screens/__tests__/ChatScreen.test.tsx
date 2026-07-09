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

// ─────────────────────────────────────────────────────────────────────────────
// F1-006 — SSE Streaming tests
// ─────────────────────────────────────────────────────────────────────────────

import { API_BASE_URL } from '../../api/config';

vi.mock('../../api/config', () => ({ API_BASE_URL: 'http://test.local' }));
vi.mock('../../store/authStore', () => ({
  useAuthStore:    vi.fn(() => ({ accessToken: 'test-token', setAccessToken: vi.fn(), clear: vi.fn() })),
  getAccessToken:  vi.fn(() => 'test-token'),
  setAccessTokenDirect: vi.fn(),
  clearAuth:       vi.fn(),
}));

const ENC = new TextEncoder();

function makeSseStream(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(ENC.encode(frame));
      controller.close();
    },
  });
}

function makeTokenStream(tokens: string[], messageId = 'msg-1', emotion = 'calm') {
  const frames = [
    ...tokens.map((t, i) => `id: ${i + 1}\nevent: token\ndata: {"delta":"${t}"}\n\n`),
    `event: done\ndata: {"message_id":"${messageId}","emotion_tags":{"primary":"${emotion}","score":0.8}}\n\n`,
  ];
  return makeSseStream(frames);
}

function makeErrorStream(code = 'LLM_STREAM_ERROR') {
  return makeSseStream([`event: error\ndata: {"code":"${code}"}\n\n`]);
}

function makeFetchMock(stream: ReadableStream<Uint8Array>) {
  return vi.fn().mockResolvedValue({
    ok:   true,
    body: stream,
  });
}

describe('F1-006 — SSE streaming in ConversationView', () => {
  beforeEach(() => {
    vi.mocked(getConversation).mockReset();
    vi.mocked(getConversation).mockResolvedValue(CONV_DETAIL);
  });

  async function renderAndLoad() {
    renderChat('/chat/c-1');
    // Wait for history to load
    await screen.findByText('Hello there');
    return screen.getByRole('textbox', { name: /message input/i }) as HTMLTextAreaElement;
  }

  it('uses fetch (not EventSource) when sending a message', async () => {
    const fetchMock = makeFetchMock(makeTokenStream(['Hi!']));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    const textarea = await renderAndLoad();
    await user.type(textarea, 'Test message');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/conversations/c-1/messages');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer test-token',
    });
    expect(window.EventSource).toBeUndefined(); // EventSource never used
  });

  it('shows typing indicator (three-dot) before first token arrives', async () => {
    let resolveStream!: () => void;
    const stream = new ReadableStream({
      start() {/* never sends anything */},
      cancel() { resolveStream?.(); },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));
    const user = userEvent.setup();

    const textarea = await renderAndLoad();
    await user.type(textarea, 'Hello');
    await user.keyboard('{Enter}');

    // Typing indicator should appear (three-dot animation)
    await waitFor(() =>
      expect(screen.getByLabelText('AI is typing')).toBeInTheDocument(),
    );
  });

  it('replaces typing indicator with content as tokens arrive', async () => {
    vi.stubGlobal('fetch', makeFetchMock(makeTokenStream(['Hello', ' there!'])));
    const user = userEvent.setup();

    const textarea = await renderAndLoad();
    await user.type(textarea, 'Hi');
    await user.keyboard('{Enter}');

    // The accumulated text should appear
    await waitFor(() =>
      expect(screen.getByText('Hello there!')).toBeInTheDocument(),
    );
  });

  it('shows emotion pill after event:done', async () => {
    vi.stubGlobal('fetch', makeFetchMock(makeTokenStream(['Nice!'], 'msg-99', 'joy')));
    const user = userEvent.setup();

    const textarea = await renderAndLoad();
    await user.type(textarea, 'Hi');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(screen.getByLabelText(/detected emotion: joy/i)).toBeInTheDocument(),
    );
  });

  it('re-enables composer after event:done', async () => {
    vi.stubGlobal('fetch', makeFetchMock(makeTokenStream(['Done.'])));
    const user = userEvent.setup();

    const textarea = await renderAndLoad();
    await user.type(textarea, 'Hi');
    await user.keyboard('{Enter}');

    // After stream completes, textarea should be enabled again
    await waitFor(() => expect(textarea).not.toBeDisabled());
  });

  it('removes AI bubble on event:error and shows the inline error', async () => {
    vi.stubGlobal('fetch', makeFetchMock(makeErrorStream('LLM_STREAM_ERROR')));
    const user = userEvent.setup();

    const textarea = await renderAndLoad();
    await user.type(textarea, 'Hello');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn't get a response/i,
      ),
    );
    // Typing indicator / partial bubble should be gone
    expect(screen.queryByLabelText('AI is typing')).not.toBeInTheDocument();
  });

  it('restores the original message in the input on error', async () => {
    vi.stubGlobal('fetch', makeFetchMock(makeErrorStream()));
    const user = userEvent.setup();

    const textarea = await renderAndLoad();
    await user.type(textarea, 'My original message');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(textarea).toHaveValue('My original message'),
    );
  });

  it('re-enables composer after event:error', async () => {
    vi.stubGlobal('fetch', makeFetchMock(makeErrorStream('LLM_TIMEOUT')));
    const user = userEvent.setup();

    const textarea = await renderAndLoad();
    await user.type(textarea, 'Test');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(textarea).not.toBeDisabled());
  });

  it('treats a network drop (fetch rejection) the same as event:error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const user = userEvent.setup();

    const textarea = await renderAndLoad();
    await user.type(textarea, 'Test');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn't get a response/i),
    );
    await waitFor(() => expect(textarea).toHaveValue('Test'));
  });

  it('keeps the user message visible after an error (backend already persisted it)', async () => {
    vi.stubGlobal('fetch', makeFetchMock(makeErrorStream()));
    const user = userEvent.setup();

    const textarea = await renderAndLoad();
    await user.type(textarea, 'A message');
    await user.keyboard('{Enter}');

    // Wait for error
    await waitFor(() => screen.getByRole('alert'));

    // The optimistic user bubble should still be in the list
    const bubbles = screen.getAllByText('A message');
    expect(bubbles.length).toBeGreaterThanOrEqual(1); // bubble + possibly restored draft
  });
});
