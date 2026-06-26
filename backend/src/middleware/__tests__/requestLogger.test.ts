/**
 * src/middleware/__tests__/requestLogger.test.ts
 */

import type { Request, Response } from 'express';
import { requestLogger } from '../requestLogger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<Request> = {}): Request {
  return { method: 'GET', path: '/v1/users/me', userId: undefined, ...overrides } as Request;
}

function makeRes(): { emitFinish: () => void } & Partial<Response> {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    statusCode: 200,
    on: (event: string, cb: () => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
    },
    emitFinish: () => listeners['finish']?.forEach((cb) => cb()),
  } as unknown as { emitFinish: () => void } & Partial<Response>;
}

beforeEach(() => {
  jest.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('requestLogger', () => {
  it('sets req.requestId to a UUID on each call', () => {
    const req  = makeReq();
    const res  = makeRes();
    const next = jest.fn();

    requestLogger(req, res as unknown as Response, next);

    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('assigns a different request_id to each request', () => {
    const req1 = makeReq();
    const req2 = makeReq();
    const next = jest.fn();

    requestLogger(req1, makeRes() as unknown as Response, next);
    requestLogger(req2, makeRes() as unknown as Response, next);

    expect(req1.requestId).not.toBe(req2.requestId);
  });

  it('calls next() immediately', () => {
    const next = jest.fn();
    requestLogger(makeReq(), makeRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('emits a structured log on response finish with all required fields', () => {
    const spy  = jest.spyOn(console, 'log').mockImplementation(() => {});
    const req  = makeReq({ userId: 'user-1' });
    const res  = makeRes();
    const next = jest.fn();

    requestLogger(req, res as unknown as Response, next);
    (res as { emitFinish: () => void }).emitFinish();

    expect(spy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(spy.mock.calls[0][0]);

    expect(payload.event).toBe('http_request');
    expect(payload.request_id).toBe(req.requestId);
    expect(payload.user_id).toBe('user-1');
    expect(payload.module).toBe('http');
    expect(payload.http_method).toBe('GET');
    expect(payload.http_path).toBe('/v1/users/me');
    expect(payload.http_status).toBe(200);
    expect(typeof payload.duration_ms).toBe('number');
    expect(payload.success).toBe(true);
    expect(payload.timestamp).toMatch(/^\d{4}-/);
  });

  it('sets success=false for 4xx and 5xx responses', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const res = makeRes();
    (res as { statusCode: number }).statusCode = 404;

    requestLogger(makeReq(), res as unknown as Response, jest.fn());
    (res as { emitFinish: () => void }).emitFinish();

    const payload = JSON.parse(spy.mock.calls[0][0]);
    expect(payload.success).toBe(false);
    expect(payload.http_status).toBe(404);
  });

  it('sets user_id=null for unauthenticated requests', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const res = makeRes();

    requestLogger(makeReq({ userId: undefined }), res as unknown as Response, jest.fn());
    (res as { emitFinish: () => void }).emitFinish();

    const payload = JSON.parse(spy.mock.calls[0][0]);
    expect(payload.user_id).toBeNull();
  });

  it('does not log until the response finishes (no premature logs)', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    requestLogger(makeReq(), makeRes() as unknown as Response, jest.fn());
    // finish not emitted yet
    expect(spy).not.toHaveBeenCalled();
  });

  it('duration_ms is a non-negative number', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const res = makeRes();

    requestLogger(makeReq(), res as unknown as Response, jest.fn());
    (res as { emitFinish: () => void }).emitFinish();

    const payload = JSON.parse(spy.mock.calls[0][0]);
    expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// meta.request_id threading (errorHandler + validate integration)
// ─────────────────────────────────────────────────────────────────────────────

describe('request_id threading to error responses', () => {
  it('req.requestId is available immediately after requestLogger runs (before routes)', () => {
    const req  = makeReq();
    const next = jest.fn();

    requestLogger(req, makeRes() as unknown as Response, next);

    // requestId is set synchronously — before next() handler uses it
    expect(req.requestId).toBeDefined();
    // next() was already called — requestId was ready before handler started
    expect(next).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// displayNameSchema — XSS / injection / null-byte rejection
// ─────────────────────────────────────────────────────────────────────────────

// Import from validate.ts (same module where displayNameSchema is exported)
import { displayNameSchema } from '../validate';

describe('displayNameSchema — XSS, SQL injection, and null-byte rejection', () => {
  it('accepts a normal display name', () => {
    expect(displayNameSchema.safeParse("Alice O'Brien").success).toBe(true);
  });

  it('accepts a hyphenated name', () => {
    expect(displayNameSchema.safeParse('Mary-Jane').success).toBe(true);
  });

  it('rejects a string containing <script> (angle bracket check)', () => {
    const result = displayNameSchema.safeParse('<script>alert(1)</script>');
    expect(result.success).toBe(false);
  });

  it('rejects any string containing a < character (covers all HTML injection)', () => {
    expect(displayNameSchema.safeParse('<b>bold</b>').success).toBe(false);
    expect(displayNameSchema.safeParse('Alice <test@ex.com>').success).toBe(false);
  });

  it("rejects the canonical SQL injection pattern: '; DROP TABLE users; --", () => {
    const result = displayNameSchema.safeParse("'; DROP TABLE users; --");
    expect(result.success).toBe(false);
  });

  it('rejects any string containing a semicolon', () => {
    expect(displayNameSchema.safeParse('Alice; SELECT * FROM users').success).toBe(false);
  });

  it('rejects a string containing a null byte', () => {
    expect(displayNameSchema.safeParse('Alice\x00Injection').success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(displayNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects a string over 100 characters', () => {
    expect(displayNameSchema.safeParse('a'.repeat(101)).success).toBe(false);
  });

  it("preserves apostrophes in names (O'Brien is valid)", () => {
    expect(displayNameSchema.safeParse("O'Brien").success).toBe(true);
  });

  it('trims leading and trailing whitespace before validating', () => {
    const result = displayNameSchema.safeParse('  Alice  ');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('Alice');
  });
});
