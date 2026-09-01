import { defineConfig, devices } from '@playwright/test';

/**
 * E2E test suite for Memo AI Companion (memo_app.html).
 *
 * Environment variables:
 *   APP_URL      — Base URL of the frontend. Defaults to production.
 *   BACKEND_URL  — Backend API URL. Defaults to production Railway URL.
 *
 * For onboarding tests, set ONBOARDING_OFFER_MS_OVERRIDE=0 on the
 * Railway backend so the 3-minute sentinel fires immediately.
 */
export default defineConfig({
  testDir:        './tests',
  timeout:        120_000,   // 2 min — memory extraction can take up to 60s
  expect:         { timeout: 30_000 },
  fullyParallel:  false,     // serial — shared backend state
  workers:        1,
  retries:        0,
  reporter:       [['html', { open: 'never' }], ['line']],

  use: {
    baseURL:    process.env.APP_URL ?? 'https://ai-companion-project.niezifan95.workers.dev',
    screenshot: 'only-on-failure',
    video:      'retain-on-failure',
    trace:      'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use:  { ...devices['Desktop Chrome'] },
    },
  ],
});
