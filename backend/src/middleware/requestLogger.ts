/**
 * src/middleware/requestLogger.ts
 *
 * Generates a fresh `request_id` (UUID v4) for every inbound request,
 * attaches it to `req.requestId`, and emits a structured log line once the
 * response has finished.
 *
 * Mount this FIRST in app.ts (before routes) so every handler has access
 * to `req.requestId` for correlation — including the error handler which
 * echoes it back in `meta.request_id`.
 *
 * Log shape (TDD §12.1 / P1-022):
 * {
 *   timestamp:   ISO-8601 string
 *   event:       "http_request"
 *   request_id:  UUID
 *   user_id:     string | null
 *   module:      "http"
 *   http_method: "GET" | "POST" | …
 *   http_path:   "/v1/users/me"
 *   http_status: 200
 *   duration_ms: 42
 *   success:     true | false
 * }
 */

import { randomUUID }      from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { log } from '../lib/logger';

export function requestLogger(
  req:  Request,
  res:  Response,
  next: NextFunction,
): void {
  const requestId = randomUUID();
  req.requestId   = requestId;

  const startedAt = Date.now();

  res.on('finish', () => {
    log({
      event:       'http_request',
      request_id:  requestId,
      user_id:     req.userId ?? null,
      module:      'http',
      http_method: req.method,
      http_path:   req.path,
      http_status: res.statusCode,
      duration_ms: Date.now() - startedAt,
      success:     res.statusCode < 400,
    });
  });

  next();
}
