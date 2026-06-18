/**
 * src/components/AuthLayout.tsx
 *
 * Shared centered-card shell for /login and /register. Keeps both
 * screens visually consistent without duplicating layout markup.
 */

import type { ReactNode } from 'react';

interface AuthLayoutProps {
  title: string;
  children: ReactNode;
}

export function AuthLayout({ title, children }: AuthLayoutProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-xl font-semibold text-gray-900">{title}</h1>
        {children}
      </div>
    </div>
  );
}
