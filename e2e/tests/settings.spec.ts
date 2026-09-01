/**
 * tests/settings.spec.ts
 *
 * Tests the Settings tab: profile display, comm_style update,
 * backend URL display, and sign-out.
 */

import { test, expect } from '@playwright/test';
import {
  makeUser,
  register,
  login,
  logout,
  deleteCurrentUser,
  bypassOnboarding,
  waitForScreen,
} from '../helpers/app';

let sharedUser: { displayName: string; email: string; password: string };

test.beforeAll(async ({ browser }) => {
  sharedUser = makeUser('settings');
  const page = await browser.newPage();
  await register(page, sharedUser);
  await bypassOnboarding(page);
  await waitForScreen(page, 'main');
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  // bypassOnboarding() (used to set up sharedUser) only touches frontend
  // state — it never sets onboarding_done in the DB — so this fresh login
  // correctly re-lands on 'onboarding', not 'main'. deleteCurrentUser()
  // only needs S.token, which login() has already set regardless of
  // which screen it settled on, so there's nothing to wait for here.
  await login(page, sharedUser);
  await deleteCurrentUser(page);
  await page.close();
});

test.beforeEach(async ({ page }) => {
  await login(page, sharedUser);
  const screen = await page.evaluate(() => (window as any).S?.screen);
  if (screen === 'onboarding') await bypassOnboarding(page);
  await waitForScreen(page, 'main');

  // Navigate to Settings tab
  await page.evaluate(() => {
    (window as any).S.nav = 'settings';
    (window as any).render();
  });
  await page.waitForSelector('.settings-wrap', { timeout: 10_000 });
});

test.describe('Settings tab', () => {
  test('Settings tab is accessible from bottom nav', async ({ page }) => {
    await page.goto('/');
    await login(page, sharedUser);
    const screen = await page.evaluate(() => (window as any).S?.screen);
    if (screen === 'onboarding') await bypassOnboarding(page);
    await waitForScreen(page, 'main');

    await page.click('.bnav-btn:has-text("Settings")');
    await page.waitForFunction(() => (window as any).S?.nav === 'settings', { timeout: 10_000 });
    await expect(page.locator('.topbar-t')).toContainText('Settings');
  });

  test('profile card shows correct display name', async ({ page }) => {
    await expect(page.locator('.avatar')).toBeVisible();
    // The display name should appear in the profile card
    const profileText = await page.locator('.card').first().textContent();
    expect(profileText).toContain(sharedUser.displayName);
  });

  test('profile card shows correct email', async ({ page }) => {
    const profileText = await page.locator('.card').first().textContent();
    expect(profileText).toContain(sharedUser.email);
  });

  test('avatar shows first letter of display name', async ({ page }) => {
    const avatarText = await page.locator('.avatar').textContent();
    const firstLetter = sharedUser.displayName[0].toUpperCase();
    expect(avatarText?.trim()).toBe(firstLetter);
  });

  test('Communication style dropdown is visible', async ({ page }) => {
    await expect(page.locator('select.inline')).toBeVisible();
  });

  test('comm_style dropdown has valid options', async ({ page }) => {
    const options = await page.locator('select.inline option').allTextContents();
    expect(options).toContain('Warm');
    expect(options).toContain('Direct');
    expect(options).toContain('Reflective');
  });

  test('changing comm_style saves successfully', async ({ page }) => {
    const select = page.locator('select.inline');
    const current = await select.inputValue();

    // Switch to a different style
    const next = current === 'warm' ? 'direct' : 'warm';
    await select.selectOption(next);

    // Wait for API call to complete
    await page.waitForFunction(
      (expected: string) => (window as any).S?.user?.comm_style === expected,
      next,
      { timeout: 15_000 },
    );

    // Verify the backend updated
    const userState = await page.evaluate(() => (window as any).S?.user);
    expect(userState?.comm_style).toBe(next);
  });

  test('Toast appears after saving comm_style', async ({ page }) => {
    const select = page.locator('select.inline');
    const current = await select.inputValue();
    const next = current === 'reflective' ? 'warm' : 'reflective';
    await select.selectOption(next);

    await expect(page.locator('.toast')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.toast')).toContainText('Saved');
  });

  test('backend URL is displayed in settings', async ({ page }) => {
    const backendUrlEl = page.locator('.srow-val').filter({ hasText: 'railway.app' });
    await expect(backendUrlEl).toBeVisible();
  });

  test('Sign out button is visible', async ({ page }) => {
    await expect(page.locator('.srow.danger')).toBeVisible();
    await expect(page.locator('.srow.danger .srow-lbl')).toContainText('Sign out');
  });

  test('Sign out → redirects to login screen', async ({ page }) => {
    await page.click('.srow.danger');
    await waitForScreen(page, 'login');
    await expect(page.locator('button.btn-p')).toContainText('Sign in');
  });
});
