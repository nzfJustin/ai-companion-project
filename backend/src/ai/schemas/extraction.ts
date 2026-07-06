import { z } from 'zod';
import { EmotionScoresSchema } from './onboarding';

export const MemoryExtractionSchema = z.object({
  title:            z.string().min(1).max(200),
  summary:          z.string().min(1).max(5000),
  key_events:       z.array(z.string().max(500)).max(10).default([]),
  dominant_emotion: z.string().transform((s) => s.trim().toLowerCase()),
  emotion_scores:   EmotionScoresSchema,
  memory_level:     z.number().int().min(1).max(5),
});

export type MemoryExtractionResult = z.infer<typeof MemoryExtractionSchema>;
