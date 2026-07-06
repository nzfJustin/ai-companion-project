import { AIOrchestrationService } from './AIOrchestrationService';
import { AnthropicProvider }      from './llm/AnthropicProvider';

export const aiOrchestrationService = new AIOrchestrationService(new AnthropicProvider());
