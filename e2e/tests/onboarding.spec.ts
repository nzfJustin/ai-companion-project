/**
 * tests/onboarding.spec.ts
 *
 * Tests the full onboarding flow including the 3-minute sentinel transition.
 *
 * ⚠️  REQUIREMENT: Set ONBOARDING_OFFER_MS_OVERRIDE=0 on the Railway
 * backend before running these tests. Without it, each test will wait
 * 3+ real minutes for the sentinel to fire.
 *
 * To set it temporarily: Railway → your service → Variables →
 * add ONBOARDING_OFFER_MS_OVERRIDE=0 → redeploy → run tests →
 * then remove the variable and redeploy again for production.
 */

import { test, expect } from '@playwright/test';
import {
  makeUser,
  register,
  login,
  logout,
  deleteCurrentUser,
  completeOnboarding,
  waitForScreen,
  waitForNav,
  sendMessage,
  getState,
} from '../helpers/app';

test.describe('Onboarding flow', () => {
  test('onboarding screen shows correct UI elements', async ({ page }) => {
    const user = makeUser('ob-ui');
    await register(page, user);
    await waitForScreen(page, 'onboarding');

    await expect(page.locator('.topbar-t')).toContainText('Getting to know you');
    await expect(page.locator('.topbar-s')).toContainText('personalises your experience');
    await expect(page.locator('#ci')).toBeVisible();
    await expect(page.locator('.send-btn')).toBeVisible();
    // Bottom nav should NOT be visible during onboarding
    await expect(page.locator('.bnav')).not.toBeVisible();

    await deleteCurrentUser(page);
  });

  test('messages stream token by token during onboarding', async ({ page }) => {
    const user = makeUser('ob-stream');
    await register(page, user);
    await waitForScreen(page, 'onboarding');

    // Send first message and verify streaming happens
    await page.fill('#ci', 'Hello, I am a developer.');
    await page.keyboard.press('Enter');

    // A typing bubble should appear
    await expect(page.locator('.bubble.typing')).toBeVisible({ timeout: 10_000 });

    // Wait for stream to finish
    await page.waitForFunction(() => !(window as any).S?.streaming, { timeout: 60_000 });

    // Assistant message should exist
    const aiMessages = await page.locator('.msg.a').count();
    expect(aiMessages).toBeGreaterThanOrEqual(1);

    // Emotion pill should appear
    await expect(page.locator('.emo-pill').first()).toBeVisible();

    await deleteCurrentUser(page);
  });

  test('full onboarding → transitions to main chat', async ({ page }) => {
    const user = makeUser('ob-full');
    await register(page, user);
    await completeOnboarding(page);

    // Should be on main chat screen
    await waitForScreen(page, 'main');
    await waitForNav(page, 'chat');

    // Bottom nav should now be visible
    await expect(page.locator('.bnav')).toBeVisible();
    // Chat input should be visible
    await expect(page.locator('#ci')).toBeVisible();
    // End button should be visible
    await expect(page.locator('button:has-text("End")')).toBeVisible();

    await deleteCurrentUser(page);
  });

  test('onboarding_done persists — login after onboarding → main chat', async ({ page }) => {
    const user = makeUser('ob-persist');
    await register(page, user);
    await completeOnboarding(page);
    await waitForScreen(page, 'main');

    // Logout
    await logout(page);
    await waitForScreen(page, 'login');

    // Login again
    await login(page, user);

    // Should go to main chat, NOT onboarding
    await waitForScreen(page, 'main', 15_000);
    await expect(page.locator('.bnav')).toBeVisible();
    await expect(page.locator('.topbar-t')).not.toHaveText('Getting to know you');

    await deleteCurrentUser(page);
  });

  test('comm_style is set after onboarding completes', async ({ page }) => {
    const user = makeUser('ob-commstyle');
    await register(page, user);
    await completeOnboarding(page);
    await waitForScreen(page, 'main');

    const state = await getState(page);
    const commStyle = state.user?.comm_style;
    expect(['warm', 'direct', 'reflective']).toContain(commStyle);

    await deleteCurrentUser(page);
  });

  test('Enter key sends message during onboarding', async ({ page }) => {
    const user = makeUser('ob-enter');
    await register(page, user);
    await waitForScreen(page, 'onboarding');

    await page.fill('#ci', 'Testing Enter key');
    await page.keyboard.press('Enter');

    // Input should clear
    await expect(page.locator('#ci')).toHaveValue('');

    // Message should appear in chat
    await expect(page.locator('.msg.u').first()).toContainText('Testing Enter key');

    await page.waitForFunction(() => !(window as any).S?.streaming, { timeout: 60_000 });
    await deleteCurrentUser(page);
  });

  test('Shift+Enter adds newline instead of sending', async ({ page }) => {
    const user = makeUser('ob-shift');
    await register(page, user);
    await waitForScreen(page, 'onboarding');

    await page.fill('#ci', 'Line one');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Line two');

    // Should NOT have sent (no user messages yet, input still has content)
    const inputValue = await page.locator('#ci').inputValue();
    expect(inputValue).toContain('Line one');
    expect(inputValue).toContain('Line two');
    const userMsgs = await page.locator('.msg.u').count();
    expect(userMsgs).toBe(0);

    await deleteCurrentUser(page);
  });
});
