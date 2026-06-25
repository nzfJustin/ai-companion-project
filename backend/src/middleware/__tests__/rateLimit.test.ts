/**
 * src/middleware/__tests__/rateLimit.test.ts
 *
 * Tests the sliding window rate limiter middleware.
 * Redis is mocked so no real connection is needed.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockEval = jest.fn();

jest.mock('../../lib/redis', () => ({
  redis: {
    eval: mockEval,
  },
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import type { Request, Response, NextFunction } from 'express';
import { createRateLimit, globalRateLimit, aiRateLimit } from '../rateLimit';
import { AppError } from '../../lib/errors';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeReq(userId?: string): Partial<Request> {
  return { userId } as Partial<Request>;
}

function makeRes(): { headers: Record<string, string>; setHeader: jest.Mock } {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: jest.fn((name: string, value: string) => { headers[name] = value; }),
  };
}

async function runMiddleware(
  middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>,
  req: Partial<Request>,
): Promise<{ next: jest.Mock; res: ReturnType<typeof makeRes> }> {
  const res  = makeRes();
  const next = jest.fn();
  await middleware(req as Request, res as unknown as Response, next);
  return { next, res };
}

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// Allowed requests
// ─────────────────────────────────────────────────────────────────────────────

describe('createRateLimit — allowed requests', () => {
  it('calls next() when the request is within the limit', async () => {
    // Script returns [1, 0] = allowed
    mockEval.mockResolvedValue([1, 0]);
    const limiter = createRateLimit({ windowMs: 60_000, max: 10 });
    const { next } = await runMiddleware(limiter, makeReq('user-1'));

    expect(next).toHaveBeenCalledWith(); // next() with no args = allow
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes through without calling Redis when userId is not set (unauthenticated)', async () => {
    const limiter = createRateLimit({ windowMs: 60_000, max: 10 });
    const { next } = await runMiddleware(limiter, makeReq(undefined));

    expect(mockEval).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(); // allow
  });

  it('passes the correct key to the Lua script using keyPrefix', async () => {
    mockEval.mockResolvedValue([1, 0]);
    const limiter = createRateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'rl:test' });
    await runMiddleware(limiter, makeReq('user-abc'));

    const callArgs = mockEval.mock.calls[0];
    expect(callArgs[2]).toBe('rl:test:user-abc'); // KEYS[1]
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limited requests
// ─────────────────────────────────────────────────────────────────────────────

describe('createRateLimit — rate limited', () => {
  it('calls next(AppError(429)) when rate limit is exceeded', async () => {
    const now       = Date.now();
    const oldest_ts = now - 30_000; // 30s ago
    mockEval.mockResolvedValue([0, oldest_ts]); // script: rate limited

    const limiter = createRateLimit({ windowMs: 60_000, max: 10 });
    const { next } = await runMiddleware(limiter, makeReq('user-1'));

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const err = next.mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
  });

  it('sets Retry-After header in seconds', async () => {
    const now       = Date.now();
    const oldest_ts = now - 30_000; // 30s into a 60s window → 30s remaining
    mockEval.mockResolvedValue([0, oldest_ts]);

    const limiter = createRateLimit({ windowMs: 60_000, max: 10 });
    const { res } = await runMiddleware(limiter, makeReq('user-1'));

    const retryAfter = parseInt(res.headers['Retry-After'], 10);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(30); // ~30s remaining
  });

  it('sets X-RateLimit-Reset header as Unix epoch (seconds)', async () => {
    const now       = Date.now();
    const oldest_ts = now - 30_000;
    mockEval.mockResolvedValue([0, oldest_ts]);

    const limiter = createRateLimit({ windowMs: 60_000, max: 10 });
    const { res } = await runMiddleware(limiter, makeReq('user-1'));

    const reset = parseInt(res.headers['X-RateLimit-Reset'], 10);
    const expectedReset = Math.ceil((oldest_ts + 60_000) / 1000);
    expect(reset).toBe(expectedReset);
  });

  it('Retry-After is at least 1 second even for near-immediate resets', async () => {
    const now = Date.now();
    // Oldest entry is essentially now — window expires almost immediately
    mockEval.mockResolvedValue([0, now - 59_999]);

    const limiter = createRateLimit({ windowMs: 60_000, max: 10 });
    const { res } = await runMiddleware(limiter, makeReq('user-1'));

    expect(parseInt(res.headers['Retry-After'], 10)).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail-open on Redis unavailability (TDD P1-021 requirement)
// ─────────────────────────────────────────────────────────────────────────────

describe('createRateLimit — fail-open when Redis is unavailable', () => {
  it('calls next() without error when Redis throws', async () => {
    mockEval.mockRejectedValue(new Error('ECONNREFUSED'));

    const limiter = createRateLimit({ windowMs: 60_000, max: 10 });
    const { next } = await runMiddleware(limiter, makeReq('user-1'));

    expect(next).toHaveBeenCalledWith(); // allow through
  });

  it('emits a warn log with { event: "rate_limit_redis_miss", user_id }', async () => {
    mockEval.mockRejectedValue(new Error('Connection refused'));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const limiter = createRateLimit({ windowMs: 60_000, max: 10 });
    await runMiddleware(limiter, makeReq('user-42'));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedPayload = JSON.parse(warnSpy.mock.calls[0][0]);
    expect(loggedPayload.event).toBe('rate_limit_redis_miss');
    expect(loggedPayload.user_id).toBe('user-42');

    warnSpy.mockRestore();
  });

  it('does NOT log rate_limit_redis_miss for unauthenticated requests (Redis not called)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const limiter = createRateLimit({ windowMs: 60_000, max: 10 });
    await runMiddleware(limiter, makeReq(undefined));

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lua script arguments
// ─────────────────────────────────────────────────────────────────────────────

describe('createRateLimit — Redis eval arguments', () => {
  it('passes current timestamp as ARGV[1]', async () => {
    mockEval.mockResolvedValue([1, 0]);
    const before = Date.now();

    const limiter = createRateLimit({ windowMs: 60_000, max: 10 });
    await runMiddleware(limiter, makeReq('user-1'));

    const after = Date.now();
    const tsArg = parseInt(mockEval.mock.calls[0][3], 10); // ARGV[1]
    expect(tsArg).toBeGreaterThanOrEqual(before);
    expect(tsArg).toBeLessThanOrEqual(after);
  });

  it('passes window_start = now - windowMs as ARGV[2]', async () => {
    mockEval.mockResolvedValue([1, 0]);

    const limiter = createRateLimit({ windowMs: 30_000, max: 10 });
    await runMiddleware(limiter, makeReq('user-1'));

    const nowArg         = parseInt(mockEval.mock.calls[0][3], 10); // ARGV[1]
    const windowStartArg = parseInt(mockEval.mock.calls[0][4], 10); // ARGV[2]
    expect(nowArg - windowStartArg).toBeCloseTo(30_000, -2); // ±100ms tolerance
  });

  it('passes max as ARGV[3]', async () => {
    mockEval.mockResolvedValue([1, 0]);

    const limiter = createRateLimit({ windowMs: 60_000, max: 42 });
    await runMiddleware(limiter, makeReq('user-1'));

    expect(mockEval.mock.calls[0][5]).toBe('42'); // ARGV[3]
  });

  it('passes a unique member as ARGV[5] (prevents ZADD collisions)', async () => {
    mockEval.mockResolvedValue([1, 0]);

    const limiter = createRateLimit({ windowMs: 60_000, max: 10 });
    await runMiddleware(limiter, makeReq('user-1'));
    await runMiddleware(limiter, makeReq('user-1'));

    const member1 = mockEval.mock.calls[0][7]; // ARGV[5]
    const member2 = mockEval.mock.calls[1][7]; // ARGV[5] of second call
    expect(member1).not.toBe(member2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pre-configured instances
// ─────────────────────────────────────────────────────────────────────────────

describe('globalRateLimit and aiRateLimit', () => {
  it('globalRateLimit allows a request within the 60/min limit', async () => {
    mockEval.mockResolvedValue([1, 0]);
    const { next } = await runMiddleware(globalRateLimit, makeReq('user-1'));
    expect(next).toHaveBeenCalledWith();
  });

  it('aiRateLimit uses a different key prefix than globalRateLimit', async () => {
    mockEval.mockResolvedValue([1, 0]);
    await runMiddleware(globalRateLimit, makeReq('user-1'));
    const globalKey = mockEval.mock.calls[0][2]; // KEYS[1]

    mockEval.mockClear();
    mockEval.mockResolvedValue([1, 0]);
    await runMiddleware(aiRateLimit, makeReq('user-1'));
    const aiKey = mockEval.mock.calls[0][2]; // KEYS[1]

    expect(globalKey).not.toBe(aiKey);
    expect(globalKey).toMatch(/rl:global/);
    expect(aiKey).toMatch(/rl:ai/);
  });

  it('aiRateLimit rejects after 20 requests while globalRateLimit allows 60', async () => {
    // aiRateLimit max = 20, globalRateLimit max = 60 — verify from ARGV[3]
    mockEval.mockResolvedValue([1, 0]);

    await runMiddleware(aiRateLimit, makeReq('user-1'));
    const aiMax = mockEval.mock.calls[0][5]; // ARGV[3]
    expect(aiMax).toBe('20');

    mockEval.mockClear();
    await runMiddleware(globalRateLimit, makeReq('user-1'));
    const globalMax = mockEval.mock.calls[0][5];
    expect(globalMax).toBe('60');
  });
});
