/**
 * src/ai/onboarding/__tests__/OnboardingService.test.ts
 *
 * AIOrchestrationService is mocked so no LLM calls are made.
 * DB is mocked so no real Postgres is required.
 *
 * The TDD-required test (criterion 5 of P1-010):
 *   "A unit test mocks the LLM to return an onboarding extraction response
 *    and verifies that users.comm_style, users.onboarding_done, and
 *    user_context are all written correctly."
 */

// ── Mocks (hoisted) ────────────────────────────────────────────────────────────

const mockTxUpdate = jest.fn();

jest.mock('../../../db', () => ({
  db: {
    transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        update: mockTxUpdate,
      }),
    ),
  },
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { OnboardingService }      from '../OnboardingService';
import type { AIOrchestrationService } from '../../AIOrchestrationService';
import { db }                     from '../../../db';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CONVERSATION_ID = 'conv-111';
const USER_ID         = 'user-222';

const SAMPLE_MESSAGES = [
  { role: 'user' as const,      content: "Hi, I'm feeling overwhelmed lately." },
  { role: 'assistant' as const, content: 'Tell me more about what\'s been happening.' },
  { role: 'user' as const,      content: "Work stress mainly. I want to manage my anxiety better." },
];

/** A valid JSON string the LLM might return for onboarding extraction. */
const VALID_EXTRACTION_JSON = JSON.stringify({
  title:               'First session — work stress and anxiety',
  summary:             'User shared feelings of overwhelm related to work. They want to manage anxiety.',
  key_events:          ['Mentioned work stress', 'Expressed desire to manage anxiety'],
  dominant_emotion:    'Anxious',          // should be lowercased by schema transform
  emotion_scores:      { joy: 0.2, sadness: 0.3, anxiety: 0.7, anger: 0.1, calm: 0.3, excitement: 0.1 },
  memory_level:        2,
  inferred_comm_style: 'warm',
  stated_goals:        ['Manage anxiety', 'Feel less overwhelmed at work'],
  initial_context:     'User is dealing with significant work-related stress and wants to build better coping skills.',
});

/** The same but wrapped in code fences (common LLM formatting error). */
const FENCED_EXTRACTION_JSON = `\`\`\`json\n${VALID_EXTRACTION_JSON}\n\`\`\``;

/** Invalid: memory_level: 99 — must be rejected by schema (1–5 only). */
const INVALID_MEMORY_LEVEL_JSON = JSON.stringify({
  ...JSON.parse(VALID_EXTRACTION_JSON),
  memory_level: 99,
});

/** Invalid: inferred_comm_style has an unrecognised value. */
const INVALID_COMM_STYLE_JSON = JSON.stringify({
  ...JSON.parse(VALID_EXTRACTION_JSON),
  inferred_comm_style: 'sarcastic',
});

// ── Mock orchestrator factory ─────────────────────────────────────────────────

function makeOrchestrator(
  content: string,
  isFallback = false,
): jest.Mocked<Pick<AIOrchestrationService, 'complete'>> {
  return {
    complete: jest.fn().mockResolvedValue({
      content,
      promptVersion: 'onboarding_extraction_v1.0.0',
      usage:         { inputTokens: 200, outputTokens: 100, cachedTokens: 0 },
      isFallback,
    }),
  };
}

/** Sets up mockTxUpdate so each call returns its own chainable { set().where() } mock. */
function setupUpdateMock() {
  mockTxUpdate.mockImplementation(() => {
    const where = jest.fn().mockResolvedValue(undefined);
    const set   = jest.fn().mockReturnValue({ where });
    return { set };
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  setupUpdateMock(); // default: chainable no-ops
});

// ─────────────────────────────────────────────────────────────────────────────
// The TDD-required test (P1-010 criterion 5)
// ─────────────────────────────────────────────────────────────────────────────

describe('OnboardingService.processConversation — TDD required test', () => {
  it(
    'mocks the LLM to return a valid extraction response and verifies ' +
    'users.comm_style, users.onboarding_done, and user_context are all written correctly',
    async () => {
      const orchestrator = makeOrchestrator(VALID_EXTRACTION_JSON) as unknown as AIOrchestrationService;
      const service = new OnboardingService(orchestrator);

      const result = await service.processConversation({
        conversationId: CONVERSATION_ID,
        userId:         USER_ID,
        messages:       SAMPLE_MESSAGES,
      });

      // ── Extraction succeeded ───────────────────────────────────────────────
      expect(result.success).toBe(true);
      expect(result.result?.inferred_comm_style).toBe('warm');
      expect(result.result?.stated_goals).toEqual(['Manage anxiety', 'Feel less overwhelmed at work']);

      // ── DB transaction was used ────────────────────────────────────────────
      expect(db.transaction).toHaveBeenCalledTimes(1);

      // ── users was updated with comm_style and onboarding_done=true ─────────
      const updateCalls = mockTxUpdate.mock.calls;
      const setArgs = mockTxUpdate.mock.results.map(
        (r) => (r.value as { set: jest.Mock }).set.mock.calls[0][0],
      );

      const usersUpdate = setArgs.find(
        (args) => 'commStyle' in args && 'onboardingDone' in args,
      );
      expect(usersUpdate).toBeDefined();
      expect(usersUpdate.commStyle).toBe('warm');
      expect(usersUpdate.onboardingDone).toBe(true);

      // ── user_context was updated with contextSummary and statedGoals ───────
      const contextUpdate = setArgs.find(
        (args) => 'contextSummary' in args && 'statedGoals' in args,
      );
      expect(contextUpdate).toBeDefined();
      expect(contextUpdate.contextSummary).toBe(
        'User is dealing with significant work-related stress and wants to build better coping skills.',
      );
      expect(contextUpdate.statedGoals).toEqual(['Manage anxiety', 'Feel less overwhelmed at work']);

      // ── Two update() calls within the transaction ──────────────────────────
      expect(updateCalls).toHaveLength(2); // one for users, one for user_context
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy-path details
// ─────────────────────────────────────────────────────────────────────────────

describe('OnboardingService.processConversation — happy path', () => {
  it('normalises dominant_emotion to lowercase', async () => {
    const orchestrator = makeOrchestrator(VALID_EXTRACTION_JSON) as unknown as AIOrchestrationService;
    const service = new OnboardingService(orchestrator);

    const result = await service.processConversation({
      conversationId: CONVERSATION_ID,
      userId:         USER_ID,
      messages:       SAMPLE_MESSAGES,
    });

    // 'Anxious.' in the fixture → schema transform → 'anxious.'
    // (The schema lowercases; the test fixture has capital 'Anxious')
    expect(result.result?.dominant_emotion).toBe('anxious');
  });

  it('strips JSON code fences before parsing', async () => {
    const orchestrator = makeOrchestrator(FENCED_EXTRACTION_JSON) as unknown as AIOrchestrationService;
    const service = new OnboardingService(orchestrator);

    const result = await service.processConversation({
      conversationId: CONVERSATION_ID,
      userId:         USER_ID,
      messages:       SAMPLE_MESSAGES,
    });

    expect(result.success).toBe(true);
  });

  it('passes the conversation messages to the orchestrator', async () => {
    const orchestrator = makeOrchestrator(VALID_EXTRACTION_JSON) as unknown as AIOrchestrationService;
    const service = new OnboardingService(orchestrator);

    await service.processConversation({
      conversationId: CONVERSATION_ID,
      userId:         USER_ID,
      messages:       SAMPLE_MESSAGES,
    });

    expect(orchestrator.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        mode:     'extraction',
        messages: SAMPLE_MESSAGES,
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure paths — graceful degradation (TDD P1-010 criterion 4)
// ─────────────────────────────────────────────────────────────────────────────

describe('OnboardingService.processConversation — failure paths', () => {
  it('returns { success: false, failureReason: llm_fallback } when LLM is unavailable', async () => {
    const orchestrator = makeOrchestrator('', true /* isFallback */) as unknown as AIOrchestrationService;
    const service = new OnboardingService(orchestrator);

    const result = await service.processConversation({
      conversationId: CONVERSATION_ID,
      userId:         USER_ID,
      messages:       SAMPLE_MESSAGES,
    });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('llm_fallback');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('returns { success: false, failureReason: llm_fallback } when orchestrator throws', async () => {
    const orchestrator = {
      complete: jest.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as AIOrchestrationService;
    const service = new OnboardingService(orchestrator);

    const result = await service.processConversation({
      conversationId: CONVERSATION_ID,
      userId:         USER_ID,
      messages:       SAMPLE_MESSAGES,
    });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('llm_fallback');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('returns { success: false, failureReason: schema_invalid } when LLM returns non-JSON', async () => {
    const orchestrator = makeOrchestrator('Sorry, I cannot do that.') as unknown as AIOrchestrationService;
    const service = new OnboardingService(orchestrator);

    const result = await service.processConversation({
      conversationId: CONVERSATION_ID,
      userId:         USER_ID,
      messages:       SAMPLE_MESSAGES,
    });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('schema_invalid');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects memory_level: 99 as schema_invalid (edge-case from TDD §11.2)', async () => {
    const orchestrator = makeOrchestrator(INVALID_MEMORY_LEVEL_JSON) as unknown as AIOrchestrationService;
    const service = new OnboardingService(orchestrator);

    const result = await service.processConversation({
      conversationId: CONVERSATION_ID,
      userId:         USER_ID,
      messages:       SAMPLE_MESSAGES,
    });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('schema_invalid');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects an invalid inferred_comm_style as schema_invalid', async () => {
    const orchestrator = makeOrchestrator(INVALID_COMM_STYLE_JSON) as unknown as AIOrchestrationService;
    const service = new OnboardingService(orchestrator);

    const result = await service.processConversation({
      conversationId: CONVERSATION_ID,
      userId:         USER_ID,
      messages:       SAMPLE_MESSAGES,
    });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('schema_invalid');
  });

  it('returns { success: false, failureReason: db_error } when the transaction fails', async () => {
    // Make the transaction throw
    (db.transaction as jest.Mock).mockRejectedValueOnce(new Error('DB connection lost'));

    const orchestrator = makeOrchestrator(VALID_EXTRACTION_JSON) as unknown as AIOrchestrationService;
    const service = new OnboardingService(orchestrator);

    const result = await service.processConversation({
      conversationId: CONVERSATION_ID,
      userId:         USER_ID,
      messages:       SAMPLE_MESSAGES,
    });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('db_error');
  });

  it('does not throw — always resolves even when everything fails', async () => {
    (db.transaction as jest.Mock).mockRejectedValue(new Error('Total failure'));
    const orchestrator = makeOrchestrator(VALID_EXTRACTION_JSON) as unknown as AIOrchestrationService;
    const service = new OnboardingService(orchestrator);

    await expect(
      service.processConversation({
        conversationId: CONVERSATION_ID,
        userId:         USER_ID,
        messages:       SAMPLE_MESSAGES,
      }),
    ).resolves.not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selectPrompt routing (via orchestrator mode)
// ─────────────────────────────────────────────────────────────────────────────

describe('OnboardingService — prompt mode routing', () => {
  it('always calls orchestrator with mode=extraction regardless of onboarding_done', async () => {
    const orchestrator = makeOrchestrator(VALID_EXTRACTION_JSON) as unknown as AIOrchestrationService;
    const service = new OnboardingService(orchestrator);

    await service.processConversation({
      conversationId: CONVERSATION_ID,
      userId:         USER_ID,
      messages:       SAMPLE_MESSAGES,
    });

    expect(orchestrator.complete).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'extraction' }),
    );
  });
});
