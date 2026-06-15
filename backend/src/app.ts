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
import { healthRouter }  from './routes/health';
import { authRouter }    from './routes/v1/auth.router';
import { usersRouter }   from './routes/v1/users.router';
import { errorHandler }  from './middleware/errorHandler';

export const app = express();

// ── Security middleware ────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());

// ── Body + cookie parsing ─────────────────────────────────────────────────────
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/health',   healthRouter);
app.use('/v1/auth',  authRouter);
app.use('/v1/users', usersRouter);

// Upcoming routes (uncommented as each task lands):
// app.use('/v1/conversations', conversationsRouter);
// app.use('/v1/memories',      memoriesRouter);

// ── Error handler (must be last) ──────────────────────────────────────────────
app.use(errorHandler);
