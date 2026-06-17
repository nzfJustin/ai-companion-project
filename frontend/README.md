# AI Companion — Frontend

React 18 + TypeScript frontend for the AI Companion for Memory & Mental Wellness product. This README covers Phase 1 setup only — see `frontendtasks.pdf` (Reference: Technical Design Document v0.1, Backend Task Breakdown v1.0) for the full task list.

## Tech stack

- **Vite + React 18 + TypeScript** — build tooling and framework
- **React Router v6** — client-side routing
- **TanStack Query (React Query)** — server state, caching, background refetching
- **Zustand** — lightweight client state (auth token, active conversation)
- **Tailwind CSS** — utility-first styling
- **Recharts** — emotion trend chart (F1-010)

All dependencies are free and open source. No additional service subscriptions required.

## Running locally

```bash
npm install
cp .env.local.example .env.local   # then edit .env.local — see below
npm run dev                         # starts on http://localhost:5173
```

Other scripts:

```bash
npm run build       # type-checks (tsc -b) then builds for production
npm run preview     # preview the production build locally
npm run typecheck   # tsc -b --noEmit — run in CI
npm run lint         # eslint
npm run test         # vitest run — unit tests, no real network calls
```

## Required environment variables

Copy `.env.local.example` to `.env.local` and set:

| Variable | Description |
|---|---|
| `VITE_API_BASE_URL` | Base URL of the backend API, no trailing slash. |

`.env.local` is gitignored — never commit real values. There is no `.env` checked into the repo; every developer and CI environment sets these independently.

## Pointing the app at a different backend

**Local backend** (default — matches the backend repo's `docker-compose.yml` + `npm run dev` on port 3000):
```
VITE_API_BASE_URL=http://localhost:3000
```

**Staging:**
```
VITE_API_BASE_URL=https://staging-api.yourdomain.com
```

Vite only reads `VITE_*` env vars at build/dev-server start time — restart `npm run dev` after changing `.env.local`.

There are no hardcoded API URLs anywhere in `src/`. If you ever see `localhost` or a production URL hardcoded in a source file outside `.env.local.example`, that's a bug — all requests must go through `src/api/client.ts`, which reads `VITE_API_BASE_URL` from `src/api/config.ts`.

## Project structure

```
src/
├── api/
│   ├── config.ts        # reads VITE_API_BASE_URL
│   └── client.ts         # apiFetch() — auth injection, silent refresh, retry-once
├── store/
│   └── authStore.ts      # Zustand store — access token (in-memory only)
├── screens/
│   └── PlaceholderScreen.tsx
├── router.tsx             # route table — placeholder routes for every Phase 1 screen
├── main.tsx                # entry point — QueryClientProvider + RouterProvider
├── index.css               # Tailwind directives
└── vite-env.d.ts
```

## Authentication model (read before touching `src/api/`)

- The **access token** lives only in the Zustand store (`src/store/authStore.ts`), in memory. It is never written to `localStorage` or `sessionStorage`. It is lost on every page refresh, by design.
- The **refresh token** is an httpOnly cookie set by the backend. The frontend never reads or writes it directly — it's sent automatically by the browser on any request with `credentials: 'include'`.
- `apiFetch()` (in `src/api/client.ts`) automatically retries a request once after a silent refresh if it receives a `401`. If the refresh also fails, it clears the auth store and redirects to `/login`.
- Concurrent requests that all 401 at once share a single in-flight refresh call — see the comment block at the top of `client.ts` for why this matters (the backend's refresh token is one-time-use, so naively calling refresh from multiple places at once causes spurious logouts).

## Routes (placeholder for now — filled in by later tasks)

| Path | Task |
|---|---|
| `/login`, `/register` | F1-002 |
| `/onboarding` | F1-004 |
| `/chat`, `/chat/:conversationId` | F1-005, F1-006, F1-007 |
| `/memories`, `/memories/:id` | F1-008, F1-009 |
| `/trends` | F1-010 |
| `/settings` | F1-011 |

## Definition of Done (applies to every frontend task)

- All screens are responsive and usable on both desktop and mobile viewports
- No TypeScript errors (`strict` mode enabled)
- No accessibility violations on interactive elements (buttons have labels, inputs have associated labels, focus is managed on modal open/close)
- The feature works against the real staging API, not just mocked data
