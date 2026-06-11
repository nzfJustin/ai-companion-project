/**
 * src/lib/errors.ts
 *
 * Typed HTTP errors.  Throw an AppError anywhere in a route handler and
 * the global errorHandler middleware will turn it into the right JSON
 * response.
 *
 * Usage:
 *   throw new AppError(409, 'EMAIL_ALREADY_EXISTS');
 *   throw new AppError(403, 'MEMORY_ACCESS_DENIED', 'Level 4–5 requires PIN');
 */

export class AppError extends Error {
  constructor(
    /** HTTP status code */
    public readonly statusCode: number,
    /** Machine-readable error code (goes in the JSON response body) */
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}
