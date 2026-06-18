/**
 * src/api/errorMessages.ts
 *
 * Maps backend error codes to human-readable, user-facing messages.
 * No raw error codes or stack traces are ever shown to the user (F1-002).
 *
 * Extend ERROR_MESSAGES as new screens introduce new backend error codes
 * that need a friendlier face — keep the mapping centralized here rather
 * than scattering string literals across components.
 */

import { ApiError } from './client';

const ERROR_MESSAGES: Record<string, string> = {
  EMAIL_ALREADY_EXISTS: 'An account with this email already exists.',
  INVALID_CREDENTIALS:  'Incorrect email or password.',
  VALIDATION_ERROR:     'Please check your information and try again.',
};

const GENERIC_MESSAGE = 'Something went wrong — please try again.';

/**
 * Converts any error thrown by apiFetch() into a safe, human-readable
 * message. Server errors (5xx) and unrecognized codes both fall back to
 * the generic message — never a raw error code.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status >= 500) return GENERIC_MESSAGE;
    return ERROR_MESSAGES[error.code] ?? GENERIC_MESSAGE;
  }
  return GENERIC_MESSAGE;
}
