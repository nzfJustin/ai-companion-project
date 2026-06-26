/**
 * src/lib/logger.ts
 *
 * Structured JSON logger with automatic PII redaction (TDD P1-022 / sprint P1-17).
 *
 * Every log line is a single-line JSON object emitted to stdout — this lets
 * any log aggregator (Datadog, Loki, CloudWatch) parse fields without regex.
 *
 * PII redaction is unconditional and deep:
 *   Any key matching the PII_FIELDS set, anywhere in the object tree, has
 *   its value replaced with the string "[REDACTED]" before serialisation.
 *   Callers never need to pre-filter — the logger is the enforcement point.
 *
 * PII fields (TDD §12.1):
 *   email, password, password_hash, pin, content, token
 */

// ─── PII field set ────────────────────────────────────────────────────────────

const PII_FIELDS = new Set<string>([
  'email',
  'password',
  'password_hash',
  'pin',
  'content',   // decrypted message / memory content
  'token',
]);

// ─── Types ────────────────────────────────────────────────────────────────────

type JsonPrimitive = string | number | boolean | null | undefined;
type JsonValue     = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue; }

export interface LogFields extends JsonObject {
  event: string;
}

// ─── PII redaction ────────────────────────────────────────────────────────────

/**
 * Deep-traverses a plain object and replaces the value of any key that
 * appears in PII_FIELDS with the string "[REDACTED]".
 *
 * - Objects are traversed recursively.
 * - Arrays have each element traversed if the element is itself an object.
 * - Buffer / Date / other non-plain values are passed through as-is.
 * - The input object is NOT mutated; a new object is returned.
 */
export function redactPII(obj: JsonObject): JsonObject {
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(obj)) {
    if (PII_FIELDS.has(key)) {
      out[key] = '[REDACTED]';
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        isPlainObject(item) ? redactPII(item as JsonObject) : item,
      );
    } else if (isPlainObject(value)) {
      out[key] = redactPII(value as JsonObject);
    } else {
      out[key] = value;
    }
  }

  return out;
}

function isPlainObject(v: unknown): boolean {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    !Buffer.isBuffer(v) &&
    !(v instanceof Date)
  );
}

// ─── Emitters ─────────────────────────────────────────────────────────────────

function emit(level: 'log' | 'warn' | 'error', fields: LogFields): void {
  const payload: JsonObject = {
    timestamp: new Date().toISOString(),
    ...fields,
  };
  // eslint-disable-next-line no-console
  console[level](JSON.stringify(redactPII(payload)));
}

/**
 * Emit a structured INFO-level log line.
 * PII fields are automatically redacted.
 */
export function log(fields: LogFields): void {
  emit('log', fields);
}

/**
 * Emit a structured WARN-level log line.
 * PII fields are automatically redacted.
 */
export function warn(fields: LogFields): void {
  emit('warn', fields);
}

/**
 * Emit a structured ERROR-level log line.
 * PII fields are automatically redacted.
 */
export function logError(fields: LogFields): void {
  emit('error', fields);
}
