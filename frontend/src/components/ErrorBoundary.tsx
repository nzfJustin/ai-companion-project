/**
 * src/components/ErrorBoundary.tsx
 *
 * Global error boundary that wraps the entire app in main.tsx.
 * Catches any unhandled React render errors and shows a recovery screen
 * with a "Reload app" button rather than a blank white page.
 *
 * Error boundaries must be class components — there's no hook equivalent
 * for getDerivedStateFromError / componentDidCatch.
 */

import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // In production, forward to an error-tracking service (e.g. Sentry).
    console.error('[ErrorBoundary] Unhandled render error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 p-8 text-center">
          <p className="text-4xl">⚠️</p>
          <h1 className="text-xl font-semibold text-gray-900">Something went wrong</h1>
          <p className="max-w-sm text-sm text-gray-500">
            An unexpected error occurred. Your data is safe — reloading the app should fix this.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Reload app
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
