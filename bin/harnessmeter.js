#!/usr/bin/env node
/**
 * Entry point.
 *
 * harnessmeter ships TypeScript and lets Node run it directly — no build step, no
 * dependencies. That requires native type stripping, which landed unflagged in Node 22.18.
 * On anything older the import fails with a raw syntax error, so we check first and say
 * something useful instead.
 */

const MIN = [22, 18, 0];

function parse(v) {
  return String(v).split('.').map((x) => parseInt(x, 10) || 0);
}

function older(a, b) {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) < (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) > (b[i] ?? 0)) return false;
  }
  return false;
}

const current = parse(process.versions.node);

if (older(current, MIN)) {
  process.stderr.write(
    `\n  harnessmeter needs Node ${MIN.join('.')} or newer — you are on ${process.versions.node}.\n\n` +
      `  It ships TypeScript with zero dependencies and no build step, which relies on\n` +
      `  Node's native type stripping (unflagged since 22.18).\n\n` +
      `    nvm install 22 && nvm use 22\n` +
      `    npx harnessmeter\n\n`,
  );
  process.exit(1);
}

import('../src/cli.ts').catch((err) => {
  process.stderr.write(`\n  harnessmeter failed to start: ${err?.message ?? err}\n\n`);
  process.exit(1);
});
