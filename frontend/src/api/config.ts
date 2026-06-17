/**
 * src/api/config.ts
 *
 * Reads the API base URL from the environment. No URL is ever
 * hardcoded in source — see .env.local.example for the variable name.
 */

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

if (!API_BASE_URL) {
  throw new Error(
    'VITE_API_BASE_URL is not set. Copy .env.local.example to .env.local ' +
    'and set it to your backend URL (e.g. http://localhost:3000).',
  );
}
