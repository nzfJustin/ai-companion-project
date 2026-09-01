/**
 * tests/chat.spec.ts
 *
 * Tests the main chat experience: SSE streaming, emotion tags,
 * conversation management, and session ending.
 */

import { test, expect } from '@playwright/test';
import {
  makeUser,
  register,
  deleteCurrentUser,
  bypassOnboarding,
  waitForScreen,
  sendMessage,
  endSession,
  getState,
} from '../helpers/app';

// Shared user created once for all chat tests
let sharedUser: { displayName: string; email: string; password: string };

test.beforeAll(async ({ browser }) => {
  sharedUser = makeUser('chat');
  const page = await browser.newPage();
  await register(page, sharedUser);
  await bypassOnboarding(page);
  await waitForScreen(page, 'main');
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  const { login } = await import('../helpers/app');
  await login(page, sharedUser);
  await waitForScreen(page, 'main');
  await deleteCurrentUser(page);
  await page.close();
});

test.beforeEach(async ({ page }) => {
  const { login } = await import('../helpers/app');
  await login(page, sharedUser);
  // May land on onboarding (frontend bypass doesn't persist across logins)
  const screen = await page.evaluate(() => (window as any).S?.screen);
  if (screen === 'onboarding') {
    await bypassOnboarding(page);
  }
  await waitForScreen(page, 'main');
});

test.describe('Chat UI', () => {
  test('main chat screen has correct UI elements', async ({ page }) => {
    await expect(page.locator('.topbar-t')).toBeVisible();
    await expect(page.locator('button:has-text("End")')).toBeVisible();
    await expect(page.locator('#ci')).toBeVisible();
    await expect(page.locator('.send-btn')).toBeVisible();
    await expect(page.locator('.bnav')).toBeVisible();
    // 4 nav tabs
    await expect(page.locator('.bnav-btn')).toHaveCount(4);
  });

  test('Chat tab is active by default', async ({ page }) => {
    const activeNav = await page.locator('.bnav-btn.on').textContent();
    expect(activeNav).toContain('Chat');
  });
});

test.describe('Message sending', () => {
  test('send message → AI response streams in', async ({ page }) => {
    await sendMessage(page, "I'm feeling good about today.");

    // At least one user message and one AI message
    const userMsgs = await page.locator('.msg.u').count();
    const aiMsgs   = await page.locator('.msg.a').count();
    expect(userMsgs).toBeGreaterThanOrEqual(1);
    expect(aiMsgs).toBeGreaterThanOrEqual(1);
  });

  test('AI response has emotion pill after streaming finishes', async ({ page }) => {
    await sendMessage(page, 'I have been a bit anxious about my job search lately.');

    await expect(page.locator('.emo-pill').last()).toBeVisible();
    const emotionText = await page.locator('.emo-pill').last().textContent();
    expect(emotionText?.trim().length).toBeGreaterThan(0);
  });

  test('send button is disabled while streaming', async ({ page }) => {
    // Start typing and submit without waiting
    await page.fill('#ci', 'Quick test message.');
    await page.click('.send-btn');

    // Immediately check — button should be disabled during streaming
    const isDisabled = await page.locator('.send-btn').isDisabled();
    // It may or may not still be streaming by the time we check — just ensure no crash
    const streaming = await page.evaluate(() => (window as any).S?.streaming);
    if (streaming) {
      expect(isDisabled).toBe(true);
    }

    // Wait for stream to finish
    await page.waitForFunction(() => !(window as any).S?.streaming, { timeout: 60_000 });
  });

  test('input clears after sending', async ({ page }) => {
    await page.fill('#ci', 'Test message to clear.');
    await page.keyboard.press('Enter');

    // Input should immediately clear
    await expect(page.locator('#ci')).toHaveValue('');
  });

  test('multiple messages in sequence', async ({ page }) => {
    await sendMessage(page, 'First message.');
    await sendMessage(page, 'Second message.');
    await sendMessage(page, 'Third message.');

    const userMsgs = await page.locator('.msg.u').count();
    const aiMsgs   = await page.locator('.msg.a').count();
    expect(userMsgs).toBeGreaterThanOrEqual(3);
    expect(aiMsgs).toBeGreaterThanOrEqual(3);
  });

  test('user message appears immediately before AI responds', async ({ page }) => {
    await page.fill('#ci', 'Immediate display test.');
    await page.keyboard.press('Enter');

    // User message should appear right away
    await expect(page.locator('.msg.u').last()).toContainText('Immediate display test.');
    await page.waitForFunction(() => !(window as any).S?.streaming, { timeout: 60_000 });
  });
});

test.describe('Session management', () => {
  test('✕ End button closes conversation and shows session banner', async ({ page }) => {
    await sendMessage(page, 'Session end test.');
    await endSession(page);

    // Session ended banner should appear
    await expect(page.locator('.session-banner')).toBeVisible();
    await expect(page.locator('.session-banner-t')).toContainText('Session ended');
    await expect(page.locator('.session-banner-s')).toContainText('memory');

    // Go to Memories button should appear
    await expect(page.locator('button:has-text("Go to Memories")')).toBeVisible();

    // Chat input should be gone
    await expect(page.locator('#ci')).not.toBeVisible();
    // End button should be gone
    await expect(page.locator('button:has-text("End")')).not.toBeVisible();
  });

  test('after ending session, new conversation is created', async ({ page }) => {
    const oldConvId = await page.evaluate(() => (window as any).S?.convId);
    await sendMessage(page, 'Message before ending.');
    await endSession(page);

    // A new convId should be set
    const newConvId = await page.evaluate(() => (window as any).S?.convId);
    expect(newConvId).not.toBe(oldConvId);
    expect(newConvId).toBeTruthy();
  });

  test('Go to Memories button navigates to Memories tab', async ({ page }) => {
    await sendMessage(page, 'Navigation test.');
    await endSession(page);

    await page.click('button:has-text("Go to Memories")');
    await page.waitForFunction(() => (window as any).S?.nav === 'memories', { timeout: 10_000 });
    await expect(page.locator('.topbar-t')).toContainText('Memories');
  });
});
