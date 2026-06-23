/**
 * src/ai/onboarding/OnboardingService.ts
 *
 * Handles the profile-seeding extraction that runs after a user's first
 * conversation closes (TDD P1-010 / sprint P1-14).
 *
 * Flow:
 *   1. Call AIOrchestrationService.complete() with mode='extraction' and
 *      the decrypted conversation messages.
 *   2. If the LLM returned a fallback (rate-limited / failed), mark the
 *      conversation extraction_failed and return { success: false }.
 *   3. Strip JSON fences and parse the raw response.
 *   4. Validate with OnboardingExtractionSchema.safeParse():
 *      - Invalid response → log extraction_schema_error, mark extraction_failed,
 *        return { success: false }.
 *   5. On valid schema: execute a single DB transaction writing:
 *        users.comm_style     = inferred_comm_style
 *        users.onboarding_done = true
 *        user_context.context_summary = initial_context
 *        user_context.stated_goals    = stated_goals
 *   6. Return { success: true, result }.
 *
 * Failure is ALWAYS non-fatal — the conversation is marked extraction_failed
 * but the app does not enter a broken state and onboarding_done remains false.
 * The standard extraction job (P1-19) can then retry.
 */

import { eq }            from 'drizzle-orm';
import { db }            from '../../db';
import { users, userContext } from '../../db/schema';
import type { AIOrchestrationService }    from '../AIOrchestrationService';
import type { Message }                   from '../llm/types';
import {
  OnboardingExtractionSchema,
  type OnboardingExtractionResult,
} from '../schemas/onboarding';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProcessOnboardingParams {
  conversationId: string;
  userId:         string;
  /** Decrypted conversation messages, most recent last */
  messages:       Message[];
}

export interface ProcessOnboardingResult {
  success: boolean;
  result?: OnboardingExtractionResult;
  /** Set when success=false to explain what went wrong (for logging) */
  failureReason?: 'llm_fallback' | 'schema_invalid' | 'db_error';
}

// ─── OnboardingService ────────────────────────────────────────────────────────

export class OnboardingService {
  constructor(
    private readonly orchestrator: AIOrchestrationService,
  ) {}

  /**
   * Runs the onboarding extraction and writes the results to the DB.
   * Always resolves — never throws. The caller should check `result.success`
   * and mark the conversation status accordingly.
   */
  async processConversation(
    params: ProcessOnboardingParams,
  ): Promise<ProcessOnboardingResult> {
    const { conversationId, userId, messages } = params;

    // ── 1. LLM extraction call ────────────────────────────────────────────────
    let llmResponse: Awaited<ReturnType<AIOrchestrationService['complete']>>;

    try {
      llmResponse = await this.orchestrator.complete({
        mode:     'extraction',
        messages,
        userProfile: {
          // userProfile is required by OrchestrationRequest but the extraction
          // prompt is static and ignores these values — pass safe defaults.
          displayName:    '',
          timezone:       'UTC',
          commStyle:      'warm',
          onboardingDone: false,
          contextSummary: null,
        },
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          event:          'onboarding_extraction_error',
          conversation_id: conversationId,
          user_id:         userId,
          error:           err instanceof Error ? err.message : String(err),
        }),
      );
      return { success: false, failureReason: 'llm_fallback' };
    }

    // Orchestration returns a fallback message when all LLM retries failed
    if (llmResponse.isFallback) {
      console.warn(
        JSON.stringify({
          event:          'onboarding_extraction_llm_fallback',
          conversation_id: conversationId,
          user_id:         userId,
        }),
      );
      return { success: false, failureReason: 'llm_fallback' };
    }

    // ── 2. Parse and validate the JSON response ───────────────────────────────
    let parsed: unknown;
    try {
      // Strip markdown code fences the LLM sometimes adds despite instructions
      const clean = llmResponse.content
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
      parsed = JSON.parse(clean);
    } catch {
      console.warn(
        JSON.stringify({
          event:          'onboarding_extraction_parse_error',
          conversation_id: conversationId,
          user_id:         userId,
          raw_length:      llmResponse.content.length,
        }),
      );
      return { success: false, failureReason: 'schema_invalid' };
    }

    const validation = OnboardingExtractionSchema.safeParse(parsed);

    if (!validation.success) {
      console.warn(
        JSON.stringify({
          event:                  'extraction_schema_error',
          conversation_id:         conversationId,
          user_id:                 userId,
          validation_errors:       validation.error.flatten(),
          // Highlight the memory_level out-of-range case explicitly
          memory_level_in_payload: (parsed as Record<string, unknown>).memory_level,
        }),
      );
      return { success: false, failureReason: 'schema_invalid' };
    }

    const result = validation.data;

    // ── 3. Atomic DB transaction ──────────────────────────────────────────────
    // All four writes (users.comm_style, users.onboarding_done,
    // user_context.context_summary, user_context.stated_goals) succeed or
    // fail together — no partial profile updates.
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({
            commStyle:      result.inferred_comm_style,
            onboardingDone: true,
          })
          .where(eq(users.id, userId));

        await tx
          .update(userContext)
          .set({
            contextSummary: result.initial_context,
            statedGoals:    result.stated_goals,
          })
          .where(eq(userContext.userId, userId));
      });

      console.log(
        JSON.stringify({
          event:               'onboarding_extraction_success',
          conversation_id:      conversationId,
          user_id:              userId,
          inferred_comm_style:  result.inferred_comm_style,
          stated_goals_count:   result.stated_goals.length,
          prompt_version:       llmResponse.promptVersion,
        }),
      );

      return { success: true, result };
    } catch (err) {
      console.error(
        JSON.stringify({
          event:          'onboarding_extraction_db_error',
          conversation_id: conversationId,
          user_id:         userId,
          error:           err instanceof Error ? err.message : String(err),
        }),
      );
      return { success: false, failureReason: 'db_error' };
    }
  }
}
