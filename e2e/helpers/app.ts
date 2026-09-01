/**
 * helpers/app.ts
 *
 * Page-level helpers for interacting with memo_app.html.
 *
 * memo_app.html is a vanilla-JS SPA that exposes its state via window.S
 * and its actions via window.doLogin, window.switchNav, etc.
 * These helpers bridge Playwright with that global API.
 */

import { Page, expect } from '@playwright/test';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TestUser {
  displayName: string;
  email:       string;
  password:    string;
}

// ─── Test user factory ────────────────────────────────────────────────────────

export function makeUser(prefix = 'e2e'): TestUser {
  const ts = Date.now();
  return {
    displayName: `${prefix} ${ts}`,
    email:       `${prefix}+${ts}@test-memo.invalid`,
    password:    'TestPass123!',
  };
}

// ─── Screen / nav waits ───────────────────────────────────────────────────────

export async function waitForScreen(page: Page, screen: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    (s: string) => (window as any).S?.screen === s,
    screen,
    { timeout },
  );
}

export async function waitForNav(page: Page, nav: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    (n: string) => (window as any).S?.nav === n,
    nav,
    { timeout },
  );
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

/**
 * Navigate to the app and register a new user.
 * Lands on onboarding screen on success.
 */
export async function register(page: Page, user: TestUser): Promise<void> {
  await page.goto('/');
  await waitForScreen(page, 'login');
  await page.click('button:has-text("Create account")');
  await waitForScreen(page, 'register');
  await page.fill('#rn', user.displayName);
  await page.fill('#re', user.email);
  await page.fill('#rp', user.password);
  await page.click('button.btn-p:has-text("Create account")');
  await waitForScreen(page, 'onboarding', 15_000);
}

/**
 * Fill the login form and submit.
 */
export async function login(page: Page, user: TestUser): Promise<void> {
  await page.goto('/');
  await waitForScreen(page, 'login');
  await page.fill('#le', user.email);
  await page.fill('#lp', user.password);
  await page.click('button.btn-p:has-text("Sign in")');
}

/**
 * Click the sign-out button in Settings.
 */
export async function logout(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).doLogout());
  await waitForScreen(page, 'login');
}

/**
 * Delete the currently authenticated test user via the backend API.
 * Call this in afterEach / afterAll to keep the DB clean.
 */
export async function deleteCurrentUser(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const S = (window as any).S;
    if (!S?.token || !S?.cfg?.url) return;
    await fetch(`${S.cfg.url}/v1/users/me`, {
      method:      'DELETE',
      headers:     { Authorization: `Bearer ${S.token}` },
      credentials: 'include',
    });
  });
}

// ─── Onboarding helpers ───────────────────────────────────────────────────────

/**
 * Send a message and wait for the AI response to finish streaming.
 * Returns the emotion tag from the done event (may be undefined).
 */
export async function sendMessage(page: Page, content: string): Promise<void> {
  // Wait for input to be ready
  await page.waitForSelector('#ci', { state: 'visible' });
  await page.fill('#ci', content);
  await page.keyboard.press('Enter');

  // Wait for streaming to finish (send button re-enables)
  await page.waitForFunction(
    () => !(window as any).S?.streaming,
    { timeout: 60_000 },
  );
}

/**
 * Complete onboarding by sending seed messages.
 * Requires ONBOARDING_OFFER_MS_OVERRIDE=0 on the backend so the
 * sentinel fires on the first eligible message instead of after 3 minutes.
 *
 * Flow:
 *   1. Send seed messages
 *   2. The backend injects the transition offer sentinel
 *   3. Reply "yes" → backend closes conversation, sets onboarding_done=true
 *   4. Frontend reads onboardingComplete:true from done event → navigates to main chat
 */
export async function completeOnboarding(page: Page): Promise<void> {
  await waitForScreen(page, 'onboarding');

  // Send seed messages
  await sendMessage(page, "Hi, I'm a developer building an AI app.");
  await sendMessage(page, 'I have been feeling stressed lately with my project launch.');
  await sendMessage(page, 'I hope this app helps me reflect on my emotions.');
  await sendMessage(page, 'I usually feel better after talking things through.');

  // The sentinel may already be embedded — reply to accept the transition offer.
  // If the AI hasn't asked yet, send one more message to trigger it.
  const isOnboarding = await page.evaluate(() => (window as any).S?.screen === 'onboarding');
  if (isOnboarding) {
    await sendMessage(page, 'yes, let\'s go to the main chat');
  }

  // Wait for transition (up to 60s in case ONBOARDING_OFFER_MS_OVERRIDE is not 0)
  await waitForScreen(page, 'main', 90_000);
  await waitForNav(page, 'chat', 10_000);
}

/**
 * Bypass onboarding in the frontend only (no backend change).
 * Use for tests that don't depend on the onboarding_done DB flag.
 */
export async function bypassOnboarding(page: Page): Promise<void> {
  await waitForScreen(page, 'onboarding');
  await page.evaluate(async () => {
    const w = window as any;
    w.S.screen = 'main';
    w.S.nav    = 'chat';
    await w.loadOrCreateConv();
    w.render();
  });
  await waitForScreen(page, 'main');
}

// ─── Chat helpers ─────────────────────────────────────────────────────────────

/**
 * End the current conversation by clicking ✕ End.
 * Waits for the "Session saved" session-ended state.
 */
export async function endSession(page: Page): Promise<void> {
  await page.click('button.ico-btn:has-text("End")');
  // Wait for sessionJustEnded state
  await page.waitForFunction(
    () => (window as any).S?.sessionJustEnded === true,
    { timeout: 15_000 },
  );
}

/**
 * Close the conversation via the API directly (bypasses 401 risk).
 */
export async function closeConversation(page: Page): Promise<void> {
  const status = await page.evaluate(async () => {
    const S = (window as any).S;
    if (!S.convId) return null;
    const res = await (window as any).api('PATCH', `/v1/conversations/${S.convId}`, { status: 'closed' });
    return res?.status;
  });
  expect(status).toBe(200);
  await page.evaluate(async () => {
    const w = window as any;
    w.S.msgs             = [];
    w.S.convId           = null;
    w.S.sessionJustEnded = true;
    await w.loadOrCreateConv();
    w.render();
  });
}

// ─── Memory helpers ───────────────────────────────────────────────────────────

/**
 * Navigate to the Memories tab and wait for at least one memory card to appear.
 * Polls the refresh button up to maxAttempts times with a delay between each.
 */
export async function waitForMemory(
  page:        Page,
  maxWaitMs:   number = 90_000,
  pollIntervalMs: number = 8_000,
): Promise<void> {
  await page.evaluate(() => {
    (window as any).S.nav = 'memories';
  });
  await page.evaluate(() => (window as any).loadMemories());
  await page.waitForFunction(() => !(window as any).S?.loading, { timeout: 15_000 });

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => (window as any).S?.memories?.length ?? 0);
    if (count > 0) {
      await page.evaluate(() => (window as any).render());
      return;
    }
    await page.waitForTimeout(pollIntervalMs);
    await page.evaluate(() => (window as any).loadMemories());
    await page.waitForFunction(() => !(window as any).S?.loading, { timeout: 15_000 });
  }
  throw new Error(`No memories appeared after ${maxWaitMs}ms`);
}

// ─── State readers ────────────────────────────────────────────────────────────

export async function getState(page: Page): Promise<any> {
  return page.evaluate(() => {
    const S = (window as any).S;
    return {
      screen:           S.screen,
      nav:              S.nav,
      convId:           S.convId,
      streaming:        S.streaming,
      sessionJustEnded: S.sessionJustEnded,
      user:             S.user,
      memories:         S.memories,
      trends:           S.trends,
      streak:           S.streak,
    };
  });
}
