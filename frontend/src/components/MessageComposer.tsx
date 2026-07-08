/**
 * src/components/MessageComposer.tsx
 *
 * The chat input area. F1-005 acceptance criteria:
 *
 *   ✓ Multiline textarea that grows up to 5 lines, then scrolls
 *   ✓ Enter submits, Shift+Enter inserts a newline
 *   ✓ Send button + Enter key disabled while AI response is in progress
 *   ✓ Character counter appears within 200 chars of the 2,000-char limit
 *      - Amber at 1,800+
 *      - Red at 1,950+
 *   ✓ Submit blocked if content is empty or exceeds 2,000 characters
 *   ✓ Disabled during initial message history load
 */

import { useRef, useEffect } from 'react';
import type { KeyboardEvent, ChangeEvent } from 'react';

interface MessageComposerProps {
  value:       string;
  onChange:    (value: string) => void;
  onSubmit:    () => void;
  disabled:    boolean;
  /** True while the AI response stream is in progress (F1-006) */
  isStreaming: boolean;
}

const MAX_CHARS    = 2_000;
const WARN_AMBER   = 1_800;
const WARN_RED     = 1_950;
const COUNTER_SHOW = MAX_CHARS - 200; // show counter from 1,800 chars

// ─── Character counter colour ─────────────────────────────────────────────────

function counterColour(len: number): string {
  if (len >= WARN_RED)   return 'text-red-600';
  if (len >= WARN_AMBER) return 'text-amber-500';
  return 'text-gray-400';
}

// ─── MessageComposer ──────────────────────────────────────────────────────────

export function MessageComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  isStreaming,
}: MessageComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isDisabled  = disabled || isStreaming;
  const canSubmit   = value.trim().length > 0 && value.length <= MAX_CHARS && !isDisabled;
  const showCounter = value.length >= COUNTER_SHOW;

  // Auto-grow: reset height to 'auto' then set to scrollHeight, capped at ~5 lines
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight   = 24; // matches leading-6
    const maxHeight    = lineHeight * 5 + 24; // 5 lines + padding
    el.style.height    = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSubmit) onSubmit();
    }
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
  }

  return (
    <div className="border-t border-gray-100 bg-white px-4 py-3">
      {/* Character counter */}
      {showCounter && (
        <p
          className={`mb-1 text-right text-xs ${counterColour(value.length)}`}
          aria-live="polite"
          aria-atomic="true"
        >
          {value.length} / {MAX_CHARS}
        </p>
      )}

      <div className="flex items-end gap-2">
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          placeholder={isStreaming ? 'Waiting for response…' : 'Share what\'s on your mind…'}
          aria-label="Message input"
          aria-multiline="true"
          rows={1}
          className="
            flex-1 resize-none rounded-xl border border-gray-200 bg-gray-50
            px-3.5 py-2.5 text-sm leading-6 text-gray-900
            placeholder:text-gray-400
            focus:border-gray-400 focus:bg-white focus:outline-none
            disabled:cursor-not-allowed disabled:opacity-50
          "
          style={{ overflowY: 'hidden' }} // controlled by the auto-grow useEffect
        />

        {/* Send button */}
        <button
          onClick={onSubmit}
          disabled={!canSubmit}
          aria-label="Send message"
          className="
            mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center
            rounded-full bg-slate-700 text-white transition-opacity
            disabled:cursor-not-allowed disabled:opacity-40
          "
        >
          {/* Arrow-up icon */}
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04L10.75 5.612V16.25A.75.75 0 0110 17z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      {/* Over-limit warning */}
      {value.length > MAX_CHARS && (
        <p
          role="alert"
          className="mt-1.5 text-xs text-red-600"
        >
          Message is too long — maximum {MAX_CHARS.toLocaleString()} characters.
        </p>
      )}
    </div>
  );
}
