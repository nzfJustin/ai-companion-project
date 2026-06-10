/**
 * src/services/__tests__/EncryptionService.test.ts
 *
 * Unit tests for EncryptionService.
 * No network or DB required — pure crypto.
 */

import { EncryptionService, AuthenticationError, DecryptionError } from '../EncryptionService';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_SECRET = 'test-secret-that-is-at-least-32-bytes-long!!';
const USER_A = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeService(userId = USER_A): EncryptionService {
  return new EncryptionService(userId);
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

const originalSecret = process.env.APP_SECRET;

beforeEach(() => {
  process.env.APP_SECRET = VALID_SECRET;
});

afterEach(() => {
  // Restore original value (may be undefined in CI)
  if (originalSecret === undefined) {
    delete process.env.APP_SECRET;
  } else {
    process.env.APP_SECRET = originalSecret;
  }
});

// ─── Core round-trip (spec requirement) ──────────────────────────────────────

describe('round-trip', () => {
  it('decrypt(encrypt(x)) === x', () => {
    const svc = makeService();
    const plaintext = 'Today I felt overwhelmed but pushed through.';
    const { ciphertext, iv } = svc.encrypt(plaintext);
    expect(svc.decrypt(ciphertext, iv)).toBe(plaintext);
  });

  it('handles empty string', () => {
    const svc = makeService();
    const { ciphertext, iv } = svc.encrypt('');
    expect(svc.decrypt(ciphertext, iv)).toBe('');
  });

  it('handles a long payload (memory summary)', () => {
    const svc = makeService();
    const long = 'a'.repeat(10_000);
    const { ciphertext, iv } = svc.encrypt(long);
    expect(svc.decrypt(ciphertext, iv)).toBe(long);
  });

  it('handles unicode and emoji', () => {
    const svc = makeService();
    const plaintext = '今日は。😊 Ünïcödé téxt wïth ëmøjî 🧠💙';
    const { ciphertext, iv } = svc.encrypt(plaintext);
    expect(svc.decrypt(ciphertext, iv)).toBe(plaintext);
  });

  it('handles JSON strings', () => {
    const svc = makeService();
    const payload = JSON.stringify({ mood: 'anxious', score: 0.87, tags: ['work', 'stress'] });
    const { ciphertext, iv } = svc.encrypt(payload);
    expect(JSON.parse(svc.decrypt(ciphertext, iv))).toEqual(JSON.parse(payload));
  });
});

// ─── IV behaviour ─────────────────────────────────────────────────────────────

describe('IV', () => {
  it('generates a fresh IV for every encrypt call', () => {
    const svc = makeService();
    const { iv: iv1 } = svc.encrypt('message');
    const { iv: iv2 } = svc.encrypt('message');
    expect(iv1).not.toEqual(iv2);
  });

  it('IV is exactly 12 bytes', () => {
    const { iv } = makeService().encrypt('x');
    expect(iv.length).toBe(12);
  });
});

// ─── Per-user key isolation ───────────────────────────────────────────────────

describe('per-user key isolation', () => {
  it('different users produce different ciphertexts for the same plaintext', () => {
    // Note: IVs are random so ciphertexts can differ for that reason too,
    // but this confirms the keys are distinct even when IVs are the same.
    const svcA = makeService(USER_A);
    const svcB = makeService(USER_B);

    // Encrypt with user A
    const { ciphertext, iv } = svcA.encrypt('shared secret');

    // User B cannot decrypt user A's data
    expect(() => svcB.decrypt(ciphertext, iv)).toThrow(DecryptionError);
  });

  it('same user with same secret produces the same derived key', () => {
    // Two independent service instances for the same user should produce
    // the same key (HKDF is deterministic given the same inputs).
    const svc1 = makeService(USER_A);
    const svc2 = makeService(USER_A);

    const plaintext = 'deterministic key test';
    const { ciphertext, iv } = svc1.encrypt(plaintext);

    // svc2 should decrypt what svc1 encrypted
    expect(svc2.decrypt(ciphertext, iv)).toBe(plaintext);
  });
});

// ─── Tamper detection ─────────────────────────────────────────────────────────

describe('tamper detection', () => {
  it('throws DecryptionError when ciphertext body is modified', () => {
    const svc = makeService();
    const { ciphertext, iv } = svc.encrypt('do not tamper');

    // Flip a bit in the encrypted body (not the tag)
    const tampered = Buffer.from(ciphertext);
    tampered[0] ^= 0xff;

    expect(() => svc.decrypt(tampered, iv)).toThrow(DecryptionError);
  });

  it('throws DecryptionError when auth tag is modified', () => {
    const svc = makeService();
    const { ciphertext, iv } = svc.encrypt('do not tamper');

    // Flip a bit in the last 16 bytes (the GCM auth tag)
    const tampered = Buffer.from(ciphertext);
    tampered[tampered.length - 1] ^= 0xff;

    expect(() => svc.decrypt(tampered, iv)).toThrow(DecryptionError);
  });

  it('throws DecryptionError when IV is modified', () => {
    const svc = makeService();
    const { ciphertext, iv } = svc.encrypt('do not tamper');

    const wrongIv = Buffer.from(iv);
    wrongIv[0] ^= 0xff;

    expect(() => svc.decrypt(ciphertext, wrongIv)).toThrow(DecryptionError);
  });

  it('throws DecryptionError when ciphertext is too short', () => {
    const svc = makeService();
    const iv = Buffer.alloc(12);
    const tooShort = Buffer.alloc(15); // less than TAG_LEN (16)

    expect(() => svc.decrypt(tooShort, iv)).toThrow(DecryptionError);
  });
});

// ─── APP_SECRET validation ────────────────────────────────────────────────────

describe('APP_SECRET validation', () => {
  it('throws AuthenticationError when APP_SECRET is not set', () => {
    delete process.env.APP_SECRET;
    expect(() => makeService()).toThrow(AuthenticationError);
  });

  it('throws AuthenticationError when APP_SECRET is shorter than 32 bytes', () => {
    process.env.APP_SECRET = 'too-short';
    expect(() => makeService()).toThrow(AuthenticationError);
  });

  it('throws AuthenticationError — not a generic Error', () => {
    delete process.env.APP_SECRET;
    expect(() => makeService()).toThrow(
      expect.objectContaining({ name: 'AuthenticationError' }),
    );
  });

  it('accepts APP_SECRET that is exactly 32 bytes', () => {
    process.env.APP_SECRET = 'a'.repeat(32);
    expect(() => makeService()).not.toThrow();
  });
});

// ─── Error type identity ──────────────────────────────────────────────────────

describe('error types', () => {
  it('DecryptionError is an instance of Error', () => {
    const svc = makeService();
    const { ciphertext, iv } = svc.encrypt('x');
    const tampered = Buffer.from(ciphertext);
    tampered[0] ^= 0xff;

    try {
      svc.decrypt(tampered, iv);
      fail('Expected DecryptionError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DecryptionError);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('DecryptionError');
    }
  });

  it('AuthenticationError is an instance of Error', () => {
    delete process.env.APP_SECRET;
    try {
      makeService();
      fail('Expected AuthenticationError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthenticationError);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('AuthenticationError');
    }
  });
});
