/**
 * src/app.ts
 *
 * Express application factory.
 * Exported separately from src/index.ts so tests can import the app
 * without starting a listening server.
 */

import express           from 'express';
import helmet            from 'helmet';
import cors              from 'cors';
import cookieParser      from 'cookie-parser';
import { healthRouter }        from './routes/health';
import { authRouter }          from './routes/v1/auth.router';
import { usersRouter }         from './routes/v1/users.router';
import { conversationsRouter } from './routes/v1/conversations.router';
import { requestLogger }       from './middleware/requestLogger';
import { errorHandler }        from './middleware/errorHandler';

export const app = express();

// ── Observability — mount FIRST so every request gets a request_id ───────────
app.use(requestLogger);

// ── Security middleware ────────────────────────────────────────────────────────
app.use(helmet());

/**
 * CORS_ORIGIN must be an explicit origin (not "*") because every frontend
 * request is sent with credentials: 'include' (it needs the httpOnly
 * refresh_token cookie). Browsers reject Access-Control-Allow-Origin: "*"
 * combined with credentialed requests, so the default `cors()` config
 * — which uses the wildcard — silently blocks every request from the
 * frontend before it reaches any route handler.
 *
 * Set CORS_ORIGIN in .env to your frontend's dev/staging/prod URL, e.g.
 * CORS_ORIGIN=http://localhost:5173
 */
const corsOrigin = process.env.CORS_ORIGIN;
if (!corsOrigin) {
  // eslint-disable-next-line no-console
  console.warn(
    'CORS_ORIGIN is not set — falling back to http://localhost:5173. ' +
    'Set CORS_ORIGIN in .env for staging/production.',
  );
}

app.use(
  cors({
    origin: corsOrigin ?? 'http://localhost:5173',
    credentials: true,
  }),
);

// ── Body + cookie parsing ─────────────────────────────────────────────────────
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/health',          healthRouter);
app.use('/v1/auth',         authRouter);
app.use('/v1/users',        usersRouter);
app.use('/v1/conversations', conversationsRouter);

// Upcoming routes (uncommented as each task lands):
// app.use('/v1/conversations', conversationsRouter);
// app.use('/v1/memories',      memoriesRouter);

// ── Error handler (must be last) ──────────────────────────────────────────────
app.use(errorHandler);
