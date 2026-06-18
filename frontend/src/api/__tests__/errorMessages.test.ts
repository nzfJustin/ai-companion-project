import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '../errorMessages';
import { ApiError } from '../client';

describe('getErrorMessage', () => {
  it('maps EMAIL_ALREADY_EXISTS to a human-readable message', () => {
    expect(getErrorMessage(new ApiError(409, 'EMAIL_ALREADY_EXISTS'))).toBe(
      'An account with this email already exists.',
    );
  });

  it('maps INVALID_CREDENTIALS to a human-readable message', () => {
    expect(getErrorMessage(new ApiError(401, 'INVALID_CREDENTIALS'))).toBe(
      'Incorrect email or password.',
    );
  });

  it('maps VALIDATION_ERROR to a human-readable message', () => {
    expect(getErrorMessage(new ApiError(400, 'VALIDATION_ERROR'))).toBe(
      'Please check your information and try again.',
    );
  });

  it('maps any 5xx status to the generic message regardless of code', () => {
    expect(getErrorMessage(new ApiError(500, 'INTERNAL_SERVER_ERROR'))).toBe(
      'Something went wrong — please try again.',
    );
    expect(getErrorMessage(new ApiError(503, 'SOME_OTHER_CODE'))).toBe(
      'Something went wrong — please try again.',
    );
  });

  it('maps an unrecognized 4xx code to the generic message', () => {
    expect(getErrorMessage(new ApiError(418, 'UNKNOWN_CODE'))).toBe(
      'Something went wrong — please try again.',
    );
  });

  it('maps a non-ApiError value to the generic message', () => {
    expect(getErrorMessage(new Error('network failure'))).toBe(
      'Something went wrong — please try again.',
    );
    expect(getErrorMessage('a plain string')).toBe('Something went wrong — please try again.');
    expect(getErrorMessage(null)).toBe('Something went wrong — please try again.');
  });

  it('never returns the raw error code', () => {
    const message = getErrorMessage(new ApiError(409, 'EMAIL_ALREADY_EXISTS'));
    expect(message).not.toContain('EMAIL_ALREADY_EXISTS');
  });
});
