/**
 * src/api/__tests__/client.test.ts
 *
 * Unit tests for apiFetch(). Mocks global fetch — no real network calls.
 *
 * The concurrency dedup test is the most important one here: it directly
 * verifies the fix for the race condition described in client.ts's
 * module doc comment (two concurrent 401s must trigger only ONE call to
 * /v1/auth/refresh, not two).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock the env-dependent config module ────────────────────────────────────
vi.mock('../config', () => ({ API_BASE_URL: 'http://test-api.local' }));

import { apiFetch, ApiError } from '../client';
import { useAuthStore } from '../../store/authStore';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

let originalLocation: Location;

beforeEach(() => {
  useAuthStore.getState().clear();
  vi.restoreAllMocks();

  // Mock window.location.assign without navigating jsdom
  originalLocation = window.location;
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...originalLocation, pathname: '/chat', assign: vi.fn() },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: originalLocation,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Basic request behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('apiFetch — basic requests', () => {
  it('makes a GET request by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/v1/users/me');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://test-api.local/v1/users/me',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('defaults to POST when a body is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/v1/conversations', { body: { foo: 'bar' } });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://test-api.local/v1/conversations',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ foo: 'bar' }) }),
    );
  });

  it('includes credentials so the refresh cookie is always sent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/v1/users/me');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('injects Authorization header when a token is present', async () => {
    useAuthStore.getState().setAccessToken('abc123');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/v1/users/me');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer abc123' }),
      }),
    );
  });

  it('omits Authorization header when no token is present', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/v1/users/me');

    const callHeaders = fetchMock.mock.calls[0][1].headers;
    expect(callHeaders.Authorization).toBeUndefined();
  });

  it('returns parsed JSON on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: '123', name: 'Alice' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiFetch<{ id: string; name: string }>('/v1/users/me');

    expect(result).toEqual({ id: '123', name: 'Alice' });
  });

  it('returns undefined for a 204 No Content response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiFetch('/v1/memories/abc');

    expect(result).toBeUndefined();
  });

  it('throws ApiError with the error code on a non-2xx, non-401 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'CONVERSATION_CLOSED' }, 409));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/v1/conversations/x/messages')).rejects.toMatchObject({
      status: 409,
      code: 'CONVERSATION_CLOSED',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 401 → silent refresh → retry once
// ─────────────────────────────────────────────────────────────────────────────

describe('apiFetch — 401 handling', () => {
  it('on 401, calls /v1/auth/refresh then retries the original request once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyResponse(401))                          // original request
      .mockResolvedValueOnce(jsonResponse({ access_token: 'new-token' })) // refresh call
      .mockResolvedValueOnce(jsonResponse({ id: '123' }));                // retried request

    vi.stubGlobal('fetch', fetchMock);

    const result = await apiFetch<{ id: string }>('/v1/users/me');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('http://test-api.local/v1/auth/refresh');
    expect(result).toEqual({ id: '123' });
  });

  it('uses the NEW token on the retried request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyResponse(401))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'fresh-token' }))
      .mockResolvedValueOnce(jsonResponse({ id: '123' }));

    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/v1/users/me');

    const retryCall = fetchMock.mock.calls[2];
    expect(retryCall[1].headers.Authorization).toBe('Bearer fresh-token');
  });

  it('updates the auth store with the new token after a successful refresh', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyResponse(401))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'fresh-token' }))
      .mockResolvedValueOnce(jsonResponse({ id: '123' }));

    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/v1/users/me');

    expect(useAuthStore.getState().accessToken).toBe('fresh-token');
  });

  it('redirects to /login if the refresh call itself fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyResponse(401))   // original request
      .mockResolvedValueOnce(emptyResponse(401));  // refresh call fails too

    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/v1/users/me')).rejects.toThrow(ApiError);
    expect(window.location.assign).toHaveBeenCalledWith('/login');
  });

  it('clears the auth store when refresh fails', async () => {
    useAuthStore.getState().setAccessToken('stale-token');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyResponse(401))
      .mockResolvedValueOnce(emptyResponse(401));

    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/v1/users/me').catch(() => {});

    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('does not retry more than once (gives up if the retried request ALSO 401s)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyResponse(401))                           // original
      .mockResolvedValueOnce(jsonResponse({ access_token: 'new-token' }))  // refresh succeeds
      .mockResolvedValueOnce(emptyResponse(401));                          // retry STILL 401s

    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/v1/users/me')).rejects.toThrow(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3); // original + refresh + one retry — no infinite loop
    expect(window.location.assign).toHaveBeenCalledWith('/login');
  });

  it('does not attempt to refresh if the 401 came from the refresh endpoint itself', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(emptyResponse(401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/v1/auth/refresh')).rejects.toThrow(ApiError);

    // Only the one call — no recursive refresh-of-the-refresh
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.location.assign).toHaveBeenCalledWith('/login');
  });

  it('does not redirect if already on /login', async () => {
    window.location.pathname = '/login';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyResponse(401))
      .mockResolvedValueOnce(emptyResponse(401));

    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/v1/users/me').catch(() => {});

    expect(window.location.assign).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrent refresh deduplication — the critical race-condition fix
// ─────────────────────────────────────────────────────────────────────────────

describe('apiFetch — concurrent refresh deduplication', () => {
  it('two simultaneous 401s trigger only ONE call to /v1/auth/refresh', async () => {
    let refreshCallCount = 0;

    const fetchMock = vi.fn();
    fetchMock
      // First calls to each endpoint both 401 (order: /users/me, /memories)
      .mockImplementationOnce(() => Promise.resolve(emptyResponse(401)))
      .mockImplementationOnce(() => Promise.resolve(emptyResponse(401)))
      // The refresh call — only ONE should ever happen, even though both
      // 401s above will try to trigger it
      .mockImplementationOnce(() => {
        refreshCallCount++;
        return new Promise((resolve) =>
          setTimeout(() => resolve(jsonResponse({ access_token: 'shared-new-token' })), 10),
        );
      })
      // The two retried requests, now with the new token
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ from: 'users/me' })))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ from: 'memories' })));

    vi.stubGlobal('fetch', fetchMock);

    const [resultA, resultB] = await Promise.all([
      apiFetch('/v1/users/me'),
      apiFetch('/v1/memories'),
    ]);

    // Exactly one refresh call, regardless of two concurrent 401s
    expect(refreshCallCount).toBe(1);
    expect(resultA).toBeTruthy();
    expect(resultB).toBeTruthy();
  });

  it('both concurrent callers retry using the same refreshed token', async () => {
    const fetchMock = vi.fn();
    let refreshResolved = false;

    fetchMock
      .mockImplementationOnce(() => Promise.resolve(emptyResponse(401)))
      .mockImplementationOnce(() => Promise.resolve(emptyResponse(401)))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => {
              refreshResolved = true;
              resolve(jsonResponse({ access_token: 'token-xyz' }));
            }, 10),
          ),
      )
      .mockImplementation((_url: string, init: RequestInit) => {
        // Every subsequent call (the two retries) should carry the new token
        const headers = init.headers as Record<string, string>;
        expect(refreshResolved).toBe(true);
        expect(headers.Authorization).toBe('Bearer token-xyz');
        return Promise.resolve(jsonResponse({ ok: true }));
      });

    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([apiFetch('/v1/a'), apiFetch('/v1/b')]);
  });

  it('a later 401/refresh cycle after the first completed one is independent (fresh state)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyResponse(401))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-1' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(emptyResponse(401))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-2' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/v1/users/me');
    expect(useAuthStore.getState().accessToken).toBe('token-1');

    await apiFetch('/v1/users/me');
    expect(useAuthStore.getState().accessToken).toBe('token-2');

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
