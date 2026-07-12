/**
 * src/test/setup.ts
 *
 * Loaded once before the test suite via vitest.config.ts's setupFiles.
 */

import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// ── TypeScript require() support ──────────────────────────────────────────────
// Some test files use CJS-style require() inside function bodies (a Jest-era
// pattern) to dynamically access module state between tests. Vitest runs in
// ESM mode so Node.js's native require() can't load .ts files by default.
// We register a .ts extension handler backed by typescript's transpileModule
// (already a dev dep) so those calls work without additional packages.
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

type CjsMod = { _compile(code: string, filename: string): void };
const extensions = (Module as unknown as { _extensions: Record<string, (m: CjsMod, f: string) => void> })._extensions;
extensions['.ts'] = (mod, filename) => {
  const src = readFileSync(filename, 'utf-8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  mod._compile(outputText, filename);
};

// ── window.matchMedia stub (jsdom doesn't implement it) ───────────────────────
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media:   query,
    onchange: null,
    addEventListener:    () => {},
    removeEventListener: () => {},
    dispatchEvent:       () => false,
  }),
});

// RTL's automatic cleanup relies on a global afterEach being registered;
// since vitest.config.ts uses globals: false, we register it explicitly.
afterEach(() => {
  cleanup();
});
