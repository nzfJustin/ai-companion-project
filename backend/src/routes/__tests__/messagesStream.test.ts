/**
 * src/routes/__tests__/messagesStream.test.ts
 *
 * Unit tests for the T-007 crisis sentinel + onboarding-transition helpers,
 * and the driveOrchestrationStream/attachToSession mechanics they live
 * alongside, used by conversations.router.ts's POST /:id/messages
 * streaming handler.
 *
 * See messages.test.ts for the end-to-end SSE integration tests (sentinel
 * never reaches the client, crisis_flag is logged, the persisted message
 * is sentinel-free) driven through the real Express route.
 */

// ─── Mocks (hoisted) ────────────────────────────────────────────────────────

const mockTransaction = jest.fn();
jest.mock('../../db', () => ({
  db: { transaction: mockTransaction },
}));

const mockStream = jest.fn();
jest.mock('../../ai/instance', () => ({
  aiOrchestrationService: { stream: mockStream },
}));

const mockAppendToContextCache = jest.fn().mockResolvedValue(undefined);
jest.mock('../../lib/conversationContextCache', () => ({
  appendToContextCache: mockAppendToContextCache,
}));

const mockDetectEmotion = jest.fn().mockReturnValue({ primary: 'calm', score: 0.5 });
jest.mock('../../services/EmotionDetector', () => ({
  detectEmotion: mockDetectEmotion,
}));

// A bare `jest.mock('../../services/EncryptionService')` automock would
// replace encrypt()/decrypt() with jest.fn()s that return undefined by
// default — driveOrchestrationStream destructures encrypt()'s return
// value, so that would throw on every test. Provide real-shaped defaults,
// matching the convention already used in conversations.test.ts.
jest.mock('../../services/EncryptionService', () => ({
  EncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: jest.fn().mockReturnValue({ ciphertext: Buffer.from('enc'), iv: Buffer.alloc(12) }),
    decrypt: jest.fn().mockReturnValue('decrypted content'),
  })),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import type { Response } from 'express';
import {
  withTokenTimeout,
  TokenTimeoutError,
  writeSseEvent,
  setSseHeaders,
  driveOrchestrationStream,
  attachToSession,
  CRISIS_SENTINEL,
  stripCrisisSentinel,
  ONBOARDING_COMPLETE_SENTINEL,
  stripOnboardingSentinel,
  buildOnboardingTransitionBlock,
  buildAutoTransitionBlock,
} from '../v1/messagesStream';
import { aiOrchestrationService } from '../../ai/instance';
import { StreamSession } from '../../lib/streamSessionRegistry';
import { EncryptionService } from '../../services/EncryptionService';

// ─── Fake Response ────────────────────────────────────────────────────────────

function makeFakeResponse() {
  const written: string[] = [];
  const headers: Record<string, string> = {};
  const closeListeners: Array<() => void> = [];
  let ended = false;
  let statusCode = 200;

  const res = {
    write: (chunk: string) => { written.push(chunk); return true; },
    end:   () => { ended = true; },
    status: (code: number) => { statusCode = code; return res; },
    setHeader: (name: string, value: string) => { headers[name] = value; },
    flushHeaders: jest.fn(),
    on: (event: string, cb: () => void) => {
      if (event === 'close') closeListeners.push(cb);
    },
  };

  return {
    res: res as unknown as Response,
    written,
    headers,
    get ended() { return ended; },
    get statusCode() { return statusCode; },
    emitClose: () => closeListeners.forEach((cb) => cb()),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDetectEmotion.mockReturnValue({ primary: 'calm', score: 0.5 });
  delete process.env.ONBOARDING_OFFER_MS_OVERRIDE;
  delete process.env.ONBOARDING_AUTO_MS_OVERRIDE;
});

// ─────────────────────────────────────────────────────────────────────────────
// withTokenTimeout
// ─────────────────────────────────────────────────────────────────────────────

describe('withTokenTimeout', () => {
  it('resolves normally when the promise settles before the timeout', async () => {
    const result = await withTokenTimeout(Promise.resolve('value'), 1000);
    expect(result).toBe('value');
  });

  it('rejects with TokenTimeoutError when the promise takes too long', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('too late'), 100));
    await expect(withTokenTimeout(slow, 10)).rejects.toThrow(TokenTimeoutError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writeSseEvent / setSseHeaders
// ─────────────────────────────────────────────────────────────────────────────

describe('writeSseEvent', () => {
  it('writes event, data, and a trailing blank line', () => {
    const { res, written } = makeFakeResponse();
    writeSseEvent(res, 'token', { delta: 'Hi' });
    expect(written[0]).toBe('event: token\ndata: {"delta":"Hi"}\n\n');
  });

  it('includes an id: line when an id is provided', () => {
    const { res, written } = makeFakeResponse();
    writeSseEvent(res, 'token', { delta: 'Hi' }, 5);
    expect(written[0]).toBe('id: 5\nevent: token\ndata: {"delta":"Hi"}\n\n');
  });

  it('omits the id: line when no id is provided', () => {
    const { res, written } = makeFakeResponse();
    writeSseEvent(res, 'done', { message_id: 'm1', emotion_tags: { primary: 'calm', score: 0.5 } });
    expect(written[0]).not.toContain('id:');
  });
});

describe('setSseHeaders', () => {
  it('sets the correct Content-Type and Cache-Control headers', () => {
    const { res, headers } = makeFakeResponse();
    setSseHeaders(res);
    expect(headers['Content-Type']).toBe('text/event-stream');
    expect(headers['Cache-Control']).toBe('no-cache, no-transform');
    expect(headers['Connection']).toBe('keep-alive');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// driveOrchestrationStream — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('driveOrchestrationStream — success', () => {
  function setupSuccessfulTransaction(messageId = 'assistant-msg-1') {
    mockTransaction.mockImplementation(async (cb) => {
      const tx = {
        insert: () => ({
          values: () => ({
            returning: async () => [{ id: messageId }],
          }),
        }),
        update: () => ({
          set: () => ({
            where: async () => undefined,
          }),
        }),
      };
      return cb(tx);
    });
  }

  it('pushes each yielded token to the session', async () => {
    mockStream.mockImplementation(async function* () {
      yield 'Hello';
      yield ', world!';
    });
    setupSuccessfulTransaction();

    const session = new StreamSession('conv-1');
    const received: string[] = [];
    session.on('token', (t) => received.push(t.delta));

    await driveOrchestrationStream({
      session,
      conversationId: 'conv-1',
      userId: 'user-1',
      contextMessages: [{ role: 'user', content: 'Hi' }],
      userProfile: {
        displayName: 'Alice', timezone: 'UTC', commStyle: 'warm',
        onboardingDone: true, contextSummary: null,
      },
      encryptionService: new EncryptionService('user-1'),
    });

    expect(received).toEqual(['Hello', ', world!']);
  });

  it('calls session.finishDone with messageId and emotionTags on success', async () => {
    mockStream.mockImplementation(async function* () {
      yield 'Hi there!';
    });
    setupSuccessfulTransaction('assistant-msg-42');
    mockDetectEmotion.mockReturnValue({ primary: 'joy', score: 0.8 });

    const session = new StreamSession('conv-1');
    const doneHandler = jest.fn();
    session.on('done', doneHandler);

    await driveOrchestrationStream({
      session,
      conversationId: 'conv-1',
      userId: 'user-1',
      contextMessages: [],
      userProfile: {
        displayName: '', timezone: 'UTC', commStyle: 'warm',
        onboardingDone: true, contextSummary: null,
      },
      encryptionService: new EncryptionService('user-1'),
    });

    expect(session.status).toBe('done');
    expect(doneHandler).toHaveBeenCalledWith({
      messageId: 'assistant-msg-42',
      emotionTags: { primary: 'joy', score: 0.8 },
    });
  });

  it('appends the assistant message to the context cache after persisting', async () => {
    mockStream.mockImplementation(async function* () {
      yield 'Full response text';
    });
    setupSuccessfulTransaction();

    const session = new StreamSession('conv-1');
    await driveOrchestrationStream({
      session,
      conversationId: 'conv-1',
      userId: 'user-1',
      contextMessages: [],
      userProfile: {
        displayName: '', timezone: 'UTC', commStyle: 'warm',
        onboardingDone: true, contextSummary: null,
      },
      encryptionService: new EncryptionService('user-1'),
    });

    expect(mockAppendToContextCache).toHaveBeenCalledWith('conv-1', {
      role: 'assistant',
      content: 'Full response text',
    });
  });

  it('calls aiOrchestrationService.stream with mode "chat" and the given context', async () => {
    mockStream.mockImplementation(async function* () {
      yield 'reply';
    });
    setupSuccessfulTransaction();

    const session = new StreamSession('conv-1');
    const contextMessages = [{ role: 'user' as const, content: 'previous message' }];

    await driveOrchestrationStream({
      session,
      conversationId: 'conv-1',
      userId: 'user-1',
      contextMessages,
      userProfile: {
        displayName: 'Bob', timezone: 'UTC', commStyle: 'direct',
        onboardingDone: true, contextSummary: null,
      },
      encryptionService: new EncryptionService('user-1'),
    });

    expect(mockStream).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'chat', messages: contextMessages }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// driveOrchestrationStream — failure paths
// ─────────────────────────────────────────────────────────────────────────────

describe('driveOrchestrationStream — failure paths', () => {
  it('calls session.finishError with LLM_STREAM_ERROR on a mid-stream provider error', async () => {
    mockStream.mockImplementation(async function* () {
      yield 'partial response ';
      throw new Error('Provider connection reset');
    });

    const session = new StreamSession('conv-1');
    const errorHandler = jest.fn();
    session.on('error', errorHandler);

    await driveOrchestrationStream({
      session,
      conversationId: 'conv-1',
      userId: 'user-1',
      contextMessages: [],
      userProfile: {
        displayName: '', timezone: 'UTC', commStyle: 'warm',
        onboardingDone: true, contextSummary: null,
      },
      encryptionService: new EncryptionService('user-1'),
    });

    expect(session.status).toBe('error');
    expect(errorHandler).toHaveBeenCalledWith({ code: 'LLM_STREAM_ERROR' });
  });

  it('does NOT persist a partial response when the stream fails mid-way', async () => {
    mockStream.mockImplementation(async function* () {
      yield 'partial response ';
      throw new Error('Provider connection reset');
    });

    const session = new StreamSession('conv-1');

    await driveOrchestrationStream({
      session,
      conversationId: 'conv-1',
      userId: 'user-1',
      contextMessages: [],
      userProfile: {
        displayName: '', timezone: 'UTC', commStyle: 'warm',
        onboardingDone: true, contextSummary: null,
      },
      encryptionService: new EncryptionService('user-1'),
    });

    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('calls session.finishError with LLM_TIMEOUT when a token-gap timeout occurs', async () => {
    // Generator whose second token never arrives — a promise that never
    // resolves, not merely a long-but-bounded delay. A bounded delay (even
    // one shorter than the 20s gap timeout) races against
    // advanceTimersByTimeAsync unpredictably: whichever fake timer has the
    // shorter delay fires first once time is advanced past both, so a
    // generator that resolves on its own would let the stream complete
    // normally instead of exercising the timeout path this test is for.
    mockStream.mockImplementation(async function* () {
      yield 'first token';
      await new Promise(() => { /* never resolves */ });
      yield 'never reached';
    });

    const session = new StreamSession('conv-1');
    const errorHandler = jest.fn();
    session.on('error', errorHandler);

    jest.useFakeTimers();

    const drivePromise = driveOrchestrationStream({
      session,
      conversationId: 'conv-1',
      userId: 'user-1',
      contextMessages: [],
      userProfile: {
        displayName: '', timezone: 'UTC', commStyle: 'warm',
        onboardingDone: true, contextSummary: null,
      },
      encryptionService: new EncryptionService('user-1'),
    });

    // advanceTimersByTimeAsync (not the sync advanceTimersByTime) is needed
    // here: the mock generator's internal setTimeout isn't created until
    // driveOrchestrationStream's second gen.next() call resolves, which
    // itself depends on a chain of microtasks from the first token being
    // processed. The async variant flushes microtasks between each fired
    // timer, so it reliably reaches and fires that later-created timer too
    // — a sync advance (plus a fixed handful of `await Promise.resolve()`
    // ticks beforehand) is timing-dependent and flakes.
    await jest.advanceTimersByTimeAsync(20_001);

    await drivePromise;

    expect(session.status).toBe('error');
    expect(errorHandler).toHaveBeenCalledWith({ code: 'LLM_TIMEOUT' });

    jest.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// attachToSession
// ─────────────────────────────────────────────────────────────────────────────

describe('attachToSession', () => {
  it('replays all buffered tokens when fromEventId is 0', () => {
    const session = new StreamSession('conv-1');
    session.pushToken('Hello');
    session.pushToken(' world');

    const { res, written } = makeFakeResponse();
    attachToSession(res, session, 0);

    expect(written).toHaveLength(2);
    expect(written[0]).toContain('"delta":"Hello"');
    expect(written[1]).toContain('"delta":" world"');
  });

  it('replays only tokens after the given fromEventId (reconnect scenario)', () => {
    const session = new StreamSession('conv-1');
    session.pushToken('one');   // id 1
    session.pushToken('two');   // id 2
    session.pushToken('three'); // id 3

    const { res, written } = makeFakeResponse();
    attachToSession(res, session, 1); // client already saw id 1

    expect(written).toHaveLength(2);
    expect(written[0]).toContain('"delta":"two"');
    expect(written[1]).toContain('"delta":"three"');
  });

  it('immediately sends the done event and ends if the session is already done', () => {
    const session = new StreamSession('conv-1');
    session.pushToken('Hi');
    session.finishDone({ messageId: 'm1', emotionTags: { primary: 'calm', score: 0.5 } });

    // `ended` is a getter on the object makeFakeResponse() returns — read it
    // via the object AFTER attachToSession runs, not by destructuring it
    // early, which would snapshot its (still-false) value at that instant.
    const helper = makeFakeResponse();
    attachToSession(helper.res, session, 1);

    expect(helper.written.some((w) => w.includes('event: done'))).toBe(true);
    expect(helper.ended).toBe(true);
  });

  it('immediately sends the error event and ends if the session already errored', () => {
    const session = new StreamSession('conv-1');
    session.finishError({ code: 'LLM_TIMEOUT' });

    const helper = makeFakeResponse();
    attachToSession(helper.res, session, 0);

    expect(helper.written.some((w) => w.includes('event: error'))).toBe(true);
    expect(helper.written.some((w) => w.includes('LLM_TIMEOUT'))).toBe(true);
    expect(helper.ended).toBe(true);
  });

  it('forwards live tokens that arrive after attachment', () => {
    const session = new StreamSession('conv-1');
    const { res, written } = makeFakeResponse();

    attachToSession(res, session, 0);
    session.pushToken('live token');

    expect(written.some((w) => w.includes('"delta":"live token"'))).toBe(true);
  });

  it('ends the response and stops listening once done fires live', () => {
    const session = new StreamSession('conv-1');
    const helper = makeFakeResponse(); // see note above on why `ended` isn't destructured early

    attachToSession(helper.res, session, 0);
    session.finishDone({ messageId: 'm1', emotionTags: { primary: 'calm', score: 0.5 } });

    expect(helper.written.some((w) => w.includes('event: done'))).toBe(true);
    expect(helper.ended).toBe(true);

    // Further token pushes after done should not write anything new
    const countBefore = helper.written.length;
    session.pushToken('should not be written');
    expect(helper.written.length).toBe(countBefore);
  });

  it('detaches listeners on client disconnect (res "close") without ending the session', () => {
    const session = new StreamSession('conv-1');
    const { res, written, emitClose } = makeFakeResponse();

    attachToSession(res, session, 0);
    emitClose(); // simulate client disconnect

    const countAfterClose = written.length;
    session.pushToken('after disconnect');

    // No new writes to this (dead) response after close
    expect(written.length).toBe(countAfterClose);
    // But the session itself is unaffected — still in progress
    expect(session.status).toBe('in_progress');
  });

  it('includes onboarding_complete: true in the done frame when the session set it', () => {
    const session = new StreamSession('conv-1');
    session.finishDone({
      messageId: 'm1',
      emotionTags: { primary: 'calm', score: 0.5 },
      onboardingComplete: true,
    });

    const { res, written } = makeFakeResponse();
    attachToSession(res, session, 0);

    const doneFrame = written.find((w) => w.includes('event: done'));
    expect(doneFrame).toContain('"onboarding_complete":true');
  });

  it('omits onboarding_complete from the done frame when unset', () => {
    const session = new StreamSession('conv-1');
    session.finishDone({ messageId: 'm1', emotionTags: { primary: 'calm', score: 0.5 } });

    const { res, written } = makeFakeResponse();
    attachToSession(res, session, 0);

    const doneFrame = written.find((w) => w.includes('event: done'));
    expect(doneFrame).not.toContain('onboarding_complete');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T-007 — Crisis sentinel stripping
// ─────────────────────────────────────────────────────────────────────────────

describe('stripCrisisSentinel', () => {
  it('detects and strips the sentinel from the end of a response', () => {
    const input = `I hear how much pain you're in. Please reach out to 988.\n${CRISIS_SENTINEL}`;
    const { text, detected } = stripCrisisSentinel(input);
    expect(detected).toBe(true);
    expect(text).not.toContain(CRISIS_SENTINEL);
    expect(text).toContain('988');
  });

  it('strips surrounding whitespace along with the sentinel', () => {
    const input = `Please call 988.\n\n${CRISIS_SENTINEL}\n`;
    const { text, detected } = stripCrisisSentinel(input);
    expect(detected).toBe(true);
    expect(text.trim()).toBe('Please call 988.');
  });

  it('returns detected=false and the original text when no sentinel present', () => {
    const input = 'It sounds like you had a tough day.';
    const { text, detected } = stripCrisisSentinel(input);
    expect(detected).toBe(false);
    expect(text).toBe(input);
  });

  it('does not modify text that contains a partial sentinel string', () => {
    const input = `Something CRISIS_RESOURCE happened but this is CRISIS_RESOURCE_INJECT not a sentinel.`;
    const { text, detected } = stripCrisisSentinel(input);
    expect(detected).toBe(false);
    expect(text).toBe(input);
  });

  it('does not strip a sentinel that appears mid-text rather than at the end', () => {
    const input = `${CRISIS_SENTINEL} is mentioned but this is not at the end, more follows.`;
    const { text, detected } = stripCrisisSentinel(input);
    expect(detected).toBe(false);
    expect(text).toBe(input);
  });

  it('returns detected=false for an empty string', () => {
    const { text, detected } = stripCrisisSentinel('');
    expect(detected).toBe(false);
    expect(text).toBe('');
  });
});

describe('CRISIS_SENTINEL constant', () => {
  it('matches the exact text instructed in the prompt guardrails', () => {
    // Guard against typo drift between prompts/index.ts and messagesStream.ts
    expect(CRISIS_SENTINEL).toBe('CRISIS_RESOURCE_INJECTED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding 3-minute transition — unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ONBOARDING_COMPLETE_SENTINEL constant', () => {
  it('has the exact value the prompt instructs the LLM to append', () => {
    // Guard against value drift between prompts/index.ts and messagesStream.ts
    expect(ONBOARDING_COMPLETE_SENTINEL).toBe('ONBOARDING_COMPLETE');
  });

  it('is referenced inside buildOnboardingTransitionBlock()', () => {
    const block = buildOnboardingTransitionBlock();
    expect(block).toContain(ONBOARDING_COMPLETE_SENTINEL);
  });
});

describe('stripOnboardingSentinel', () => {
  it('detects and strips the sentinel from the trailing end of a response', () => {
    const input = `It's been lovely chatting!\nONBOARDING_COMPLETE`;
    const { text, detected } = stripOnboardingSentinel(input);
    expect(detected).toBe(true);
    expect(text).not.toContain(ONBOARDING_COMPLETE_SENTINEL);
    expect(text).toContain("It's been lovely chatting!");
  });

  it('strips trailing whitespace and newlines along with the sentinel', () => {
    const input = `Let's jump in!\n\nONBOARDING_COMPLETE\n`;
    const { text, detected } = stripOnboardingSentinel(input);
    expect(detected).toBe(true);
    expect(text.trimEnd()).toBe("Let's jump in!");
  });

  it('returns detected=false and the original text when sentinel is absent', () => {
    const input = 'Tell me more about yourself.';
    const { text, detected } = stripOnboardingSentinel(input);
    expect(detected).toBe(false);
    expect(text).toBe(input);
  });

  it('does NOT strip when sentinel appears mid-text (only trailing matches count)', () => {
    const input = `ONBOARDING_COMPLETE is a word but more text follows after it.`;
    const { text, detected } = stripOnboardingSentinel(input);
    expect(detected).toBe(false);
    expect(text).toBe(input);
  });

  it('does not affect CRISIS_RESOURCE_INJECTED sentinel (no cross-contamination)', () => {
    const input = `Please call 988.\n${CRISIS_SENTINEL}`;
    const { text, detected } = stripOnboardingSentinel(input);
    // stripOnboardingSentinel should not touch the crisis sentinel
    expect(detected).toBe(false);
    expect(text).toContain(CRISIS_SENTINEL);
  });

  it('handles response with both sentinels at the end — strips only the onboarding one', () => {
    // Extremely unlikely in practice but must behave predictably
    const input = `Some content.\n${CRISIS_SENTINEL}\n${ONBOARDING_COMPLETE_SENTINEL}`;
    const { text, detected } = stripOnboardingSentinel(input);
    expect(detected).toBe(true);
    expect(text).toContain(CRISIS_SENTINEL);
    expect(text).not.toContain(ONBOARDING_COMPLETE_SENTINEL);
  });
});

describe('buildOnboardingTransitionBlock', () => {
  it('returns a non-empty string', () => {
    expect(buildOnboardingTransitionBlock().length).toBeGreaterThan(0);
  });

  it('instructs the LLM to mark its response with the sentinel when user confirms', () => {
    const block = buildOnboardingTransitionBlock();
    expect(block).toContain(ONBOARDING_COMPLETE_SENTINEL);
  });

  it('includes guidance for both the "jump" and "continue" user responses', () => {
    const block = buildOnboardingTransitionBlock();
    // Must cover the "yes" path
    expect(block.toLowerCase()).toMatch(/jump|yes|ready|affirmation/);
    // Must cover the "no" path
    expect(block.toLowerCase()).toMatch(/continue|stay|longer|decline/);
  });

  it('marks itself as an internal instruction (not to be revealed to the user)', () => {
    const block = buildOnboardingTransitionBlock();
    expect(block.toLowerCase()).toMatch(/internal|do not reveal/);
  });
});

describe('driveOrchestrationStream — onboarding transition (3-minute offer)', () => {
  // These tests verify the showTransitionOffer flag logic by checking the
  // params passed to aiOrchestrationService.stream. The full sentinel →
  // close → enqueue path is covered in the integration tests (Flow 4).

  function setupSuccessfulTransaction(messageId = 'assistant-msg-1') {
    mockTransaction.mockImplementation(async (cb) => {
      const tx = {
        insert: () => ({ values: () => ({ returning: async () => [{ id: messageId }] }) }),
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      };
      return cb(tx);
    });
  }

  beforeEach(() => setupSuccessfulTransaction());

  it('does NOT inject the transition block before 3 minutes have elapsed', async () => {
    // conversationStartedAt = now → elapsed ≈ 0ms → no offer
    const startedAt = new Date(); // just now — well under threshold

    const session = new StreamSession('conv-no-offer');
    (aiOrchestrationService.stream as jest.Mock).mockReturnValue(
      (async function* () { yield 'Hello!'; })(),
    );

    await driveOrchestrationStream({
      session,
      conversationId:        'conv-no-offer',
      userId:                'user-1',
      contextMessages:       [],
      userProfile:           { displayName: 'Test', timezone: 'UTC', commStyle: 'warm',
                               onboardingDone: false, contextSummary: null },
      encryptionService:     new EncryptionService('test-user'),
      conversationStartedAt: startedAt,
      onboardingDone:        false,
      jobQueue:              null,
    });

    const call = (aiOrchestrationService.stream as jest.Mock).mock.calls[0][0];
    // promptOpts should be undefined or showTransitionOffer should be false
    expect(call.promptOpts?.showTransitionOffer).toBeFalsy();
  });

  it('injects the transition block when ONBOARDING_OFFER_MS_OVERRIDE=0', async () => {
    process.env.ONBOARDING_OFFER_MS_OVERRIDE = '0';

    const session = new StreamSession('conv-with-offer');
    (aiOrchestrationService.stream as jest.Mock).mockReturnValue(
      (async function* () { yield 'Would you like to jump?'; })(),
    );

    await driveOrchestrationStream({
      session,
      conversationId:        'conv-with-offer',
      userId:                'user-1',
      contextMessages:       [],
      userProfile:           { displayName: 'Test', timezone: 'UTC', commStyle: 'warm',
                               onboardingDone: false, contextSummary: null },
      encryptionService:     new EncryptionService('test-user'),
      conversationStartedAt: new Date(Date.now() - 1), // 1ms ago — over 0ms threshold
      onboardingDone:        false,
      jobQueue:              null,
    });

    const call = (aiOrchestrationService.stream as jest.Mock).mock.calls[0][0];
    expect(call.promptOpts?.showTransitionOffer).toBe(true);
  });

  it('does NOT inject the transition block when onboardingDone=true', async () => {
    process.env.ONBOARDING_OFFER_MS_OVERRIDE = '0';

    const session = new StreamSession('conv-already-done');
    (aiOrchestrationService.stream as jest.Mock).mockReturnValue(
      (async function* () { yield 'How are you today?'; })(),
    );

    await driveOrchestrationStream({
      session,
      conversationId:        'conv-already-done',
      userId:                'user-1',
      contextMessages:       [],
      userProfile:           { displayName: 'Test', timezone: 'UTC', commStyle: 'warm',
                               onboardingDone: true, contextSummary: null },
      encryptionService:     new EncryptionService('test-user'),
      conversationStartedAt: new Date(0), // very old — over any threshold
      onboardingDone:        true,        // ← already done; no offer
      jobQueue:              null,
    });

    const call = (aiOrchestrationService.stream as jest.Mock).mock.calls[0][0];
    expect(call.promptOpts?.showTransitionOffer).toBeFalsy();
  });

  it('does NOT inject the transition block when conversationStartedAt is omitted', async () => {
    // driveOrchestrationStream must default to "no offer" rather than
    // throwing/NaN-ing when the caller doesn't pass a start time.
    const session = new StreamSession('conv-no-started-at');
    (aiOrchestrationService.stream as jest.Mock).mockReturnValue(
      (async function* () { yield 'Hi!'; })(),
    );

    await driveOrchestrationStream({
      session,
      conversationId:  'conv-no-started-at',
      userId:          'user-1',
      contextMessages: [],
      userProfile:     { displayName: 'Test', timezone: 'UTC', commStyle: 'warm',
                         onboardingDone: false, contextSummary: null },
      encryptionService: new EncryptionService('test-user'),
    });

    const call = (aiOrchestrationService.stream as jest.Mock).mock.calls[0][0];
    expect(call.promptOpts?.showTransitionOffer).toBeFalsy();
  });

  it('sentinel in the LLM response triggers onboarding_complete=true in done meta', async () => {
    process.env.ONBOARDING_OFFER_MS_OVERRIDE = '0';

    const session = new StreamSession('conv-sentinel-fires');
    (aiOrchestrationService.stream as jest.Mock).mockReturnValue(
      (async function* () {
        yield "It's been great! Let's go.\n";
        yield ONBOARDING_COMPLETE_SENTINEL;
      })(),
    );

    await driveOrchestrationStream({
      session,
      conversationId:        'conv-sentinel-fires',
      userId:                'user-1',
      contextMessages:       [],
      userProfile:           { displayName: 'Test', timezone: 'UTC', commStyle: 'warm',
                               onboardingDone: false, contextSummary: null },
      encryptionService:     new EncryptionService('test-user'),
      conversationStartedAt: new Date(Date.now() - 1),
      onboardingDone:        false,
      jobQueue:              null,
    });

    // The session done meta should include onboardingComplete: true
    expect(session.doneMeta?.onboardingComplete).toBe(true);
  });

  it('the sentinel is NOT present in any token pushed to the session', async () => {
    process.env.ONBOARDING_OFFER_MS_OVERRIDE = '0';

    const session = new StreamSession('conv-no-sentinel-leak');
    const pushed: string[] = [];
    jest.spyOn(session, 'pushToken').mockImplementation((delta) => {
      pushed.push(delta);
      return { id: 0, delta };
    });

    (aiOrchestrationService.stream as jest.Mock).mockReturnValue(
      (async function* () {
        yield "Great chatting! ";
        yield ONBOARDING_COMPLETE_SENTINEL;
      })(),
    );

    await driveOrchestrationStream({
      session,
      conversationId:        'conv-no-sentinel-leak',
      userId:                'user-1',
      contextMessages:       [],
      userProfile:           { displayName: 'Test', timezone: 'UTC', commStyle: 'warm',
                               onboardingDone: false, contextSummary: null },
      encryptionService:     new EncryptionService('test-user'),
      conversationStartedAt: new Date(Date.now() - 1),
      onboardingDone:        false,
      jobQueue:              null,
    });

    const allPushed = pushed.join('');
    expect(allPushed).not.toContain(ONBOARDING_COMPLETE_SENTINEL);
    expect(allPushed).toContain('Great chatting!');
  });

  it('no sentinel → onboardingComplete is falsy in done meta (user chose to continue)', async () => {
    process.env.ONBOARDING_OFFER_MS_OVERRIDE = '0';

    const session = new StreamSession('conv-user-continues');
    (aiOrchestrationService.stream as jest.Mock).mockReturnValue(
      (async function* () { yield "Of course, let's keep chatting!"; })(),
    );

    await driveOrchestrationStream({
      session,
      conversationId:        'conv-user-continues',
      userId:                'user-1',
      contextMessages:       [],
      userProfile:           { displayName: 'Test', timezone: 'UTC', commStyle: 'warm',
                               onboardingDone: false, contextSummary: null },
      encryptionService:     new EncryptionService('test-user'),
      conversationStartedAt: new Date(Date.now() - 1),
      onboardingDone:        false,
      jobQueue:              null,
    });

    expect(session.doneMeta?.onboardingComplete).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-transition at 6 minutes (user chose to continue at 3 min, or never
// responded to the offer)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildAutoTransitionBlock', () => {
  it('returns a non-empty string', () => {
    expect(buildAutoTransitionBlock().length).toBeGreaterThan(0);
  });

  it('instructs the LLM to append the sentinel without asking', () => {
    const block = buildAutoTransitionBlock();
    expect(block).toContain(ONBOARDING_COMPLETE_SENTINEL);
  });

  it('explicitly tells the LLM NOT to ask the user', () => {
    const block = buildAutoTransitionBlock().toLowerCase();
    expect(block).toMatch(/do not ask|without asking|automatically/);
  });

  it('instructs the LLM to recap what it learned before transitioning', () => {
    const block = buildAutoTransitionBlock().toLowerCase();
    expect(block).toMatch(/recap|acknowledge|learned|gathered|brief/);
  });

  it('is distinct from buildOnboardingTransitionBlock (no choice offered)', () => {
    const auto  = buildAutoTransitionBlock().toLowerCase();
    const offer = buildOnboardingTransitionBlock().toLowerCase();
    // The offer block asks a question; the auto block does not
    expect(offer).toMatch(/would you like|prefer to|choice/);
    expect(auto).not.toMatch(/would you like.*chat.*or/);
  });
});

describe('driveOrchestrationStream — auto-transition at 6 minutes', () => {
  function setupSuccessfulTransaction(messageId = 'assistant-msg-1') {
    mockTransaction.mockImplementation(async (cb) => {
      const tx = {
        insert: () => ({ values: () => ({ returning: async () => [{ id: messageId }] }) }),
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      };
      return cb(tx);
    });
  }

  beforeEach(() => setupSuccessfulTransaction());

  it('injects autoTransition=true when ONBOARDING_AUTO_MS_OVERRIDE=0', async () => {
    process.env.ONBOARDING_OFFER_MS_OVERRIDE = '0';
    process.env.ONBOARDING_AUTO_MS_OVERRIDE  = '0';

    const session = new StreamSession('conv-auto-transition');
    (aiOrchestrationService.stream as jest.Mock).mockReturnValue(
      (async function* () { yield "Great chatting — let's go!"; })(),
    );

    await driveOrchestrationStream({
      session,
      conversationId:        'conv-auto-transition',
      userId:                'user-1',
      contextMessages:       [],
      userProfile:           { displayName: 'Test', timezone: 'UTC', commStyle: 'warm',
                               onboardingDone: false, contextSummary: null },
      encryptionService:     new EncryptionService('test-user'),
      conversationStartedAt: new Date(Date.now() - 1),
      onboardingDone:        false,
      jobQueue:              null,
    });

    const call = (aiOrchestrationService.stream as jest.Mock).mock.calls[0][0];
    expect(call.promptOpts?.autoTransition).toBe(true);
    expect(call.promptOpts?.showTransitionOffer).toBeFalsy();
  });

  it('auto-transition takes priority over offer when both thresholds are exceeded', async () => {
    // Both set to 0 — auto should win
    process.env.ONBOARDING_OFFER_MS_OVERRIDE = '0';
    process.env.ONBOARDING_AUTO_MS_OVERRIDE  = '0';

    const session = new StreamSession('conv-auto-priority');
    (aiOrchestrationService.stream as jest.Mock).mockReturnValue(
      (async function* () { yield 'Auto response'; })(),
    );

    await driveOrchestrationStream({
      session,
      conversationId:        'conv-auto-priority',
      userId:                'user-1',
      contextMessages:       [],
      userProfile:           { displayName: 'Test', timezone: 'UTC', commStyle: 'warm',
                               onboardingDone: false, contextSummary: null },
      encryptionService:     new EncryptionService('test-user'),
      conversationStartedAt: new Date(Date.now() - 1),
      onboardingDone:        false,
      jobQueue:              null,
    });

    const call = (aiOrchestrationService.stream as jest.Mock).mock.calls[0][0];
    // autoTransition wins — showTransitionOffer must not also be true
    expect(call.promptOpts?.autoTransition).toBe(true);
    expect(call.promptOpts?.showTransitionOffer).toBeFalsy();
  });

  it('offer (not auto) is injected when only the 3-minute threshold is exceeded', async () => {
    process.env.ONBOARDING_OFFER_MS_OVERRIDE = '0';
    // Auto threshold not overridden — defaults to 6 min, far in the future

    const session = new StreamSession('conv-offer-only');
    (aiOrchestrationService.stream as jest.Mock).mockReturnValue(
      (async function* () { yield 'Would you like to jump?'; })(),
    );

    await driveOrchestrationStream({
      session,
      conversationId:        'conv-offer-only',
      userId:                'user-1',
      contextMessages:       [],
      userProfile:           { displayName: 'Test', timezone: 'UTC', commStyle: 'warm',
                               onboardingDone: false, contextSummary: null },
      encryptionService:     new EncryptionService('test-user'),
      conversationStartedAt: new Date(Date.now() - 1),
      onboardingDone:        false,
      jobQueue:              null,
    });

    const call = (aiOrchestrationService.stream as jest.Mock).mock.calls[0][0];
    expect(call.promptOpts?.showTransitionOffer).toBe(true);
    expect(call.promptOpts?.autoTransition).toBeFalsy();
  });

  it('sentinel in auto-transition response sets onboarding_complete=true in done meta', async () => {
    process.env.ONBOARDING_OFFER_MS_OVERRIDE = '0';
    process.env.ONBOARDING_AUTO_MS_OVERRIDE  = '0';

    const session = new StreamSession('conv-auto-sentinel');
    (aiOrchestrationService.stream as jest.Mock).mockReturnValue(
      (async function* () {
        yield "I've learned so much about you! Let's jump in.\n";
        yield ONBOARDING_COMPLETE_SENTINEL;
      })(),
    );

    await driveOrchestrationStream({
      session,
      conversationId:        'conv-auto-sentinel',
      userId:                'user-1',
      contextMessages:       [],
      userProfile:           { displayName: 'Test', timezone: 'UTC', commStyle: 'warm',
                               onboardingDone: false, contextSummary: null },
      encryptionService:     new EncryptionService('test-user'),
      conversationStartedAt: new Date(Date.now() - 1),
      onboardingDone:        false,
      jobQueue:              null,
    });

    expect(session.doneMeta?.onboardingComplete).toBe(true);
  });

  it('neither flag injected before either threshold (< 3 min)', async () => {
    // No overrides — both thresholds are in the future for a brand new conversation
    const session = new StreamSession('conv-too-early');
    (aiOrchestrationService.stream as jest.Mock).mockReturnValue(
      (async function* () { yield 'Tell me about yourself.'; })(),
    );

    await driveOrchestrationStream({
      session,
      conversationId:        'conv-too-early',
      userId:                'user-1',
      contextMessages:       [],
      userProfile:           { displayName: 'Test', timezone: 'UTC', commStyle: 'warm',
                               onboardingDone: false, contextSummary: null },
      encryptionService:     new EncryptionService('test-user'),
      conversationStartedAt: new Date(), // just now — 0ms elapsed
      onboardingDone:        false,
      jobQueue:              null,
    });

    const call = (aiOrchestrationService.stream as jest.Mock).mock.calls[0][0];
    expect(call.promptOpts).toBeUndefined();
  });
});
