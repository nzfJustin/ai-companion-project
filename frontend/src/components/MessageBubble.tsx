/**
 * src/components/MessageBubble.tsx
 *
 * Renders a single chat message bubble.
 *
 * User messages: right-aligned, slate background.
 * Assistant messages: left-aligned, white background with a soft border.
 * Both show a relative timestamp below the bubble.
 * An optional emotion pill is shown below assistant messages (set by F1-006
 * when the SSE `done` event arrives).
 */

import { relativeTime } from '../utils/time';

interface MessageBubbleProps {
  role:         'user' | 'assistant';
  content:      string;
  createdAt:    string;
  emotionTag?:  { primary: string; score: number } | null;
  /** Used for F1-006's typing indicator — renders a three-dot animation instead of content */
  isTyping?:    boolean;
}

// Emotion → soft background colour mapping
const EMOTION_COLOURS: Record<string, string> = {
  joy:        'bg-yellow-50 text-yellow-700',
  calm:       'bg-teal-50  text-teal-700',
  anxiety:    'bg-orange-50 text-orange-700',
  sadness:    'bg-blue-50   text-blue-700',
  anger:      'bg-red-50    text-red-700',
  excitement: 'bg-purple-50 text-purple-700',
};

function emotionColour(primary: string): string {
  return EMOTION_COLOURS[primary.toLowerCase()] ?? 'bg-gray-50 text-gray-600';
}

export function MessageBubble({
  role,
  content,
  createdAt,
  emotionTag,
  isTyping,
}: MessageBubbleProps) {
  const isUser = role === 'user';

  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} gap-1`}>
      {/* Bubble */}
      <div
        className={`
          max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed
          ${isUser
            ? 'rounded-br-sm bg-slate-700 text-white'
            : 'rounded-bl-sm border border-gray-100 bg-white text-gray-800'}
        `}
      >
        {isTyping ? (
          /* Three-dot typing indicator — replaced by real content as tokens arrive (F1-006) */
          <span className="flex items-center gap-1" aria-label="AI is typing">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400"
                style={{ animationDelay: `${i * 150}ms` }}
                aria-hidden="true"
              />
            ))}
          </span>
        ) : (
          /* Preserve line breaks from multi-line content */
          <span style={{ whiteSpace: 'pre-wrap' }}>{content}</span>
        )}
      </div>

      {/* Emotion pill (assistant only, after SSE done event in F1-006) */}
      {!isUser && !isTyping && emotionTag && (
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${emotionColour(emotionTag.primary)}`}
          aria-label={`Detected emotion: ${emotionTag.primary}`}
        >
          {emotionTag.primary}
        </span>
      )}

      {/* Relative timestamp */}
      {!isTyping && (
        <time
          dateTime={createdAt}
          className="px-1 text-[11px] text-gray-400"
        >
          {relativeTime(createdAt)}
        </time>
      )}
    </div>
  );
}
