/**
 * src/services/EmotionDetector.ts
 *
 * Lightweight heuristic emotion detection from a user's message text.
 * Extracted out of conversations.router.ts (P1-018) so it can be unit
 * tested in isolation and reused by messagesStream.ts's background
 * stream driver.
 */

export interface EmotionTag {
  primary: string;
  score:   number;
}

export function detectEmotion(text: string): EmotionTag {
  const t = text.toLowerCase();
  if (/anxious|anxiety|worried|worry|stress|panic|nervous|overwhelm/.test(t))
    return { primary: 'anxiety',    score: 0.75 };
  if (/sad|depress|unhappy|cry|grief|lonely|lost|hopeless/.test(t))
    return { primary: 'sadness',    score: 0.75 };
  if (/angry|anger|furious|frustrated|mad|annoyed|rage/.test(t))
    return { primary: 'anger',      score: 0.75 };
  if (/excit|thrilled|pumped|energetic|enthusiastic|eager/.test(t))
    return { primary: 'excitement', score: 0.75 };
  if (/happy|joy|great|wonderful|amazing|grateful|love/.test(t))
    return { primary: 'joy',        score: 0.75 };
  if (/calm|peace|relax|serene|content|okay|fine|good/.test(t))
    return { primary: 'calm',       score: 0.70 };
  return { primary: 'calm', score: 0.5 };
}
