/**
 * src/api/auth.ts
 *
 * Auth-related API calls. Thin typed wrappers over apiFetch() — keeps
 * all fetch/error-handling/retry logic centralized in src/api/client.ts.
 */

import { apiFetch, ApiError } from './client';
import { API_BASE_URL } from './config';
import { setAccessTokenDirect } from '../store/authStore';

// ─── Register ─────────────────────────────────────────────────────────────────

export interface RegisterPayload {
  display_name: string;
  email: string;
  password: string;
}

export interface RegisterResponse {
  id: string;
  display_name: string;
}

export function register(payload: RegisterPayload): Promise<RegisterResponse> {
  return apiFetch<RegisterResponse>('/v1/auth/register', {
    method: 'POST',
    body: payload,
  });
}

// ─── Login ────────────────────────────────────────────────────────────────────

export interface LoginPayload {
  email: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export function login(payload: LoginPayload): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/v1/auth/login', {
    method: 'POST',
    body: payload,
  });
}

// ─── Current user ─────────────────────────────────────────────────────────────

export interface MeResponse {
  id: string;
  email: string;
  display_name: string;
  timezone: string;
  comm_style: 'warm' | 'direct' | 'reflective';
  onboarding_done: boolean;
  created_at: string;
}

export function getMe(): Promise<MeResponse> {
  return apiFetch<MeResponse>('/v1/users/me', { method: 'GET' });
}

// ─── Session refresh (used by ProtectedRoute) ─────────────────────────────────

/**
 * Calls POST /v1/auth/refresh directly — not through apiFetch — so there
 * is no risk of infinite recursion (apiFetch itself calls this path when
 * handling a 401). On success, writes the new access token to the Zustand
 * store so every subsequent apiFetch call picks it up automatically.
 *
 * @throws {ApiError} when the refresh token is missing/expired/revoked
 */
export async function refreshSession(): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/v1/auth/refresh`, {
    method: 'POST',
    credentials: 'include', // sends the httpOnly refresh_token cookie
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new ApiError(res.status, body.error ?? 'REFRESH_FAILED');
  }

  const data = (await res.json()) as { access_token: string };
  setAccessTokenDirect(data.access_token);
}

// ─── Logout ───────────────────────────────────────────────────────────────────

/**
 * Revokes the current session on the server. The caller is responsible
 * for clearing client-side auth state (useAuthStore.clear()) and
 * redirecting to /login — this function only makes the API call.
 *
 * Errors are intentionally swallowed by the caller in AppShell because
 * we must clear the client session regardless of server-side success.
 */
export function logout(): Promise<void> {
  return apiFetch('/v1/auth/logout', { method: 'POST' });
}

// ─── Memory PIN verification (F1-009) ─────────────────────────────────────────

export interface VerifyPinResponse {
  /** Signed RS256 JWT to pass as X-Elevated-Token header on L4/5 memory reads */
  elevated_token: string;
}

/**
 * Verifies the user's memory PIN and returns a short-lived elevated token
 * (valid for 10 minutes server-side) that unlocks Level 4–5 memory access.
 *
 * @throws {ApiError(401, 'WRONG_PIN')}   Wrong PIN entered
 * @throws {ApiError(429, 'PIN_LOCKED')}  Three consecutive wrong attempts
 */
export function verifyMemoryPin(pin: string): Promise<VerifyPinResponse> {
  return apiFetch<VerifyPinResponse>('/v1/auth/memory-pin/verify', {
    method: 'POST',
    body:   { pin },
  });
}
