/**
 * src/components/__tests__/ErrorBoundary.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from '../ErrorBoundary';

// Suppress React's console.error output for the expected thrown errors
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// A component that throws on render
function BombComponent(): never {
  throw new Error('Test render crash');
}

describe('ErrorBoundary', () => {
  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div data-testid="child">Hello</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('shows the recovery screen when a child throws', () => {
    render(
      <ErrorBoundary>
        <BombComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload app/i })).toBeInTheDocument();
  });

  it('does not render the child content when an error has occurred', () => {
    render(
      <ErrorBoundary>
        <BombComponent />
      </ErrorBoundary>,
    );
    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
  });

  it('"Reload app" button calls window.location.reload()', async () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, reload: reloadMock },
    });

    render(
      <ErrorBoundary>
        <BombComponent />
      </ErrorBoundary>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /reload app/i }));

    expect(reloadMock).toHaveBeenCalledTimes(1);
  });
});
