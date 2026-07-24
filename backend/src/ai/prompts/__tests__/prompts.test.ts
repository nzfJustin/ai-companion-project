/**
 * src/ai/prompts/__tests__/prompts.test.ts
 *
 * Unit tests for the prompt module (TDD P1-009).
 * No network calls — prompts are pure functions.
 */

import {
  sanitizeForPrompt,
  CHAT_PROMPT,
  ONBOARDING_PROMPT,
  selectPrompt,
} from '../index';
import type { PromptContext } from '../index';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_CTX: PromptContext = {
  display_name:    'Alice',
  timezone:        'America/New_York',
  comm_style:      'warm',
  context_summary: null,
  onboarding_done: true,
};

const CTX_WITH_SUMMARY: PromptContext = {
  ...BASE_CTX,
  context_summary: 'Alice is a software engineer dealing with work-related stress.',
};

const NEW_USER_CTX: PromptContext = {
  ...BASE_CTX,
  onboarding_done: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeForPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe('sanitizeForPrompt', () => {
  // ── TDD P1-009: the explicitly required SQL injection test ────────────────
  it("safely sanitizes a display_name containing SQL injection characters ('; DROP TABLE users; --)", () => {
    const result = sanitizeForPrompt("'; DROP TABLE users; --");
    // Semicolons must be stripped — they are the primary injection vector
    expect(result).not.toContain(';');
    // The result must be a non-empty, non-crashing string
    expect(result.length).toBeGreaterThan(0);
    // Verify the known-safe content (letters, spaces, hyphens) survives
    expect(result).toMatch(/DROP/);
    expect(result).toMatch(/TABLE/);
    expect(result).toMatch(/users/);
  });

  it('strips angle brackets (HTML / XML injection)', () => {
    expect(sanitizeForPrompt('<script>alert("xss")</script>')).not.toContain('<');
    expect(sanitizeForPrompt('<script>alert("xss")</script>')).not.toContain('>');
  });

  it('strips curly braces (template injection)', () => {
    expect(sanitizeForPrompt('${process.env.SECRET}')).not.toContain('{');
    expect(sanitizeForPrompt('${process.env.SECRET}')).not.toContain('}');
  });

  it('strips backticks', () => {
    expect(sanitizeForPrompt('`rm -rf /`')).not.toContain('`');
  });

  it('preserves safe characters: letters, numbers, spaces', () => {
    expect(sanitizeForPrompt('Alice Smith 42')).toBe('Alice Smith 42');
  });

  it('preserves hyphens (for hyphenated names)', () => {
    expect(sanitizeForPrompt('Mary-Jane')).toBe('Mary-Jane');
  });

  it('preserves apostrophes (for names like O\'Brien)', () => {
    expect(sanitizeForPrompt("O'Brien")).toBe("O'Brien");
  });

  it('preserves periods and commas', () => {
    expect(sanitizeForPrompt('Dr. Smith, Jr.')).toBe('Dr. Smith, Jr.');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeForPrompt('  Alice  ')).toBe('Alice');
  });

  it('truncates to the specified maxLength', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeForPrompt(long, 50)).toHaveLength(50);
  });

  it('uses 100 as the default maxLength', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeForPrompt(long)).toHaveLength(100);
  });

  it('handles an empty string without throwing', () => {
    expect(() => sanitizeForPrompt('')).not.toThrow();
    expect(sanitizeForPrompt('')).toBe('');
  });

  it('caps comm_style to 50 characters when called with maxLength=50', () => {
    const style = 'a'.repeat(80);
    expect(sanitizeForPrompt(style, 50)).toHaveLength(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CHAT_PROMPT
// ─────────────────────────────────────────────────────────────────────────────

describe('CHAT_PROMPT', () => {
  it('has version string "chat_v1.1.0"', () => {
    expect(CHAT_PROMPT.version).toBe('chat_v1.1.0');
  });

  it('returns a non-empty string', () => {
    const result = CHAT_PROMPT.system(BASE_CTX);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes the user\'s display_name', () => {
    const result = CHAT_PROMPT.system(BASE_CTX);
    expect(result).toContain('Alice');
  });

  it('includes the user\'s timezone', () => {
    const result = CHAT_PROMPT.system(BASE_CTX);
    expect(result).toContain('America/New_York');
  });

  it('includes a tone description matching comm_style=warm', () => {
    const result = CHAT_PROMPT.system({ ...BASE_CTX, comm_style: 'warm' });
    expect(result).toMatch(/warm/i);
  });

  it('includes a tone description matching comm_style=direct', () => {
    const result = CHAT_PROMPT.system({ ...BASE_CTX, comm_style: 'direct' });
    expect(result).toMatch(/direct/i);
  });

  it('includes a tone description matching comm_style=reflective', () => {
    const result = CHAT_PROMPT.system({ ...BASE_CTX, comm_style: 'reflective' });
    expect(result).toMatch(/reflective/i);
  });

  it('includes context_summary when provided', () => {
    const result = CHAT_PROMPT.system(CTX_WITH_SUMMARY);
    expect(result).toContain('software engineer');
  });

  it('does NOT include context_summary when null', () => {
    const result = CHAT_PROMPT.system(BASE_CTX);
    expect(result).not.toContain('software engineer');
  });

  it('includes the PERSONA block (mentions companion role)', () => {
    const result = CHAT_PROMPT.system(BASE_CTX);
    expect(result).toMatch(/companion/i);
  });

  it('includes BEHAVIORAL GUARDRAILS (mentions crisis resources)', () => {
    const result = CHAT_PROMPT.system(BASE_CTX);
    expect(result).toMatch(/988|crisis/i);
  });

  it('sanitizes a dangerous display_name before interpolation', () => {
    const result = CHAT_PROMPT.system({
      ...BASE_CTX,
      display_name: "'; DROP TABLE users; --",
    });
    expect(result).not.toContain(';');
  });

  it('sanitizes a display_name with angle brackets', () => {
    const result = CHAT_PROMPT.system({
      ...BASE_CTX,
      display_name: '<script>alert(1)</script>',
    });
    expect(result).not.toContain('<script>');
  });

  it('contains content in the correct block order (PERSONA before USER CONTEXT before GUARDRAILS)', () => {
    const result = CHAT_PROMPT.system(BASE_CTX);
    const personaIdx    = result.indexOf('compassionate');
    const userCtxIdx    = result.indexOf('Alice');
    const guardrailsIdx = result.indexOf('988');

    expect(personaIdx).toBeGreaterThan(-1);
    expect(userCtxIdx).toBeGreaterThan(personaIdx);
    expect(guardrailsIdx).toBeGreaterThan(userCtxIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING_PROMPT
// ─────────────────────────────────────────────────────────────────────────────

describe('ONBOARDING_PROMPT', () => {
  it('has version string "onboarding_v1.0.0"', () => {
    expect(ONBOARDING_PROMPT.version).toBe('onboarding_v1.0.0');
  });

  it('returns a non-empty string', () => {
    const result = ONBOARDING_PROMPT.system(NEW_USER_CTX);
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes the user\'s display_name', () => {
    const result = ONBOARDING_PROMPT.system(NEW_USER_CTX);
    expect(result).toContain('Alice');
  });

  it('is different from the standard chat prompt', () => {
    const chatResult       = CHAT_PROMPT.system(BASE_CTX);
    const onboardingResult = ONBOARDING_PROMPT.system(NEW_USER_CTX);
    expect(chatResult).not.toBe(onboardingResult);
  });

  it('still includes BEHAVIORAL GUARDRAILS (crisis resources)', () => {
    const result = ONBOARDING_PROMPT.system(NEW_USER_CTX);
    expect(result).toMatch(/988|crisis/i);
  });

  it('focuses on getting to know the user (mentions first conversation)', () => {
    const result = ONBOARDING_PROMPT.system(NEW_USER_CTX);
    expect(result).toMatch(/first|meeting|new/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selectPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe('selectPrompt', () => {
  it('returns CHAT_PROMPT when onboarding_done = true', () => {
    const prompt = selectPrompt({ ...BASE_CTX, onboarding_done: true });
    expect(prompt.version).toBe('chat_v1.1.0');
  });

  it('returns ONBOARDING_PROMPT when onboarding_done = false', () => {
    const prompt = selectPrompt({ ...BASE_CTX, onboarding_done: false });
    expect(prompt.version).toBe('onboarding_v1.0.0');
  });

  it('returns a VersionedPrompt with a version string and system function', () => {
    const prompt = selectPrompt(BASE_CTX);
    expect(typeof prompt.version).toBe('string');
    expect(typeof prompt.system).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No prompt strings outside this file
// ─────────────────────────────────────────────────────────────────────────────

describe('prompt encapsulation', () => {
  it('CHAT_PROMPT.version is a non-empty string with semver-like format', () => {
    expect(CHAT_PROMPT.version).toMatch(/^[a-z_]+_v\d+\.\d+\.\d+$/);
  });

  it('ONBOARDING_PROMPT.version is a non-empty string with semver-like format', () => {
    expect(ONBOARDING_PROMPT.version).toMatch(/^[a-z_]+_v\d+\.\d+\.\d+$/);
  });
});
