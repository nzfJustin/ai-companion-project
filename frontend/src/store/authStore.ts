/**
 * src/store/authStore.ts
 *
 * Holds the access token in memory ONLY — never localStorage or
 * sessionStorage (per F1-002's security requirement). Lost on page
 * refresh by design; <ProtectedRoute> (F1-003) re-establishes it via a
 * silent call to /v1/auth/refresh on mount, which succeeds as long as
 * the httpOnly refresh_token cookie is still valid.
 *
 * Also holds the elevated token for Level 4–5 memory access (F1-009):
 *   - Stored in-memory with a 10-minute expiry
 *   - Intentionally NOT persisted: page refresh requires a new PIN entry
 *   - Shared across memory detail navigations within the session window
 */

import { create } from 'zustand';

const ELEVATED_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface AuthState {
  accessToken: string | null;
  setAccessToken: (token: string | null) => void;
  clear: () => void;

  // Elevated token for L4/5 memory step-up access (F1-009)
  elevatedToken:       string | null;
  elevatedTokenExpiry: number | null;   // ms timestamp
  setElevatedToken:    (token: string) => void;
  clearElevatedToken:  () => void;
}

// In test environments, ESM imports and CJS require() create separate module
// instances. Pinning the store to globalThis lets both paths share one instance.
declare global { var __authStoreInstance: ReturnType<typeof create<AuthState>> | undefined; }

export const useAuthStore: ReturnType<typeof create<AuthState>> =
  (globalThis.__authStoreInstance ??= create<AuthState>()((set) => ({
  accessToken: null,
  setAccessToken: (token) => set({ accessToken: token }),
  clear: () => set({ accessToken: null, elevatedToken: null, elevatedTokenExpiry: null }),

  elevatedToken:       null,
  elevatedTokenExpiry: null,
  setElevatedToken: (token) =>
    set({ elevatedToken: token, elevatedTokenExpiry: Date.now() + ELEVATED_TOKEN_TTL_MS }),
  clearElevatedToken: () =>
    set({ elevatedToken: null, elevatedTokenExpiry: null }),
})));

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

/**
 * Returns the elevated token if it is still within its 10-minute window,
 * or null if it has expired or was never set.
 * Call this at the start of each L4/5 memory fetch to decide whether to
 * show the PIN gate or proceed directly.
 */
export function getValidElevatedToken(): string | null {
  const { elevatedToken, elevatedTokenExpiry } = useAuthStore.getState();
  if (!elevatedToken || !elevatedTokenExpiry) return null;
  if (Date.now() > elevatedTokenExpiry) {
    // Expired — clean up silently
    useAuthStore.getState().clearElevatedToken();
    return null;
  }
  return elevatedToken;
}

