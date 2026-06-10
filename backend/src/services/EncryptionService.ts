/**
 * src/services/EncryptionService.ts
 *
 * Per-user AES-256-GCM encryption.
 *
 * Each user gets a unique 256-bit key derived from the application secret
 * using HKDF-SHA256:
 *
 *   key = HKDF(ikm=APP_SECRET, salt=userId, info="memory_encryption", len=32)
 *
 * The key is derived once at construction time and reused for all
 * encrypt/decrypt calls on the same instance.
 *
 * Storage layout (what goes into the DB):
 *   content    column  →  ciphertext  =  [ encrypted_body || auth_tag(16 bytes) ]
 *   content_iv column  →  iv          =  12-byte random nonce
 *
 * Usage:
 *   const enc = new EncryptionService(userId);
 *   const { ciphertext, iv } = enc.encrypt(plaintext);
 *   // later …
 *   const plaintext = enc.decrypt(ciphertext, iv);
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALGORITHM  = 'aes-256-gcm' as const;
const KEY_LEN    = 32;  // bytes — 256-bit AES key
const IV_LEN     = 12;  // bytes — 96-bit nonce (GCM recommendation)
const TAG_LEN    = 16;  // bytes — 128-bit GCM authentication tag
const HKDF_HASH  = 'sha256' as const;
const HKDF_INFO  = Buffer.from('memory_encryption', 'utf8');

// ─── Custom error types ───────────────────────────────────────────────────────

/**
 * Thrown when the service cannot initialise due to a missing or invalid
 * APP_SECRET environment variable.
 */
export class AuthenticationError extends Error {
  constructor(message = 'Authentication failed') {
    super(message);
    this.name = 'AuthenticationError';
    // Maintains a proper prototype chain in transpiled ES5
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/**
 * Thrown when decryption fails — either because the data is corrupted,
 * the IV is wrong, or the ciphertext was tampered with (GCM auth tag
 * mismatch).  Never thrown for wrong-user-key scenarios — those also
 * surface as this error so callers don't learn which key was expected.
 */
export class DecryptionError extends Error {
  constructor(message = 'Decryption failed') {
    super(message);
    this.name = 'DecryptionError';
    Object.setPrototypeOf(this, DecryptionError.prototype);
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class EncryptionService {
  /** Derived AES-256 key — never exposed outside this instance */
  private readonly key: Buffer;

  /**
   * Derive a per-user encryption key.
   *
   * @param userId - The user's UUID; used as the HKDF salt so that every
   *                 user gets a cryptographically independent key even if
   *                 the same APP_SECRET is used across users.
   *
   * @throws {AuthenticationError} if APP_SECRET is absent or shorter than
   *   32 bytes (which would make the derived key weak).
   */
  constructor(userId: string) {
    const secret = process.env.APP_SECRET;

    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new AuthenticationError(
        'APP_SECRET must be at least 32 bytes. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }

    const derived = hkdfSync(
      HKDF_HASH,
      Buffer.from(secret, 'utf8'),   // IKM  — application master secret
      Buffer.from(userId, 'utf8'),   // salt — per-user isolation
      HKDF_INFO,                     // info — domain separation label
      KEY_LEN,
    );

    this.key = Buffer.from(derived);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Encrypt a UTF-8 plaintext string.
   *
   * A fresh random 12-byte IV is generated for every call — never reuse IVs
   * with the same key.
   *
   * The returned `ciphertext` bundles the encrypted body and the 16-byte
   * GCM authentication tag: `[ encrypted_body || tag ]`.  Store both
   * `ciphertext` and `iv` in the database; you need both to decrypt.
   *
   * @returns `{ ciphertext: Buffer, iv: Buffer }`
   */
  encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer } {
    const iv = randomBytes(IV_LEN);

    const cipher = createCipheriv(ALGORITHM, this.key, iv, {
      authTagLength: TAG_LEN,
    });

    const body = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
    ]);

    const tag = cipher.getAuthTag();

    // Concatenate body + tag so a single DB column holds everything
    const ciphertext = Buffer.concat([body, tag]);

    return { ciphertext, iv };
  }

  /**
   * Decrypt a value that was produced by `encrypt()`.
   *
   * @param ciphertext - The stored `[ encrypted_body || tag ]` buffer
   * @param iv         - The stored 12-byte IV
   *
   * @returns The original UTF-8 plaintext string
   *
   * @throws {DecryptionError} if the data is corrupted, the tag doesn't
   *   match, or the ciphertext is too short to contain a tag.
   */
  decrypt(ciphertext: Buffer, iv: Buffer): string {
    if (ciphertext.length < TAG_LEN) {
      throw new DecryptionError(
        `Ciphertext too short: expected at least ${TAG_LEN} bytes, got ${ciphertext.length}`,
      );
    }

    const body = ciphertext.subarray(0, -TAG_LEN);
    const tag  = ciphertext.subarray(-TAG_LEN);

    const decipher = createDecipheriv(ALGORITHM, this.key, iv, {
      authTagLength: TAG_LEN,
    });
    decipher.setAuthTag(tag);

    try {
      const plaintext = Buffer.concat([
        decipher.update(body),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch {
      // Do NOT leak whether the failure was a tag mismatch or a key error
      throw new DecryptionError(
        'Decryption failed — data may be corrupt or the key is incorrect',
      );
    }
  }
}
