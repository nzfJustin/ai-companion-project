import { AIOrchestrationService } from './AIOrchestrationService';
import { AnthropicProvider }      from './llm/AnthropicProvider';

let instance = new AIOrchestrationService(new AnthropicProvider());

// aiOrchestrationService is imported directly (not called as a function) by
// messagesStream.ts and anything else that needs to run an LLM call, so it
// has to stay a stable object reference rather than a rebindable `let`
// export (ES module bindings for `export const`/`let` can't be reassigned
// from outside the module). Instead this is a thin proxy that always
// forwards to whichever `instance` is currently set — setOrchestrator()
// swaps `instance`, and every existing holder of `aiOrchestrationService`
// picks up the swap on their next call.
export const aiOrchestrationService = {
  complete: (...args: Parameters<AIOrchestrationService['complete']>) => instance.complete(...args),
  stream:   (...args: Parameters<AIOrchestrationService['stream']>)   => instance.stream(...args),
};

/**
 * Test-only injection point — swaps the underlying orchestration service
 * (e.g. to inject a MockLLMProvider-backed instance so tests never hit the
 * real Anthropic API). Production code never calls this; src/index.ts wires
 * up the real AnthropicProvider-backed instance at module load time above.
 */
export function setOrchestrator(o: AIOrchestrationService): void {
  instance = o;
}
