/**
 * tests/memory.spec.ts
 *
 * Tests memory extraction, list view, and detail view.
 * Memory extraction is async and can take up to 60 seconds —
 * the waitForMemory helper polls until a card appears.
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
  waitForMemory,
} from '../helpers/app';

let sharedUser: { displayName: string; email: string; password: string };

test.beforeAll(async ({ browser }) => {
  // Set up a user, send messages, and close a conversation so
  // memory extraction runs before the tests check for results.
  sharedUser = makeUser('mem');
  const page = await browser.newPage();

  await register(page, sharedUser);
  await bypassOnboarding(page);
  await waitForScreen(page, 'main');

  // Send enough messages to produce a meaningful memory
  await sendMessage(page, "I've been working on a stressful project launch.");
  await sendMessage(page, 'I feel anxious but also excited about the outcome.');
  await sendMessage(page, 'I talked it through with a friend and felt better.');

  // Close conversation → triggers extraction job
  await closeConversation(page);

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
});

test.describe('Memory list', () => {
  test('memory card appears after conversation is closed', async ({ page }) => {
    await waitForMemory(page, 90_000);

    const cards = page.locator('.mem-card');
    await expect(cards.first()).toBeVisible();
  });

  test('memory card shows title', async ({ page }) => {
    await waitForMemory(page);
    await expect(page.locator('.mem-title').first()).not.toBeEmpty();
  });

  test('memory card shows date', async ({ page }) => {
    await waitForMemory(page);
    await expect(page.locator('.mem-date').first()).not.toBeEmpty();
  });

  test('memory card shows emotion badge', async ({ page }) => {
    await waitForMemory(page);
    await expect(page.locator('.emo-badge').first()).toBeVisible();
    const emotion = await page.locator('.emo-badge').first().textContent();
    expect(emotion?.trim().length).toBeGreaterThan(0);
  });

  test('memory card shows level badge', async ({ page }) => {
    await waitForMemory(page);
    await expect(page.locator('.lv-badge').first()).toBeVisible();
    const level = await page.locator('.lv-badge').first().textContent();
    expect(level).toMatch(/L[1-5]/);
  });

  test('↻ refresh button reloads memories', async ({ page }) => {
    // Navigate to memories tab
    await page.evaluate(() => {
      (window as any).S.nav = 'memories';
      (window as any).render();
    });
    await page.waitForSelector('.topbar-t:has-text("Memories")');

    // Click refresh
    await page.click('button.ico-btn:has-text("↻")');
    await page.waitForFunction(() => !(window as any).S?.loading, { timeout: 15_000 });

    // Should still show memories
    const count = await page.evaluate(() => (window as any).S?.memories?.length ?? 0);
    expect(count).toBeGreaterThan(0);
  });
});

test.describe('Memory detail', () => {
  test('clicking memory card opens detail view', async ({ page }) => {
    await waitForMemory(page);
    await page.locator('.mem-card').first().click();
    await page.waitForFunction(() => (window as any).S?.screen === 'mem_detail', { timeout: 15_000 });

    await expect(page.locator('.topbar-t')).toContainText('Memory');
  });

  test('detail view shows summary', async ({ page }) => {
    await waitForMemory(page);
    await page.locator('.mem-card').first().click();
    await page.waitForFunction(() => (window as any).S?.screen === 'mem_detail', { timeout: 15_000 });

    await expect(page.locator('.sec-label:has-text("Summary")')).toBeVisible();
    await expect(page.locator('.detail-body')).not.toBeEmpty();
  });

  test('detail view shows key moments', async ({ page }) => {
    await waitForMemory(page);
    await page.locator('.mem-card').first().click();
    await page.waitForFunction(() => (window as any).S?.screen === 'mem_detail', { timeout: 15_000 });

    await expect(page.locator('.sec-label:has-text("Key moments")')).toBeVisible();
    const keyEvents = await page.locator('.ke').count();
    expect(keyEvents).toBeGreaterThan(0);
  });

  test('detail view shows emotional themes', async ({ page }) => {
    await waitForMemory(page);
    await page.locator('.mem-card').first().click();
    await page.waitForFunction(() => (window as any).S?.screen === 'mem_detail', { timeout: 15_000 });

    // Either emotional themes or dominant emotion should be visible
    const hasThemes = await page.locator('.sec-label:has-text("Emotional themes")').isVisible();
    const hasDominant = await page.locator('.sec-label:has-text("Dominant emotion")').isVisible();
    expect(hasThemes || hasDominant).toBe(true);
  });

  test('← Back returns to memory list', async ({ page }) => {
    await waitForMemory(page);
    await page.locator('.mem-card').first().click();
    await page.waitForFunction(() => (window as any).S?.screen === 'mem_detail', { timeout: 15_000 });

    await page.click('button:has-text("Back")');
    await page.waitForFunction(() => (window as any).S?.screen === 'main' && (window as any).S?.nav === 'memories', { timeout: 10_000 });
    await expect(page.locator('.topbar-t')).toContainText('Memories');
  });
});
