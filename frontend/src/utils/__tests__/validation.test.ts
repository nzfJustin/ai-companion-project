import { describe, it, expect } from 'vitest';
import { isValidEmail, isValidPassword, isNonEmpty, MIN_PASSWORD_LENGTH } from '../validation';

describe('isValidEmail', () => {
  it.each([
    'alice@example.com',
    'a.b+tag@sub.example.co',
    '  alice@example.com  ', // trims before checking
  ])('accepts %s', (value) => {
    expect(isValidEmail(value)).toBe(true);
  });

  it.each(['', 'not-an-email', 'alice@', '@example.com', 'alice@example', 'alice example.com'])(
    'rejects %s',
    (value) => {
      expect(isValidEmail(value)).toBe(false);
    },
  );
});

describe('isValidPassword', () => {
  it(`accepts a password of exactly ${MIN_PASSWORD_LENGTH} characters`, () => {
    expect(isValidPassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBe(true);
  });

  it('accepts a password longer than the minimum', () => {
    expect(isValidPassword('a'.repeat(MIN_PASSWORD_LENGTH + 5))).toBe(true);
  });

  it('rejects a password shorter than the minimum', () => {
    expect(isValidPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
  });

  it('rejects an empty password', () => {
    expect(isValidPassword('')).toBe(false);
  });
});

describe('isNonEmpty', () => {
  it('accepts a non-empty string', () => {
    expect(isNonEmpty('Alice')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isNonEmpty('')).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    expect(isNonEmpty('   ')).toBe(false);
  });
});
