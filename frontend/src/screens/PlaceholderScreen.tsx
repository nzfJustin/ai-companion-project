/**
 * src/screens/PlaceholderScreen.tsx
 *
 * Temporary stand-in for every screen until its real task lands
 * (F1-002 through F1-011). Renders the route path as plain text so
 * routing can be verified end-to-end before any real UI exists.
 */

interface PlaceholderScreenProps {
  name: string;
}

export function PlaceholderScreen({ name }: PlaceholderScreenProps) {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <p className="text-lg font-medium text-gray-500">{name}</p>
    </div>
  );
}
