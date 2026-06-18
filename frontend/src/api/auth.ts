/**
 * src/api/auth.ts
 *
 * Auth-related API calls. Thin typed wrappers over apiFetch() — keeps
 * all fetch/error-handling/retry logic centralized in src/api/client.ts.
 */

import { apiFetch } from './client';

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
