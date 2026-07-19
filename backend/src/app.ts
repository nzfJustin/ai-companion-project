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
import { memoriesRouter }      from './routes/v1/memories.router';
import { insightsRouter }      from './routes/v1/insights.router';
import { requestLogger }       from './middleware/requestLogger';
import { errorHandler }        from './middleware/errorHandler';

export const app = express();

// ── Observability — mount FIRST so every request gets a request_id ───────────
app.use(requestLogger);

// ── Security middleware ────────────────────────────────────────────────────────
app.use(helmet());

/**
 * CORS — reads from CORS_ALLOWED_ORIGINS (comma-separated list of allowed
 * origins). Every frontend request is credentialed (refresh_token cookie),
 * so Access-Control-Allow-Origin must name the exact origin, never "*".
 *
 * Allowed headers include X-Elevated-Token (memory PIN step-up, F1-009)
 * and Last-Event-ID (SSE reconnect, F1-006).
 *
 * Production example:
 *   CORS_ALLOWED_ORIGINS=https://your-app.pages.dev,https://your-app.com
 */
const ALLOWED_ORIGINS: string[] = (
  process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:5173'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser requests (curl, Postman, health checks)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} is not allowed`));
      }
    },
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Elevated-Token',   // memory PIN step-up (F1-009)
      'Last-Event-ID',      // SSE reconnect (F1-006)
      'X-Admin-Key',        // internal quality endpoints (T-013)
    ],
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
app.use('/v1/memories',      memoriesRouter);
app.use('/v1/insights',      insightsRouter);

// ── Error handler (must be last) ──────────────────────────────────────────────
app.use(errorHandler);
