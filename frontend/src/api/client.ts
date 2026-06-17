/**
 * src/api/client.ts
 *
 * Centralized API client. Every data-fetching call in the app should go
 * through `apiFetch()` — never call the native `fetch()` directly for
 * backend requests (the one exception is SSE streaming in F1-006, which
 * needs raw `fetch` + `ReadableStream` access; that code still reads the
 * token via `getAccessToken()` from the auth store).
 *
 * Responsibilities:
 *   - Inject `Authorization: Bearer <token>` from the Zustand auth store
 *   - On a 401, silently call POST /v1/auth/refresh and retry the
 *     original request once
 *   - If the refresh also fails, clear auth state and redirect to /login
 *
 * ─── Why concurrent refreshes are deduped (read this before changing) ───────
 *
 * The backend's refresh token is one-time-use: each successful refresh
 * rotates it, and replaying an already-used token revokes the entire
 * session family (TOKEN_REUSE_DETECTED), logging the user out.
 *
 * If two API calls fire at roughly the same time and both receive a 401,
 * naively calling /v1/auth/refresh from each would race: both requests
 * read the same (still-valid) refresh_token cookie, but only the first
 * to reach the server succeeds — the second is replaying a token the
 * server already rotated away, and gets treated as a reuse attack.
 *
 * To prevent this, every concurrent caller shares a single in-flight
 * refresh via the module-level `refreshPromise`. Only one network call
 * to /v1/auth/refresh is ever in flight at a time.
 */

import { API_BASE_URL } from './config';
import { getAccessToken, setAccessTokenDirect, clearAuth } from '../store/authStore';

// ─── Error type ───────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REFRESH_PATH = '/v1/auth/refresh';

// ─── Refresh deduplication ────────────────────────────────────────────────────

let refreshPromise: Promise<string> | null = null;

/**
 * Calls POST /v1/auth/refresh and updates the auth store with the new
 * access token. Concurrent callers all await the SAME promise — see the
 * module doc comment above for why this matters.
 */
async function refreshAccessToken(): Promise<string> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const res = await fetch(`${API_BASE_URL}${REFRESH_PATH}`, {
      method: 'POST',
      credentials: 'include', // sends the httpOnly refresh_token cookie
    });

    if (!res.ok) {
      throw new ApiError(res.status, 'REFRESH_FAILED');
    }

    const data = (await res.json()) as { access_token: string };
    setAccessTokenDirect(data.access_token);
    return data.access_token;
  })();

  try {
    return await refreshPromise;
  } finally {
    // Clear so the NEXT 401 (in the future) triggers a fresh refresh call,
    // rather than resolving to this same now-stale promise forever.
    refreshPromise = null;
  }
}

/**
 * Clears auth state and sends the user to /login.
 * A hard navigation (not React Router) is used deliberately here: this
 * function can be called from outside the React tree, and a full
 * navigation guarantees a clean slate (no stale component state).
 */
function redirectToLogin(): void {
  clearAuth();
  if (window.location.pathname !== '/login') {
    window.location.assign('/login');
  }
}

// ─── apiFetch ─────────────────────────────────────────────────────────────────

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  /** JSON-serializable request body. Automatically stringified. */
  body?: unknown;
  /** Internal — set automatically on the post-refresh retry. Do not pass this yourself. */
  _isRetry?: boolean;
}

/**
 * Makes an authenticated JSON request to the backend.
 *
 * @param path     Path relative to API_BASE_URL, e.g. "/v1/users/me"
 * @param options  Same shape as fetch's RequestInit, plus a JSON `body`
 *
 * @throws {ApiError} On any non-2xx response, or if session refresh fails
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const { body, _isRetry, headers, method, ...rest } = options;
  const token = getAccessToken();

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    method: method ?? (body !== undefined ? 'POST' : 'GET'),
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // ── 401 handling ────────────────────────────────────────────────────────────
  if (res.status === 401) {
    // Already retried once, or this 401 IS the refresh call itself —
    // either way, refreshing again won't help. Give up.
    if (_isRetry || path === REFRESH_PATH) {
      redirectToLogin();
      throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
    }

    try {
      await refreshAccessToken();
    } catch {
      redirectToLogin();
      throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
    }

    // Retry the original request exactly once, with the new token.
    return apiFetch<T>(path, { ...options, _isRetry: true });
  }

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}) as { error?: string });
    throw new ApiError(res.status, errorBody.error ?? 'UNKNOWN_ERROR');
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}
