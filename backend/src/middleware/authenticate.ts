/**
 * src/middleware/authenticate.ts
 *
 * Verifies the `Authorization: Bearer <access_token>` header and attaches
 * `req.userId` for downstream handlers. Apply to every route that requires
 * a logged-in user.
 *
 * Usage:
 *   usersRouter.get('/me', authenticate, handler);
 *
 * Errors:
 *   401 UNAUTHORIZED   — header missing/malformed, or signature invalid
 *   401 TOKEN_EXPIRED  — signature valid but the token has expired
 *                        (client should call POST /v1/auth/refresh)
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { verifyAccessToken } from '../lib/jwt';
import { AppError } from '../lib/errors';

const BEARER_PREFIX = 'Bearer ';

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return next(new AppError(401, 'UNAUTHORIZED'));
  }

  const token = header.slice(BEARER_PREFIX.length).trim();

  if (!token) {
    return next(new AppError(401, 'UNAUTHORIZED'));
  }

  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.sub;
    return next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new AppError(401, 'TOKEN_EXPIRED'));
    }
    // Covers JsonWebTokenError (bad signature, malformed token, etc.)
    return next(new AppError(401, 'UNAUTHORIZED'));
  }
}
