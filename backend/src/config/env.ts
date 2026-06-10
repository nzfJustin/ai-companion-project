/**
 * src/config/env.ts
 *
 * Validates that all required environment variables are present and
 * well-formed before the server starts.  Call `validateEnv()` as the
 * very first thing in src/index.ts.
 *
 * Fails fast with a clear error rather than a cryptic runtime crash.
 */

interface EnvRule {
  key:       string;
  minLength?: number;
  hint?:     string;
}

const REQUIRED: EnvRule[] = [
  {
    key:  'APP_SECRET',
    minLength: 32,
    hint: 'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  },
  {
    key:  'ANTHROPIC_API_KEY',
    hint: 'Get from https://console.anthropic.com',
  },
  {
    key:  'JWT_PRIVATE_KEY',
    hint: 'Generate an RS256 key pair with: openssl genrsa -out private.pem 2048',
  },
  {
    key:  'DATABASE_URL',
    hint: 'e.g. postgresql://postgres:postgres@localhost:5432/companion',
  },
  {
    key:  'REDIS_URL',
    hint: 'e.g. redis://localhost:6379',
  },
];

export function validateEnv(): void {
  const errors: string[] = [];

  for (const rule of REQUIRED) {
    const value = process.env[rule.key];

    if (!value || value.trim() === '') {
      errors.push(
        `  ✗ ${rule.key} is not set` +
        (rule.hint ? `\n      Hint: ${rule.hint}` : ''),
      );
      continue;
    }

    if (rule.minLength && Buffer.byteLength(value, 'utf8') < rule.minLength) {
      errors.push(
        `  ✗ ${rule.key} must be at least ${rule.minLength} bytes ` +
        `(got ${Buffer.byteLength(value, 'utf8')})` +
        (rule.hint ? `\n      Hint: ${rule.hint}` : ''),
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `\n\nMissing or invalid environment variables:\n${errors.join('\n')}\n\n` +
      'Copy .env.example to .env and fill in the values.\n',
    );
  }
}
