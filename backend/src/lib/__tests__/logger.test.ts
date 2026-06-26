/**
 * src/lib/__tests__/logger.test.ts
 *
 * Covers redactPII() and the log/warn/logError emitters.
 * The TDD-required test (P1-022 criterion 4) is the first describe block:
 *   "A unit test constructs a log event containing an email field and a
 *    content field and verifies the emitted log object contains [REDACTED]
 *    for both."
 */

import { redactPII, log, warn, logError } from '../logger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Spy on console.log and return the parsed JSON from its last call. */
function captureLog(fn: () => void): Record<string, unknown> {
  const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
  fn();
  const raw = spy.mock.calls[0]?.[0] as string;
  spy.mockRestore();
  return JSON.parse(raw);
}

function captureWarn(fn: () => void): Record<string, unknown> {
  const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  fn();
  const raw = spy.mock.calls[0]?.[0] as string;
  spy.mockRestore();
  return JSON.parse(raw);
}

function captureError(fn: () => void): Record<string, unknown> {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  fn();
  const raw = spy.mock.calls[0]?.[0] as string;
  spy.mockRestore();
  return JSON.parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// TDD P1-022 REQUIRED TEST
// "A unit test constructs a log event containing an email field and a
//  content field and verifies the emitted log object contains [REDACTED]
//  for both."
// ─────────────────────────────────────────────────────────────────────────────

describe('P1-022 required test — email and content are both redacted', () => {
  it('emitted log contains [REDACTED] for email field', () => {
    const output = captureLog(() =>
      log({
        event:   'test_event',
        email:   'alice@example.com',
        content: 'My message about anxiety today',
      }),
    );
    expect(output.email).toBe('[REDACTED]');
  });

  it('emitted log contains [REDACTED] for content field', () => {
    const output = captureLog(() =>
      log({
        event:   'test_event',
        email:   'alice@example.com',
        content: 'My message about anxiety today',
      }),
    );
    expect(output.content).toBe('[REDACTED]');
  });

  it('the original PII values do NOT appear anywhere in the emitted JSON string', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    log({
      event:   'test_event',
      email:   'alice@example.com',
      content: 'sensitive message content',
    });
    const raw = spy.mock.calls[0]?.[0] as string;
    spy.mockRestore();

    expect(raw).not.toContain('alice@example.com');
    expect(raw).not.toContain('sensitive message content');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// redactPII — comprehensive field coverage
// ─────────────────────────────────────────────────────────────────────────────

describe('redactPII — PII field redaction', () => {
  it('redacts all six PII fields', () => {
    const result = redactPII({
      email:         'user@example.com',
      password:      'secret123',
      password_hash: '$2b$12$...',
      pin:           '1234',
      content:       'This is a message',
      token:         'eyJ...',
    });

    expect(result.email).toBe('[REDACTED]');
    expect(result.password).toBe('[REDACTED]');
    expect(result.password_hash).toBe('[REDACTED]');
    expect(result.pin).toBe('[REDACTED]');
    expect(result.content).toBe('[REDACTED]');
    expect(result.token).toBe('[REDACTED]');
  });

  it('preserves non-PII fields unchanged', () => {
    const result = redactPII({
      event:      'user_login',
      user_id:    'abc-123',
      success:    true,
      duration_ms: 42,
    });

    expect(result.event).toBe('user_login');
    expect(result.user_id).toBe('abc-123');
    expect(result.success).toBe(true);
    expect(result.duration_ms).toBe(42);
  });

  it('redacts PII fields nested inside a child object', () => {
    const result = redactPII({
      event: 'nested_test',
      user: {
        email: 'alice@example.com',
        name:  'Alice',
      },
    });

    const user = result.user as Record<string, unknown>;
    expect(user.email).toBe('[REDACTED]');
    expect(user.name).toBe('Alice');
  });

  it('redacts PII fields in deeply nested objects', () => {
    const result = redactPII({
      event: 'deep_test',
      level1: {
        level2: {
          level3: {
            password: 'deep-secret',
            safe:     'visible',
          },
        },
      },
    });

    const l3 = (result.level1 as Record<string, unknown>).level2 as Record<string, unknown>;
    const inner = (l3.level3 as Record<string, unknown>);
    expect(inner.password).toBe('[REDACTED]');
    expect(inner.safe).toBe('visible');
  });

  it('redacts PII fields in objects that appear inside arrays', () => {
    const result = redactPII({
      event: 'array_test',
      users: [
        { email: 'a@example.com', name: 'Alice' },
        { email: 'b@example.com', name: 'Bob' },
      ],
    });

    const users = result.users as Array<Record<string, unknown>>;
    expect(users[0].email).toBe('[REDACTED]');
    expect(users[0].name).toBe('Alice');
    expect(users[1].email).toBe('[REDACTED]');
  });

  it('does not mutate the input object', () => {
    const input = { email: 'test@example.com', event: 'test' };
    redactPII(input);
    expect(input.email).toBe('test@example.com');
  });

  it('passes through null and undefined values without throwing', () => {
    const result = redactPII({ event: 'nulls', a: null, b: undefined });
    expect(result.a).toBeNull();
    expect(result.b).toBeUndefined();
  });

  it('passes through numbers and booleans without treating them as objects', () => {
    const result = redactPII({ event: 'primitives', count: 5, flag: true });
    expect(result.count).toBe(5);
    expect(result.flag).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Emitter functions
// ─────────────────────────────────────────────────────────────────────────────

describe('log() emitter', () => {
  it('emits to console.log as a single-line JSON string', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    log({ event: 'test' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(spy.mock.calls[0][0])).not.toThrow();
    spy.mockRestore();
  });

  it('always includes a timestamp field', () => {
    const out = captureLog(() => log({ event: 'test' }));
    expect(out.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes all provided non-PII fields in the output', () => {
    const out = captureLog(() =>
      log({ event: 'http_request', user_id: 'u-1', http_status: 200 }),
    );
    expect(out.event).toBe('http_request');
    expect(out.user_id).toBe('u-1');
    expect(out.http_status).toBe(200);
  });

  it('redacts PII fields before emitting', () => {
    const out = captureLog(() =>
      log({ event: 'login', email: 'alice@example.com' }),
    );
    expect(out.email).toBe('[REDACTED]');
  });
});

describe('warn() emitter', () => {
  it('emits to console.warn', () => {
    const out = captureWarn(() => warn({ event: 'rate_limit_redis_miss', user_id: 'u-1' }));
    expect(out.event).toBe('rate_limit_redis_miss');
  });

  it('redacts PII fields', () => {
    const out = captureWarn(() => warn({ event: 'test', token: 'abc' }));
    expect(out.token).toBe('[REDACTED]');
  });
});

describe('logError() emitter', () => {
  it('emits to console.error', () => {
    const out = captureError(() => logError({ event: 'unhandled_error', message: 'boom' }));
    expect(out.event).toBe('unhandled_error');
  });

  it('redacts PII fields', () => {
    const out = captureError(() =>
      logError({ event: 'error', password: 'oops-in-error' }),
    );
    expect(out.password).toBe('[REDACTED]');
  });
});
