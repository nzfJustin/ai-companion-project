/**
 * src/middleware/validate.ts
 *
 * Wraps a Zod schema into Express middleware. Validates req.body and
 * replaces it with the parsed (coerced + stripped) output so route
 * handlers can trust the types completely.
 *
 * Every 400 response includes `meta.request_id` so the error can be
 * correlated to a log line (TDD P1-022).
 *
 * Usage:
 *   router.post('/register', validate(RegisterSchema), handler);
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

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
        meta: { request_id: req.requestId ?? null },
      });
      return;
    }

    req.body = result.data;
    next();
  };
}

// ─── Shared field schemas ─────────────────────────────────────────────────────
// Reuse these in route-level Zod schemas to keep validation consistent.

/**
 * Validates display_name and rejects strings that contain:
 *   - HTML/script tags (any `<` character)
 *   - Null bytes (`\x00`) — prevents null-byte injection
 *   - Semicolons — primary SQL statement terminator
 *
 * These three patterns cover the XSS, null-byte, and SQL injection
 * vectors called out in TDD P1-021. Note that single-quotes are NOT
 * rejected because they appear in legitimate names (O'Brien).
 *
 * A separate prompt-injection guard (sanitizeForPrompt in P1-12) further
 * strips special characters before any user-controlled string reaches an
 * LLM prompt template.
 */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, { message: 'display_name must not be empty' })
  .max(100, { message: 'display_name must be 100 characters or fewer' })
  .refine(
    (s) => !/</.test(s) && !s.includes('\x00') && !s.includes(';'),
    {
      message:
        'display_name contains invalid characters ' +
        '(angle brackets, semicolons, and null bytes are not allowed)',
    },
  );
