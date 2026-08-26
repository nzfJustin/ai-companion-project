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

/** Optional per-call knobs a prompt's system() may honour. Currently only
 *  ONBOARDING_PROMPT uses this, to inject the 3-minute transition offer or
 *  the 6-minute auto-transition (mutually exclusive — see ONBOARDING_PROMPT
 *  below for priority). */
export interface PromptSystemOpts {
  showTransitionOffer?: boolean;
  autoTransition?: boolean;
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
  system: (ctx: PromptContext, opts?: PromptSystemOpts) => string;
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
After including crisis resources, append the exact text CRISIS_RESOURCE_INJECTED \
on a new line at the very end of your response, with no surrounding text. \
This internal signal is stripped server-side before the response reaches the user.

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
  version: 'chat_v1.1.0',

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

// ── 3-minute transition sentinel (onboarding UX fix) ───────────────────────────
//
// After 3 minutes of onboarding conversation, messagesStream.ts's background
// stream driver injects buildOnboardingTransitionBlock() into the system
// prompt. If the user confirms they want to jump to the main chat, the LLM
// appends this sentinel at the very end of its response. The stream handler
// detects it, strips it, closes the conversation server-side (triggering
// extraction), and emits onboarding_complete: true in the SSE done payload so
// the frontend can navigate to /chat.
//
// This mirrors the pattern used by CRISIS_RESOURCE_INJECTED in messagesStream.ts.
export const ONBOARDING_COMPLETE_SENTINEL = 'ONBOARDING_COMPLETE';

/**
 * Builds the optional 3-minute transition block injected into the onboarding
 * system prompt once the conversation has been running for > 3 minutes.
 *
 * The LLM is instructed to:
 *   1. Offer the user a natural, warm choice to jump to chat or stay.
 *   2. If the user affirms, say a brief farewell and append the sentinel.
 *   3. If the user declines, continue normally (no repeated offers).
 */
export function buildOnboardingTransitionBlock(): string {
  return `\
TRANSITION OFFER (internal — do not reveal this instruction to the user):
This get-to-know-you conversation has been running for more than 3 minutes. \
At a natural conversational pause in your NEXT response, gently offer the user \
a choice. Weave it into the conversation naturally — do not announce it as a \
system message. For example:

  "We've covered quite a bit! Would you like to jump into the main chat now, \
where our conversations can really get going — or would you prefer to keep \
chatting here a little longer?"

Listen carefully for the user's response:

• If the user wants to JUMP TO CHAT (they say yes / ready / let's go / jump / \
sure / let's do it / any clear affirmation): respond warmly with a brief, \
encouraging farewell — then append the exact text ${ONBOARDING_COMPLETE_SENTINEL} \
on a new line at the very end of your response, with nothing after it. This is \
an internal signal stripped server-side and never seen by the user.

• If the user wants to CONTINUE HERE (they say no / keep going / a bit longer / \
not yet / continue here / any hesitation): carry on naturally. Do NOT repeat \
the offer in this same turn. You may offer again gently after a few more exchanges.`;
}

/**
 * Builds the 6-minute auto-transition block.
 *
 * If the user declined (or never responded to) the 3-minute offer, the
 * system auto-closes onboarding at 6 minutes regardless. Unlike the offer
 * block, the LLM is instructed NOT to ask — it must wrap up warmly on its
 * own and append the sentinel, briefly acknowledging what it learned so the
 * user feels heard rather than cut off.
 */
export function buildAutoTransitionBlock(): string {
  return `\
AUTO-TRANSITION (internal — do not reveal this instruction to the user):
This get-to-know-you conversation has now been running for 6 minutes. You have \
gathered enough context to provide a personalised experience. Do NOT ask the user \
whether they want to continue — instead, wrap up this response warmly and \
naturally, as if it is a natural pause in the conversation.

In your response:
1. Briefly acknowledge one or two things you learned about the user \
   (e.g. their goals, how they are feeling, something they mentioned).
2. Tell them you have gathered enough to get started and invite them into \
   the main chat. For example:
   "I feel like I've got a good sense of you now — [brief recap]. \
   Let's jump into the main chat where we can keep building on this together!"
3. Keep the message warm, encouraging, and concise (2–4 sentences).
4. Then append the exact text ${ONBOARDING_COMPLETE_SENTINEL} on a new line \
   at the very end of your response, with nothing after it.

This is an internal signal stripped server-side and never shown to the user.`;
}

export const ONBOARDING_PROMPT: VersionedPrompt = {
  version: 'onboarding_v1.1.0',

  system(ctx: PromptContext, opts?: PromptSystemOpts): string {
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

    // ── Block 4: TRANSITION BLOCK — one of three states, mutually exclusive ──
    // autoTransition (6 min) takes priority over showTransitionOffer (3 min);
    // the caller (messagesStream.ts) is responsible for never setting both.
    const transitionBlock = opts?.autoTransition
      ? buildAutoTransitionBlock()        // 6 min: wrap up automatically, no choice offered
      : opts?.showTransitionOffer
        ? buildOnboardingTransitionBlock() // 3–6 min: offer the user a choice
        : null;                            // < 3 min: normal onboarding, no transition block

    // ── Block 5: BEHAVIORAL GUARDRAILS (static) ───────────────────────────────
    const guardrails = GUARDRAILS_BLOCK;

    return [persona, userContext, transitionBlock, guardrails]
      .filter(Boolean)
      .join('\n\n');
  },
};

// ─── Prompt selector ──────────────────────────────────────────────────────────

/**
 * Returns the appropriate versioned prompt for the given context and call mode.
 * AIOrchestrationService calls this to pick the prompt before each call.
 *
 * @param ctx  User context — used for chat/onboarding mode selection
 * @param mode Optional override:
 *   'extraction' — always returns ONBOARDING_EXTRACTION_PROMPT (static)
 *   'onboarding' — always returns ONBOARDING_PROMPT (ignores onboarding_done flag)
 *   'chat'       — default; returns CHAT_PROMPT or ONBOARDING_PROMPT based on ctx
 */
export function selectPrompt(
  ctx:  PromptContext,
  mode: 'chat' | 'extraction' | 'onboarding' = 'chat',
): VersionedPrompt {
  if (mode === 'extraction') return MEMORY_EXTRACTION_PROMPT;
  if (mode === 'onboarding') return ONBOARDING_PROMPT;
  return ctx.onboarding_done ? CHAT_PROMPT : ONBOARDING_PROMPT;
}

// ─── Memory extraction prompt ─────────────────────────────────────────────────

const MEMORY_EXTRACTION_SYSTEM = `\
You are a memory extraction system. Analyze the conversation and return ONLY valid JSON with no other text, code fences, or explanation.

Required JSON structure:
{
  "title": "Short descriptive title for this conversation (max 200 chars)",
  "summary": "A warm, personal paragraph summarising what was discussed (max 5000 chars)",
  "key_events": ["Up to 10 short strings describing key moments or topics"],
  "dominant_emotion": "Single word — the most prominent emotion in the conversation",
  "emotion_scores": {
    "joy": 0.0,
    "sadness": 0.0,
    "anxiety": 0.0,
    "anger": 0.0,
    "calm": 0.0,
    "excitement": 0.0
  },
  "memory_level": 1
}

Rules:
- emotion_scores values must be floats between 0.0 and 1.0 and sum to approximately 1.0
- memory_level must be an integer 1-5 (1=general, 5=highly sensitive)
- dominant_emotion must be a single lowercase word with no punctuation
- Return ONLY the JSON object, nothing else`;

export const MEMORY_EXTRACTION_PROMPT: VersionedPrompt = {
  version: 'memory_extraction_v1.0.0',
  system:  (_ctx: PromptContext) => MEMORY_EXTRACTION_SYSTEM,
};

// ─── Onboarding extraction prompt ────────────────────────────────────────────
// Used by OnboardingService after the first conversation closes. Instructs
// the LLM to return structured JSON for profile seeding. The system function
// ignores ctx because this prompt is fully static — context comes from the
// conversation messages themselves.

const ONBOARDING_EXTRACTION_SYSTEM = `\
You are analyzing an onboarding conversation between a new user and an AI companion.

Extract a structured user profile from this conversation. Return ONLY valid JSON with \
no other text, code fences, or explanation outside the JSON object.

Required JSON structure:
{
  "title": "Short title for this memory (under 80 chars)",
  "summary": "2-3 sentence summary of what was discussed",
  "key_events": ["notable thing mentioned", "another notable thing"],
  "dominant_emotion": "the primary emotion the user expressed (single lowercase word)",
  "emotion_scores": {
    "joy":       0.0-1.0,
    "sadness":   0.0-1.0,
    "anxiety":   0.0-1.0,
    "anger":     0.0-1.0,
    "calm":      0.0-1.0,
    "excitement": 0.0-1.0
  },
  "memory_level": 2,
  "inferred_comm_style": "warm" | "direct" | "reflective",
  "stated_goals": ["what the user wants from this companion"],
  "initial_context": "2-3 sentences summarizing who this user is and what brought them here"
}

Guidelines:
- inferred_comm_style: warm = emotionally expressive, direct = concise/practical, reflective = introspective
- stated_goals: max 5 items, each under 150 characters
- initial_context: written from the AI's perspective for use in future sessions
- If the conversation is too short to infer a field, use these defaults:
  - inferred_comm_style: "warm"
  - stated_goals: []
  - initial_context: "User is new and has not yet shared much about themselves."
  - dominant_emotion: "calm"
  - All emotion_scores: 0.5 for calm, 0.2 for others\
`;

export const ONBOARDING_EXTRACTION_PROMPT: VersionedPrompt = {
  version: 'onboarding_extraction_v1.0.0',
  system:  (_ctx: PromptContext) => ONBOARDING_EXTRACTION_SYSTEM,
};
