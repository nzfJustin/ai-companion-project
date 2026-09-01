/**
 * tests/trends.spec.ts
 *
 * Tests the Trends tab: streak counter, dominant emotion, emotion bars.
 * Requires a user who has at least one closed+extracted conversation.
 */

import { test, expect } from '@playwright/test';
import {
  makeUser,
  register,
  login,
  deleteCurrentUser,
  bypassOnboarding,
  waitForScreen,
  sendMessage,
  closeConversation,
} from '../helpers/app';

let sharedUser: { displayName: string; email: string; password: string };

test.beforeAll(async ({ browser }) => {
  sharedUser = makeUser('trends');
  const page = await browser.newPage();

  await register(page, sharedUser);
  await bypassOnboarding(page);
  await waitForScreen(page, 'main');

  await sendMessage(page, 'I feel calm and focused today.');
  await sendMessage(page, 'Making good progress on my project.');
  await closeConversation(page);

  // Wait for extraction to complete
  await page.waitForTimeout(65_000);
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page, sharedUser);
  await waitForScreen(page, 'main');
  await deleteCurrentUser(page);
  await page.close();
});

test.beforeEach(async ({ page }) => {
  await login(page, sharedUser);
  const screen = await page.evaluate(() => (window as any).S?.screen);
  if (screen === 'onboarding') await bypassOnboarding(page);
  await waitForScreen(page, 'main');

  // Navigate to Trends tab
  await page.evaluate(async () => {
    const w = window as any;
    w.S.nav = 'trends';
    await w.loadTrends();
    w.render();
  });
  await page.waitForFunction(() => !(window as any).S?.loading, { timeout: 20_000 });
});

test.describe('Trends tab', () => {
  test('Trends tab is accessible from bottom nav', async ({ page }) => {
    await page.goto('/');
    await login(page, sharedUser);
    const screen = await page.evaluate(() => (window as any).S?.screen);
    if (screen === 'onboarding') await bypassOnboarding(page);
    await waitForScreen(page, 'main');

    await page.click('.bnav-btn:has-text("Trends")');
    await page.waitForFunction(() => (window as any).S?.nav === 'trends', { timeout: 10_000 });
    await expect(page.locator('.topbar-t')).toContainText('Trends');
  });

  test('streak counter is visible', async ({ page }) => {
    await expect(page.locator('.stat-big').first()).toBeVisible();
    const streakText = await page.locator('.stat-big').first().textContent();
    // Should be a number ≥ 1
    const streak = parseInt(streakText ?? '0', 10);
    expect(streak).toBeGreaterThanOrEqual(1);
  });

  test('streak label shows 🔥', async ({ page }) => {
    await expect(page.locator('.stat-lbl').first()).toContainText('🔥');
  });

  test('dominant emotion is displayed', async ({ page }) => {
    // Second stat card shows today's tone
    const dominantEl = page.locator('.stat-card').nth(1).locator('.stat-big');
    await expect(dominantEl).toBeVisible();
    const dominant = await dominantEl.textContent();
    expect(dominant?.trim().length).toBeGreaterThan(0);
    expect(dominant).not.toBe('—');
  });

  test('emotion bars are rendered', async ({ page }) => {
    const bars = page.locator('.emo-row');
    await expect(bars.first()).toBeVisible();
    const barCount = await bars.count();
    expect(barCount).toBe(6); // joy, sadness, anxiety, anger, calm, excitement
  });

  test('emotion names are correct', async ({ page }) => {
    const expectedEmotions = ['joy', 'sadness', 'anxiety', 'anger', 'calm', 'excitement'];
    const nameEls = page.locator('.emo-name');
    const count = await nameEls.count();
    expect(count).toBe(6);

    for (let i = 0; i < count; i++) {
      const name = await nameEls.nth(i).textContent();
      expect(expectedEmotions).toContain(name?.trim());
    }
  });

  test('emotion bars have percentage labels', async ({ page }) => {
    const pctEls = page.locator('.emo-pct');
    const count  = await pctEls.count();
    expect(count).toBe(6);

    for (let i = 0; i < count; i++) {
      const pct = await pctEls.nth(i).textContent();
      expect(pct).toMatch(/\d+%/);
    }
  });

  test('↻ refresh button reloads trends', async ({ page }) => {
    await page.click('button.ico-btn:has-text("↻")');
    await page.waitForFunction(() => !(window as any).S?.loading, { timeout: 20_000 });

    // Trends should still be present
    const trends = await page.evaluate(() => (window as any).S?.trends?.length ?? 0);
    expect(trends).toBeGreaterThan(0);
  });
});
