/**
 * src/middleware/validate.ts
 *
 * Wraps a Zod schema into Express middleware.  Validates req.body and
 * replaces it with the parsed (coerced + stripped) output so route
 * handlers can trust the types completely.
 *
 * On failure it short-circuits with a 400 before the handler runs.
 *
 * Usage:
 *   router.post('/register', validate(RegisterSchema), handler);
 */

import type { Request, Response, NextFunction } from 'express';
import type { z }                                from 'zod';

export function validate<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        error:  'VALIDATION_ERROR',
        errors: result.error.errors.map((e) => ({
          field:   e.path.join('.') || 'body',
          message: e.message,
        })),
      });
      return;
    }

    // Replace body with the parsed output (types are now trustworthy)
    req.body = result.data;
    next();
  };
}
