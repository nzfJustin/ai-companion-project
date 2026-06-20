/**
 * src/router.tsx
 *
 * Route table restructured for F1-003 into two layers:
 *
 *   Public routes  — /login, /register (no auth required)
 *   Protected routes — wrapped in <ProtectedRoute> (silent refresh on mount)
 *     Bare protected — /onboarding (auth required, no nav shell)
 *     Shell routes   — wrapped in <AppShell> (auth + sidebar/bottom nav)
 *
 * The / root redirects to /chat so bookmarking the root still works.
 * F1-004 will add an onboarding guard that prevents direct navigation to
 * /onboarding once onboarding_done = true.
 */

import { createBrowserRouter, Navigate } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AppShell }       from './components/AppShell';
import { LoginScreen }    from './screens/LoginScreen';
import { RegisterScreen } from './screens/RegisterScreen';
import { PlaceholderScreen } from './screens/PlaceholderScreen';

export const router = createBrowserRouter([
  // ── Public routes ───────────────────────────────────────────────────────────
  { path: '/login',    element: <LoginScreen /> },
  { path: '/register', element: <RegisterScreen /> },

  // ── Protected routes ────────────────────────────────────────────────────────
  {
    element: <ProtectedRoute />,
    children: [
      // Onboarding: auth-required but no nav shell (user hasn't completed setup yet)
      { path: '/onboarding', element: <PlaceholderScreen name="/onboarding" /> },

      // Shell routes: auth-required + persistent sidebar/bottom nav
      {
        element: <AppShell />,
        children: [
          { path: '/chat',                 element: <PlaceholderScreen name="/chat" /> },
          { path: '/chat/:conversationId', element: <PlaceholderScreen name="/chat/:conversationId" /> },
          { path: '/memories',             element: <PlaceholderScreen name="/memories" /> },
          { path: '/memories/:id',         element: <PlaceholderScreen name="/memories/:id" /> },
          { path: '/trends',               element: <PlaceholderScreen name="/trends" /> },
          { path: '/settings',             element: <PlaceholderScreen name="/settings" /> },
        ],
      },
    ],
  },

  // ── Redirects / catch-all ────────────────────────────────────────────────────
  { path: '/',  element: <Navigate to="/chat" replace /> },
  { path: '*',  element: <PlaceholderScreen name="404 Not Found" /> },
]);
