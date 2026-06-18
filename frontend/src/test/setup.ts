/**
 * src/test/setup.ts
 *
 * Loaded once before the test suite via vitest.config.ts's setupFiles.
 */

import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// RTL's automatic cleanup relies on a global afterEach being registered;
// since vitest.config.ts uses globals: false, we register it explicitly.
afterEach(() => {
  cleanup();
});
