# Memo — E2E Test Suite

Playwright E2E tests for `memo_app.html`. Tests run against the live deployed app.

## Setup

```bash
cd e2e
npm install
npx playwright install chromium
```

## Running tests

```bash
# All tests
npm test

# Individual suites
npm run test:auth
npm run test:onboard
npm run test:chat
npm run test:memory
npm run test:trends
npm run test:settings

# View HTML report after run
npm run report
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `APP_URL` | `https://ai-companion-project.niezifan95.workers.dev` | Frontend URL |
| `BACKEND_URL` | Railway production URL | Backend URL (used by helpers) |

## ⚠️ Onboarding tests — backend env var required

`onboarding.spec.ts` requires the 3-minute sentinel to fire immediately:

1. Go to **Railway → your backend service → Variables**
2. Add: `ONBOARDING_OFFER_MS_OVERRIDE=0`
3. Wait for Railway to redeploy (~1 min)
4. Run: `npm run test:onboard`
5. After tests pass, **remove** the variable and redeploy (so production keeps the 3-minute timer)

## Test structure

| File | What it tests |
|---|---|
| `auth.spec.ts` | Registration, login errors, logout, screen navigation |
| `onboarding.spec.ts` | Full onboarding flow, sentinel transition, persistence |
| `chat.spec.ts` | SSE streaming, emotion tags, session ending |
| `memory.spec.ts` | Memory extraction, list view, detail view |
| `trends.spec.ts` | Streak counter, emotion bars, refresh |
| `settings.spec.ts` | Profile display, comm_style update, sign-out |

## Notes

- Tests run **serially** (1 worker) — shared backend state
- Memory extraction takes up to 60 seconds — `memory.spec.ts` has a 90-second wait
- Each spec creates its own test user and cleans up via `DELETE /v1/users/me`
- `chat.spec.ts`, `memory.spec.ts`, `trends.spec.ts`, `settings.spec.ts` use `bypassOnboarding()` to skip the 3-minute wait — this manipulates frontend state only and does not set `onboarding_done` in the DB
- Screenshots and videos are saved on failure in `test-results/`
