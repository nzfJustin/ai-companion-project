/**
 * src/middleware/errorHandler.ts
 *
 * Global error handler. Must be the LAST middleware registered in app.ts.
 *
 * Every error response includes `meta.request_id` (set by requestLogger)
 * so a user-reported error code can be correlated to a specific log line
 * without exposing any PII (TDD P1-022).
 *
 *   AppError  → structured JSON at the intended status code
 *   Any other → 500 INTERNAL_SERVER_ERROR (stack traces never sent to client)
 */

import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';
import { logError } from '../lib/logger';

export function errorHandler(
  err:  Error,
  req:  Request,
  res:  Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const meta = { request_id: req.requestId ?? null };

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.code, meta });
    return;
  }

  // Unexpected errors — log with request_id for correlation, return safe message
  logError({
    event:      'unhandled_error',
    request_id: req.requestId ?? 'unknown',
    message:    err.message,
    stack:      err.stack,
  });

  res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', meta });
}
