/**
 * src/ai/schemas/extraction.ts
 *
 * Base Zod schema for memory extraction (TDD P1-016 / sprint P1-19).
 *
 * This is the schema used by the regular (non-onboarding) extraction job
 * that runs whenever a conversation closes. The onboarding-specific schema
 * (OnboardingExtractionSchema in src/ai/schemas/onboarding.ts) extends this
 * with three additional fields.
 *
 * Validation rules of note:
 *   - memory_level must be an integer 1-5. This rejects out-of-range values
 *     like 99 (the MockLLMProvider's deliberate edge-case fixture).
 *   - dominant_emotion is normalised to lowercase and trimmed via a Zod
 *     transform, so "Anxious." is stored as "anxious." consistently.
 *   - emotion_scores must be an OBJECT with the six named keys, each a
 *     float 0.0-1.0. A malformed response where emotion_scores is a string
 *     fails validation here, before it ever reaches the DB.
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

export type EmotionScores = z.infer<typeof EmotionScoresSchema>;

// ─── MemoryExtractionSchema ───────────────────────────────────────────────────

export const MemoryExtractionSchema = z.object({
  title:      z.string().min(1).max(200),
  summary:    z.string().min(1).max(5000),
  key_events: z.array(z.string().max(500)).max(10).default([]),

  /** Normalised to lowercase and stripped of punctuation so downstream
   *  queries stay consistent.  "Anxious." → "anxious", "CALM!" → "calm". */
  dominant_emotion: z
    .string()
    .transform((s) => s.trim().toLowerCase().replace(/[^\w\s]/g, '').trim()),

  emotion_scores: EmotionScoresSchema,

  /** Only 1-5 are valid; rejects out-of-range values such as 99. */
  memory_level: z.number().int().min(1).max(5),
});

export type MemoryExtractionResult = z.infer<typeof MemoryExtractionSchema>;
