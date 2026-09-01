/**
 * tests/auth.spec.ts
 *
 * Tests: registration, login, logout, error states.
 * Each test creates its own isolated user and cleans up after itself.
 */

import { test, expect } from '@playwright/test';
import {
  makeUser,
  register,
  login,
  logout,
  deleteCurrentUser,
  waitForScreen,
  bypassOnboarding,
} from '../helpers/app';

test.describe('Registration', () => {
  test('new user → lands on onboarding screen', async ({ page }) => {
    const user = makeUser('reg');
    await register(page, user);
    await waitForScreen(page, 'onboarding');

    await expect(page.locator('.topbar-t')).toContainText('Getting to know you');
    await expect(page.locator('.topbar-s')).toContainText('personalises');

    await deleteCurrentUser(page);
  });

  test('duplicate email → shows EMAIL_ALREADY_EXISTS error', async ({ page }) => {
    const user = makeUser('dup');

    // Register once
    await register(page, user);
    await waitForScreen(page, 'onboarding');

    // go('login') only changes S.screen for the UI — it does NOT log the
    // user out (no token/localStorage change), so the just-registered
    // session stays valid underneath. That's fine here: registering again
    // with the same email doesn't require actually being logged out.
    await page.evaluate(() => (window as any).go('login'));
    await page.click('button:has-text("Create account")');
    await waitForScreen(page, 'register');
    await page.fill('#rn', user.displayName);
    await page.fill('#re', user.email);
    await page.fill('#rp', user.password);
    await page.click('button.btn-p:has-text("Create account")');

    await expect(page.locator('.err')).toBeVisible();
    await expect(page.locator('.err')).toContainText('already registered');

    // Clean up. The original registration's token is still valid (never
    // actually logged out above), so no need to log back in — doing so via
    // login()'s page.goto('/') would just have boot() auto-authenticate
    // past the login screen anyway, hanging waitForScreen(page, 'login')
    // forever.
    await deleteCurrentUser(page);
  });

  test('short password → shows validation error', async ({ page }) => {
    await page.goto('/');
    await waitForScreen(page, 'login');
    await page.click('button:has-text("Create account")');
    await waitForScreen(page, 'register');

    await page.fill('#rn', 'Test User');
    await page.fill('#re', 'test@test.invalid');
    await page.fill('#rp', 'short');
    await page.click('button.btn-p:has-text("Create account")');

    await expect(page.locator('.err')).toBeVisible();
    await expect(page.locator('.err')).toContainText('8 characters');
  });

  test('empty fields → shows validation error', async ({ page }) => {
    await page.goto('/');
    await waitForScreen(page, 'login');
    await page.click('button:has-text("Create account")');
    await waitForScreen(page, 'register');
    await page.click('button.btn-p:has-text("Create account")');

    await expect(page.locator('.err')).toBeVisible();
    await expect(page.locator('.err')).toContainText('Fill in all fields');
  });
});

test.describe('Login', () => {
  test('wrong password → shows error', async ({ page }) => {
    await page.goto('/');
    await waitForScreen(page, 'login');
    await page.fill('#le', 'nobody@test.invalid');
    await page.fill('#lp', 'wrongpassword');
    await page.click('button.btn-p:has-text("Sign in")');

    await expect(page.locator('.err')).toBeVisible();
  });

  test('empty fields → shows validation error', async ({ page }) => {
    await page.goto('/');
    await waitForScreen(page, 'login');
    await page.click('button.btn-p:has-text("Sign in")');

    await expect(page.locator('.err')).toContainText('email and password');
  });

  test('existing user with onboarding_done=false → lands on onboarding', async ({ page }) => {
    const user = makeUser('login-ob');
    await register(page, user);
    await waitForScreen(page, 'onboarding');

    // Logout and log back in
    await page.evaluate(() => (window as any).doLogout());
    await waitForScreen(page, 'login');
    await login(page, user);
    await waitForScreen(page, 'onboarding');

    await expect(page.locator('.topbar-t')).toContainText('Getting to know you');
    await deleteCurrentUser(page);
  });

  test('Enter key submits login form', async ({ page }) => {
    await page.goto('/');
    await waitForScreen(page, 'login');
    await page.fill('#le', 'nobody@test.invalid');
    await page.fill('#lp', 'wrongpassword');
    await page.keyboard.press('Enter');

    // Should attempt login and show error (not just do nothing)
    await expect(page.locator('.err')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Logout', () => {
  test('logout → redirects to login screen', async ({ page }) => {
    const user = makeUser('logout');
    await register(page, user);
    await bypassOnboarding(page);
    await waitForScreen(page, 'main');

    await logout(page);
    await waitForScreen(page, 'login');

    await expect(page.locator('button.btn-p')).toContainText('Sign in');
    await expect(page.locator('button.btn-g')).toContainText('Create account');

    // Login again to clean up
    await login(page, user);
    await deleteCurrentUser(page);
  });

  test('after logout, protected routes redirect to login', async ({ page }) => {
    const user = makeUser('protected');
    await register(page, user);
    await bypassOnboarding(page);
    await logout(page);

    // Try to access app directly — should stay on login
    await page.goto('/');
    await waitForScreen(page, 'login');
    await expect(page.locator('.topbar-t')).not.toBeVisible();
  });
});

test.describe('Navigation between auth screens', () => {
  test('can switch between login and register screens', async ({ page }) => {
    await page.goto('/');
    await waitForScreen(page, 'login');

    await page.click('button:has-text("Create account")');
    await waitForScreen(page, 'register');

    await page.click('button:has-text("Already have an account")');
    await waitForScreen(page, 'login');

    await expect(page.locator('button.btn-p')).toContainText('Sign in');
  });

  test('Change backend URL link is visible on login screen', async ({ page }) => {
    await page.goto('/');
    await waitForScreen(page, 'login');
    await expect(page.locator('button.lnk:has-text("Change backend URL")')).toBeVisible();
  });
});
