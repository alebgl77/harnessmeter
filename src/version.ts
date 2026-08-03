/**
 * Single source of truth for the version shown to users — the help text, the terminal
 * header and the HTML footer all read it from here rather than carrying their own copy.
 *
 * package.json sits at the same relative path from both `src/` and `dist/`, so one lookup
 * serves the source checkout and the compiled entry point alike.
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
