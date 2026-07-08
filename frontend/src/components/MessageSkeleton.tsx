/**
 * src/components/MessageSkeleton.tsx
 *
 * Shimmer placeholder shown while GET /v1/conversations/:id is in flight.
 * Alternates between right- and left-aligned shapes to approximate the
 * rhythm of a real conversation without conveying any specific content.
 */

function SkeletonBubble({ align }: { align: 'left' | 'right' }) {
  const isRight = align === 'right';
  return (
    <div className={`flex ${isRight ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`
          h-10 animate-pulse rounded-2xl bg-gray-200
          ${isRight ? 'rounded-br-sm' : 'rounded-bl-sm'}
        `}
        style={{ width: `${isRight ? 55 : 70}%` }}
        aria-hidden="true"
      />
    </div>
  );
}

export function MessageSkeleton() {
  const pattern: Array<'left' | 'right'> = [
    'right', 'left', 'left', 'right', 'left',
  ];

  return (
    <div
      className="flex flex-col gap-4 p-4"
      role="status"
      aria-label="Loading conversation…"
    >
      {pattern.map((align, i) => (
        <SkeletonBubble key={i} align={align} />
      ))}
    </div>
  );
}
