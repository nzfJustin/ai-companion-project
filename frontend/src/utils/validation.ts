/**
 * src/utils/validation.ts
 *
 * Lightweight client-side validators for the auth forms (F1-002).
 * These exist purely for fast UX feedback — the backend re-validates
 * everything server-side and remains the source of truth.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export const MIN_PASSWORD_LENGTH = 8;

export function isValidPassword(value: string): boolean {
  return value.length >= MIN_PASSWORD_LENGTH;
}

export function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}
