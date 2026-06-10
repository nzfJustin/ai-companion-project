/**
 * src/app.ts
 *
 * Express application factory.
 * Exported separately from src/index.ts so that tests can import
 * the app without starting a listening server.
 */

import express        from 'express';
import helmet         from 'helmet';
import cors           from 'cors';
import { healthRouter } from './routes/health';

export const app = express();

// ── Security middleware ────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '256kb' }));

// ── Routes ────────────────────────────────────────────────────────────────────

// Health — intentionally at root (not /v1) so infra probes don't need auth
app.use('/health', healthRouter);

// All versioned API routes mount here (added in later tasks)
// app.use('/v1/auth',          authRouter);
// app.use('/v1/users',         usersRouter);
// app.use('/v1/conversations', conversationsRouter);
