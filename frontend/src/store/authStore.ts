/**
 * src/store/authStore.ts
 *
 * Holds the access token in memory ONLY — never localStorage or
 * sessionStorage (per F1-002's security requirement). Lost on page
 * refresh by design; <ProtectedRoute> (F1-003) re-establishes it via a
 * silent call to /v1/auth/refresh on mount, which succeeds as long as
 * the httpOnly refresh_token cookie is still valid.
 *
 * Components read the token via the `useAuthStore` hook (reactive).
 * Non-component code (the API client) reads/writes via the plain
 * functions below, since hooks can't be called outside React.
 */

import { create } from 'zustand';

interface AuthState {
  accessToken: string | null;
  setAccessToken: (token: string | null) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  accessToken: null,
  setAccessToken: (token) => set({ accessToken: token }),
  clear: () => set({ accessToken: null }),
}));

// ─── Non-hook accessors — for use in src/api/client.ts and similar ───────────

export function getAccessToken(): string | null {
  return useAuthStore.getState().accessToken;
}

export function setAccessTokenDirect(token: string | null): void {
  useAuthStore.getState().setAccessToken(token);
}

export function clearAuth(): void {
  useAuthStore.getState().clear();
}
