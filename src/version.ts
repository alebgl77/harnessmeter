/**
 * Single source of truth for the version shown to users.
 *
 * Hard-coding it in the help text, the terminal header and the HTML footer meant three
 * places to forget, and 0.1.1 shipped announcing itself as 0.1.0. package.json sits at the
 * same relative path from both `src/` and `dist/`, so one lookup covers both entry points.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(): string {
  try {
    const pkg = fileURLToPath(new URL('../package.json', import.meta.url));
    const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version) return parsed.version;
  } catch {
    /* fall through */
  }
  return '0.0.0-unknown';
}

export const VERSION = read();
