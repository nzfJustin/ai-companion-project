/**
 * src/api/memories.ts
 *
 * Typed wrappers for the memories API endpoints.
 * F1-007 uses listMemories() to fetch dominant_emotion for conversation cards.
 * F1-008 uses listMemories() for the memory grid.
 * F1-009 uses getMemory() for the detail view.
 */

import { apiFetch } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemoryListItem {
  id:               string;
  /** Added in backend P1-21 patch so the frontend can cross-reference
   *  conversation cards with their extracted memory / emotion data. */
  conversation_id:  string | null;
  title:            string;
  level:            1 | 2 | 3 | 4 | 5;
  dominant_emotion: string | null;
  created_at:       string;
  period_start:     string;  // YYYY-MM-DD
  period_end:       string;  // YYYY-MM-DD
}

export interface MemoryDetail extends MemoryListItem {
  summary:        string;
  key_events:     string[];
  emotional_tags: string[];
}

export interface MemoryListResponse {
  memories: MemoryListItem[];
  page:     number;
  per_page: number;
  has_more: boolean;
}

// ─── Query param types ────────────────────────────────────────────────────────

export interface ListMemoriesParams {
  page?:    number;
  perPage?: number;
  /** Comma-separated levels, e.g. "1,2,3" */
  levels?:  string;
  from?:    string;  // YYYY-MM-DD
  to?:      string;  // YYYY-MM-DD
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

/**
 * GET /v1/memories — paginated list with optional level + date filters.
 * Returns list-safe fields only (no decrypted summary).
 */
export function listMemories(params: ListMemoriesParams = {}): Promise<MemoryListResponse> {
  const query = new URLSearchParams();
  if (params.page)    query.set('page',     String(params.page));
  if (params.perPage) query.set('per_page', String(params.perPage));
  if (params.levels)  query.set('level',    params.levels);
  if (params.from)    query.set('from',     params.from);
  if (params.to)      query.set('to',       params.to);

  const qs = query.toString();
  return apiFetch<MemoryListResponse>(`/v1/memories${qs ? `?${qs}` : ''}`);
}

/**
 * GET /v1/memories/:id — full detail including decrypted summary.
 * Level 4–5 requires X-Elevated-Token header (pass via options).
 */
export function getMemory(
  id: string,
  elevatedToken?: string,
): Promise<MemoryDetail> {
  return apiFetch<MemoryDetail>(`/v1/memories/${id}`, {
    headers: elevatedToken ? { 'X-Elevated-Token': elevatedToken } : undefined,
  });
}

/**
 * PATCH /v1/memories/:id — update level only.
 */
export function updateMemoryLevel(id: string, level: 1 | 2 | 3 | 4 | 5): Promise<{ id: string; level: number }> {
  return apiFetch(`/v1/memories/${id}`, {
    method: 'PATCH',
    body:   { level },
  });
}

/**
 * DELETE /v1/memories/:id — soft delete.
 */
export function deleteMemory(id: string): Promise<void> {
  return apiFetch(`/v1/memories/${id}`, { method: 'DELETE' });
}
