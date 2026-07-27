#!/usr/bin/env node
/**
 * Entry point.
 *
 * Two ways in:
 *
 *   - Installed from npm: `dist/` is present and this loads compiled JavaScript. Node
 *     refuses to strip types for anything under node_modules, so a published package
 *     cannot ship TypeScript and expect it to run. Works on Node 20+.
 *
 *   - A git checkout: no `dist/`, so this loads `src/*.ts` directly and Node strips the
 *     types itself. No build step while developing, but that needs Node 22.18+, where
 *     stripping is unflagged.
 *
 * Either way the version is checked first, so nobody meets a bare syntax error.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIST = new URL('../dist/cli.js', import.meta.url);
const SOURCE = new URL('../src/cli.ts', import.meta.url);

const compiled = existsSync(fileURLToPath(DIST));
const MIN = compiled ? [20, 0, 0] : [22, 18, 0];

const parse = (v) => String(v).split('.').map((x) => parseInt(x, 10) || 0);

function older(a, b) {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) < (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) > (b[i] ?? 0)) return false;
  }
  return false;
}

if (older(parse(process.versions.node), MIN)) {
  const need = MIN.join('.');
  process.stderr.write(
    `\n  harnessmeter needs Node ${need} or newer — you are on ${process.versions.node}.\n\n` +
      (compiled
        ? ''
        : `  You are running from a source checkout, which relies on Node's native\n` +
          `  TypeScript stripping (unflagged since 22.18). The published package ships\n` +
          `  compiled JavaScript and runs on Node 20.\n\n`) +
      `    nvm install 22 && nvm use 22\n` +
      `    npx harnessmeter\n\n`,
  );
  process.exit(1);
}

import(compiled ? DIST.href : SOURCE.href).catch((err) => {
  process.stderr.write(`\n  harnessmeter failed to start: ${err?.message ?? err}\n\n`);
  process.exit(1);
});
