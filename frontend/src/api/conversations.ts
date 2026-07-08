/**
 * src/api/conversations.ts
 *
 * Typed wrappers for conversation endpoints.
 */

import { apiFetch } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConversationResponse {
  id:            string;
  started_at:    string;
  ended_at:      string | null;
  status:        'active' | 'closed' | 'summarized' | 'extraction_failed';
  message_count: number;
}

export interface MessageResponse {
  id:           string;
  role:         'user' | 'assistant';
  content:      string;
  emotion_tags: { primary: string; score: number } | null;
  created_at:   string;
}

export interface ConversationDetailResponse extends ConversationResponse {
  messages: MessageResponse[];
}

export interface ConversationListResponse {
  conversations: ConversationResponse[];
  page:          number;
  per_page:      number;
  has_more:      boolean;
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

/** POST /v1/conversations — create a new conversation */
export function createConversation(): Promise<ConversationResponse> {
  return apiFetch<ConversationResponse>('/v1/conversations', {
    method: 'POST',
  });
}

/** GET /v1/conversations/:id — metadata + last 20 messages */
export function getConversation(id: string): Promise<ConversationDetailResponse> {
  return apiFetch<ConversationDetailResponse>(`/v1/conversations/${id}`);
}

/** GET /v1/conversations — paginated list */
export function listConversations(
  page    = 1,
  perPage = 20,
): Promise<ConversationListResponse> {
  return apiFetch<ConversationListResponse>(
    `/v1/conversations?page=${page}&per_page=${perPage}`,
  );
}

/** PATCH /v1/conversations/:id — close conversation */
export function closeConversation(id: string): Promise<ConversationResponse> {
  return apiFetch<ConversationResponse>(`/v1/conversations/${id}`, {
    method: 'PATCH',
    body:   { status: 'closed' },
  });
}
