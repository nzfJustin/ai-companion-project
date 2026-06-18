/**
 * src/router.tsx
 *
 * Route table for every screen in the Phase 1 frontend breakdown.
 * All routes currently render <PlaceholderScreen> — real screens are
 * swapped in by their respective tasks (F1-002 through F1-011).
 *
 * F1-003 will likely restructure this into nested routes (a layout
 * route wrapping the authenticated screens with <ProtectedRoute>) —
 * this flat structure is intentionally simple for now.
 */

import { createBrowserRouter, Navigate } from 'react-router-dom';
import { PlaceholderScreen } from './screens/PlaceholderScreen';
import { LoginScreen } from './screens/LoginScreen';
import { RegisterScreen } from './screens/RegisterScreen';

export const router = createBrowserRouter([
  { path: '/login',                element: <LoginScreen /> },
  { path: '/register',             element: <RegisterScreen /> },
  { path: '/onboarding',           element: <PlaceholderScreen name="/onboarding" /> },
  { path: '/chat',                 element: <PlaceholderScreen name="/chat" /> },
  { path: '/chat/:conversationId', element: <PlaceholderScreen name="/chat/:conversationId" /> },
  { path: '/memories',             element: <PlaceholderScreen name="/memories" /> },
  { path: '/memories/:id',         element: <PlaceholderScreen name="/memories/:id" /> },
  { path: '/trends',               element: <PlaceholderScreen name="/trends" /> },
  { path: '/settings',             element: <PlaceholderScreen name="/settings" /> },

  // Sensible default — F1-003's <ProtectedRoute> will guard this properly
  { path: '/', element: <Navigate to="/chat" replace /> },

  { path: '*', element: <PlaceholderScreen name="404 Not Found" /> },
]);
