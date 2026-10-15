// Copies the single-file web app into Capacitor's webDir as index.html.
// The app is self-contained (inline CSS/JS, no external assets), so a copy
// is the whole build. The production API URL is the default in boot().
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const www  = join(root, 'www');

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
cpSync(join(root, '..', 'public', 'memo_app.html'), join(www, 'index.html'));
console.log('Copied public/memo_app.html -> mobile/www/index.html');
