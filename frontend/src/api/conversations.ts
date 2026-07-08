/**
 * src/api/conversations.ts
 *
 * Typed wrappers for conversation endpoints.
 * F1-004 uses createConversation(); later chat tasks add more.
 */

import { apiFetch } from './client';

export interface ConversationResponse {
  id:         string;
  started_at: string;
  status:     'active';
}

/**
 * POST /v1/conversations
 * Creates a new conversation for the authenticated user.
 * Returns the conversation id used to navigate to /chat/:conversationId.
 */
export function createConversation(): Promise<ConversationResponse> {
  return apiFetch<ConversationResponse>('/v1/conversations', {
    method: 'POST',
  });
}
