/**
 * src/ai/schemas/onboarding.ts
 *
 * Zod schema for validating the LLM's onboarding extraction response.
 *
 * The extraction prompt (ONBOARDING_EXTRACTION_PROMPT in src/ai/prompts/index.ts)
 * asks the LLM to return JSON conforming to this shape after the first
 * conversation closes. OnboardingService uses safeParse() against this schema —
 * if it fails, the extraction is logged as a schema error and the conversation
 * is marked extraction_failed without crashing the app.
 *
 * Note on memory_level: valid values are 1–5.  The MockLLMProvider can be
 * configured to return memory_level: 99 to exercise the rejection path —
 * this schema will correctly reject it with a validation error.
 */

import { z } from 'zod';

// ─── Emotion scores ────────────────────────────────────────────────────────────

export const EmotionScoresSchema = z.object({
  joy:        z.number().min(0).max(1),
  sadness:    z.number().min(0).max(1),
  anxiety:    z.number().min(0).max(1),
  anger:      z.number().min(0).max(1),
  calm:       z.number().min(0).max(1),
  excitement: z.number().min(0).max(1),
});

// ─── OnboardingExtractionSchema ───────────────────────────────────────────────

export const OnboardingExtractionSchema = z.object({
  // ── Standard memory fields (shared with MemoryExtractionSchema in P1-19) ──
  title:            z.string().min(1).max(200),
  summary:          z.string().min(1).max(5000),
  key_events:       z.array(z.string().max(500)).max(10).default([]),
  /** Normalised to lowercase to keep downstream queries consistent. */
  dominant_emotion: z
    .string()
    .transform((s) => s.trim().toLowerCase()),
  emotion_scores:   EmotionScoresSchema,
  /** Only 1–5 are valid; rejects out-of-range values such as 99. */
  memory_level:     z.number().int().min(1).max(5),

  // ── Onboarding-specific fields ─────────────────────────────────────────────
  inferred_comm_style: z.enum(['warm', 'direct', 'reflective']),
  stated_goals:        z.array(z.string().max(200)).max(10).default([]),
  initial_context:     z.string().max(2000),
});

export type OnboardingExtractionResult = z.infer<typeof OnboardingExtractionSchema>;
