/**
 * src/ai/prompts/index.ts
 *
 * ALL prompt templates live here and nowhere else (TDD P1-009).
 * Each prompt is a versioned constant with the shape:
 *   { version: string, system: (ctx: PromptContext) => string }
 *
 * The assembled system prompt contains four blocks in order:
 *   1. PERSONA              — static, marked cacheable in Phase 2
 *   2. USER CONTEXT         — dynamic per user (display_name, comm_style, etc.)
 *   3. RELEVANT MEMORY      — empty string in Phase 1; Phase 2 injects snippets
 *   4. BEHAVIORAL GUARDRAILS — static, marked cacheable in Phase 2
 *
 * Prompt versioning lets us roll back a bad prompt without a code audit:
 * every LLM call logs the version string alongside token counts, so we
 * can correlate quality regressions to specific prompt changes.
 *
 * ─── Changing a prompt ────────────────────────────────────────────────────────
 * 1. Bump the version string (semver: breaking change → major, new field → minor,
 *    copy tweak → patch).
 * 2. Update the golden-set fixture that covers the changed behaviour.
 * 3. Run `npm run golden-set` to verify against the live API before merging.
 */

// ─── PromptContext ─────────────────────────────────────────────────────────────

export interface PromptContext {
  /** User's display name — sanitized before interpolation */
  display_name: string;
  /** IANA timezone string (e.g. "America/New_York") */
  timezone: string;
  /** Communication style preference that shapes tone */
  comm_style: 'warm' | 'direct' | 'reflective';
  /**
   * Accumulated summary of what the AI knows about this user from prior
   * sessions. Null for new users and on their first session.
   */
  context_summary: string | null;
  /** Whether the user has completed the onboarding conversation */
  onboarding_done: boolean;
  /**
   * Relevant memory snippets retrieved for this conversation.
   * Phase 1: always empty string.
   * Phase 2: AIOrchestrationService injects retrieved memories here.
   */
  relevant_memory?: string;
}

export interface VersionedPrompt {
  /** Semver version string logged with every LLM call, e.g. "chat_v1.0.0" */
  version: string;
  /**
   * Assembles the full system prompt from the given context.
   * Returns a single string in Phase 1; Phase 2 will change the return
   * type to SystemBlock[] to enable Anthropic prompt caching on the two
   * static blocks (PERSONA and BEHAVIORAL GUARDRAILS).
   */
  system: (ctx: PromptContext) => string;
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

/**
 * Strips characters that could alter prompt behaviour if user-controlled
 * strings are interpolated into templates.
 *
 * Allowed: letters, numbers, spaces, hyphens, apostrophes, periods,
 *          commas, exclamation marks, question marks, underscores.
 * Stripped: semicolons, angle brackets, curly braces, backticks, quotes,
 *           newlines — anything that could inject new instructions or
 *           break template structure.
 *
 * @param text       Raw user-supplied string
 * @param maxLength  Hard cap on the output length (default: 100)
 */
export function sanitizeForPrompt(text: string, maxLength = 100): string {
  return text
    .replace(/[^a-zA-Z0-9 '\-.,!?_/]/g, '')
    .trim()
    .slice(0, maxLength);
}

// ─── Static prompt blocks ─────────────────────────────────────────────────────
// Defined as module-level constants so they are computed once at startup,
// not on every call. Phase 2 will attach cache_control: { type: 'ephemeral' }
// to these blocks when the return type becomes SystemBlock[].

const PERSONA_BLOCK = `\
You are an AI companion designed to help people reflect on their emotions, \
process daily experiences, and build self-understanding over time.

You are not a therapist, crisis counsellor, or medical professional. You are \
a compassionate, attentive listener who helps users make sense of their inner \
world through conversation.

Core principles:
- Listen actively and reflect back what you hear before offering perspective
- Ask one thoughtful follow-up question at a time — avoid rapid-fire questioning
- Reference what you remember about the user meaningfully, not mechanically
- Meet users where they are emotionally — do not rush toward resolution
- Be genuine and warm — avoid clinical or performative language\
`;

const ONBOARDING_PERSONA_BLOCK = `\
You are meeting a new user for the first time. Your goal in this conversation \
is to make them feel genuinely welcomed, understand what brought them here, \
and learn enough about them to personalise future conversations.

Be curious and warm. Ask open-ended questions. Listen more than you advise. \
By the end of the conversation you should have a sense of:
- What is weighing on them right now
- What they are hoping to get from this companion
- Their general communication preferences (do they prefer emotional support, \
  practical reflection, or thoughtful exploration?)

Keep the tone light and welcoming — this is not an intake form, it is a \
first conversation with a new friend.\
`;

const GUARDRAILS_BLOCK = `\
Important boundaries you must always respect:

CRISIS SUPPORT: If a user expresses thoughts of self-harm, suicide, or \
immediate danger to themselves or others, always acknowledge their feelings \
with compassion and include crisis resources:
  - National Suicide Prevention Lifeline: call or text 988
  - Crisis Text Line: text HOME to 741741
Do this before anything else and regardless of the conversation topic.

SCOPE: You do not diagnose mental health conditions, prescribe treatments, \
or recommend specific medications. If a user needs professional support, \
encourage them to seek it — do not position yourself as a replacement.

SAFETY: Do not engage with requests to roleplay self-harm, violence, or \
illegal activity, even framed as hypothetical.

PRIVACY: Do not surface sensitive details from past sessions unless they are \
directly relevant and the user has implicitly invited the reference.

LENGTH: Keep responses focused — typically 2–4 sentences unless the user \
asks for more or the emotional weight of the moment calls for it.\
`;

// ─── Comm-style tone descriptors ──────────────────────────────────────────────

const COMM_STYLE_DESCRIPTOR: Record<PromptContext['comm_style'], string> = {
  warm:       'warm, empathetic, and emotionally expressive',
  direct:     'clear, direct, and concise — supportive but not effusive',
  reflective: 'thoughtful and reflective — you often mirror language back and invite deeper exploration',
};

// ─── Chat prompt (standard, post-onboarding) ──────────────────────────────────

export const CHAT_PROMPT: VersionedPrompt = {
  version: 'chat_v1.0.0',

  system(ctx: PromptContext): string {
    // Sanitize all user-supplied strings before interpolation.
    // comm_style is an enum from our schema and already safe, but we
    // sanitize it too as a defence-in-depth measure.
    const name        = sanitizeForPrompt(ctx.display_name, 100);
    const commStyle   = sanitizeForPrompt(ctx.comm_style, 50);
    const timezone    = sanitizeForPrompt(ctx.timezone, 60);
    const styleDesc   = COMM_STYLE_DESCRIPTOR[ctx.comm_style as PromptContext['comm_style']]
                        ?? sanitizeForPrompt(commStyle, 50);

    // ── Block 1: PERSONA (static) ─────────────────────────────────────────────
    const persona = PERSONA_BLOCK;

    // ── Block 2: USER CONTEXT (dynamic) ──────────────────────────────────────
    const contextLines: string[] = [
      `The user's name is ${name}.`,
      `Their timezone is ${timezone}.`,
      `Your communication style with them should be ${styleDesc}.`,
    ];

    if (ctx.context_summary) {
      contextLines.push(
        `\nWhat you already know about ${name}:\n${ctx.context_summary}`,
      );
    } else {
      contextLines.push(
        `\nThis is an early session — you do not yet have a detailed profile for ${name}. \
Ask questions and listen carefully to build one over time.`,
      );
    }

    const userContext = contextLines.join('\n');

    // ── Block 3: RELEVANT MEMORY (Phase 1: empty) ─────────────────────────────
    // Phase 2: AIOrchestrationService injects retrieved memory snippets here.
    const relevantMemory = ctx.relevant_memory ?? '';

    // ── Block 4: BEHAVIORAL GUARDRAILS (static) ───────────────────────────────
    const guardrails = GUARDRAILS_BLOCK;

    // Assemble — blocks separated by blank lines for readability
    return [
      persona,
      userContext,
      ...(relevantMemory ? [relevantMemory] : []),
      guardrails,
    ].join('\n\n');
  },
};

// ─── Onboarding prompt ────────────────────────────────────────────────────────
// Used by AIOrchestrationService when users.onboarding_done = false.
// The ONBOARDING_PERSONA_BLOCK replaces the standard PERSONA_BLOCK;
// USER CONTEXT and GUARDRAILS remain the same.

export const ONBOARDING_PROMPT: VersionedPrompt = {
  version: 'onboarding_v1.0.0',

  system(ctx: PromptContext): string {
    const name      = sanitizeForPrompt(ctx.display_name, 100);
    const timezone  = sanitizeForPrompt(ctx.timezone, 60);

    // ── Block 1: ONBOARDING PERSONA (static) ──────────────────────────────────
    const persona = ONBOARDING_PERSONA_BLOCK;

    // ── Block 2: USER CONTEXT (minimal — we don't know them yet) ─────────────
    const userContext = [
      `The user's name is ${name}.`,
      `Their timezone is ${timezone}.`,
      'You do not yet have a communication-style preference for this user — ' +
      'infer one from how they write during this conversation.',
    ].join('\n');

    // ── Block 3: RELEVANT MEMORY (always empty during onboarding) ────────────
    // (no memory injection on first session)

    // ── Block 4: BEHAVIORAL GUARDRAILS (static) ───────────────────────────────
    const guardrails = GUARDRAILS_BLOCK;

    return [persona, userContext, guardrails].join('\n\n');
  },
};

// ─── Prompt selector ──────────────────────────────────────────────────────────

/**
 * Returns the appropriate versioned prompt for the given context.
 * AIOrchestrationService calls this to pick the prompt before each call.
 */
export function selectPrompt(ctx: PromptContext): VersionedPrompt {
  return ctx.onboarding_done ? CHAT_PROMPT : ONBOARDING_PROMPT;
}
