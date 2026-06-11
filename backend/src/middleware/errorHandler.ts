/**
 * src/middleware/errorHandler.ts
 *
 * Global error handler.  Must be the LAST middleware registered in
 * app.ts (Express identifies it by the 4-argument signature).
 *
 * - AppError  → structured JSON at the intended status code
 * - Any other → 500 with a safe message (no stack traces in production)
 */

import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';

export function errorHandler(
  err:  Error,
  _req: Request,
  res:  Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.code });
    return;
  }

  // Unexpected errors — log the full detail, return a safe message
  console.error('[server] unhandled error:', err);

  res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
}
