/**
 * The release workflow, tested as an artifact rather than as prose.
 *
 * GitHub substitutes `${{ }}` expressions textually before the shell parses the line, so an
 * expression inside a `run:` block turns a dispatch input — or a tag name, which may
 * legally contain shell metacharacters — into executable text. These tests read the
 * shipped YAML and assert the property directly, and they exercise the version guard the
 * workflow actually contains rather than a copy of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const yaml = fs.readFileSync(FILE, 'utf8');

/** Every `run:` block body, keyed by the step name above it where we can find one. */
function runBlocks(text: string): { name: string; body: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { name: string; body: string }[] = [];
  let name = '(unnamed)';
  for (let i = 0; i < lines.length; i++) {
    const named = /^\s*-?\s*name:\s*(.+?)\s*$/.exec(lines[i]);
    if (named) name = named[1];
    const run = /^(\s*)run:\s*\|?\s*(.*)$/.exec(lines[i]);
    if (!run) continue;
    const indent = run[1].length;
    const body: string[] = run[2] ? [run[2]] : [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') { body.push(''); continue; }
      const lead = l.length - l.trimStart().length;
      if (lead <= indent) break;
      body.push(l);
    }
    out.push({ name, body: body.join('\n') });
  }
  return out;
}

test('no GitHub expression is interpolated into a shell block', () => {
  for (const { name, body } of runBlocks(yaml)) {
    assert.doesNotMatch(
      body,
      /\$\{\{/,
      `step "${name}" interpolates a GitHub expression into its shell body; pass it via env: instead`,
    );
  }
});

test('the dispatch input is read only through an env binding', () => {
  // A flat "does `run:` appear anywhere before `inputs.version`" regex reports a false
  // positive on this very file, whose header comment explains the rule. So check the
  // occurrences instead: every use of the input must be the right-hand side of an env key.
  const uses = [...yaml.matchAll(/\$\{\{\s*inputs\.version\s*\}\}/g)];
  assert.ok(uses.length > 0, 'the workflow no longer reads inputs.version');
  for (const u of uses) {
    const line = yaml.slice(0, u.index).split('\n').length;
    const text = yaml.split('\n')[line - 1];
    assert.match(
      text,
      /^\s+[A-Z_][A-Z0-9_]*:\s*\$\{\{\s*inputs\.version\s*\}\}\s*$/,
      `inputs.version is used outside an env binding on line ${line}: ${text}`,
    );
  }
});

test('values that reach the shell are declared as env', () => {
  for (const key of ['INPUT_VERSION', 'PUSH_REF', 'RELEASE_REF', 'EVENT_NAME']) {
    assert.match(yaml, new RegExp(`${key}:\\s*\\$\\{\\{`), `${key} should be bound via env:`);
  }
});

// ── the version guard, taken from the workflow itself ────────────────────────────────

/** The ERE the workflow greps with, and the charset guard that precedes it. */
function guards(): { semver: RegExp; charset: RegExp } {
  const m = /grep -Eq '([^']+)'/.exec(yaml);
  assert.ok(m, 'could not find the semver guard in the workflow');
  return {
    semver: new RegExp(m[1]),
    // `case "$version" in '' | *[!0-9A-Za-z.+-]*)` — anything outside the class is rejected.
    charset: /^[0-9A-Za-z.+-]+$/,
  };
}

const accepts = (v: string) => {
  const { semver, charset } = guards();
  // grep runs line by line, so the charset guard is what actually rejects a multi-line
  // value. Both must pass, in this order, exactly as the workflow applies them.
  if (!charset.test(v)) return false;
  return v.split('\n').some((line) => semver.test(line));
};

test('valid semantic versions are accepted', () => {
  for (const v of ['0.1.3', '1.0.0', '2.4.0-beta.1', '2.4.0+build.5', '10.20.30']) {
    assert.equal(accepts(v), true, `${JSON.stringify(v)} should be accepted`);
  }
});

test('a branch name is refused', () => {
  assert.equal(accepts('main'), false);
});

test('a leading v is refused — the workflow adds it', () => {
  assert.equal(accepts('v0.1.3'), false);
});

test('an incomplete version is refused', () => {
  assert.equal(accepts('0.1'), false);
  assert.equal(accepts(''), false);
});

test('shell metacharacters are refused', () => {
  for (const v of ['0.1.3"', '0.1.3; echo injected', '0.1.3$(touch file)', '0.1.3`id`', "0.1.3'"]) {
    assert.equal(accepts(v), false, `${JSON.stringify(v)} should be refused`);
  }
});

test('a multi-line value is refused even though its first line is valid', () => {
  // The case the charset guard exists for: a line-oriented grep would accept this and the
  // second line would then be written into GITHUB_OUTPUT.
  assert.equal(accepts('0.1.3\nune-seconde-ligne'), false);
  assert.equal(accepts('0.1.3\nref=refs/tags/vevil'), false);
});

// ── structural invariants of the release path ───────────────────────────────────────

test('publishing is restricted to tag refs', () => {
  assert.match(yaml, /refs\/tags\/v\*\)\s*;;/);
  assert.match(yaml, /refusing to publish from/);
});

test('the published tarball is checked against the digest recorded at verification', () => {
  assert.match(yaml, /sha256sum harnessmeter\.tgz/);
  assert.match(yaml, /sha256sum --check harnessmeter\.tgz\.sha256/);
  const publishAt = yaml.indexOf('npm publish harnessmeter.tgz');
  const checkAt = yaml.indexOf('sha256sum --check');
  assert.ok(checkAt > 0 && checkAt < publishAt, 'the digest must be checked before publishing');
});

test('the publish job declares no environment', () => {
  const publish = yaml.slice(yaml.indexOf('  publish:'));
  assert.doesNotMatch(publish, /^\s{4}environment:/m);
});

test('every action is pinned to a commit sha', () => {
  const uses = [...yaml.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const u of uses) {
    assert.match(u, /@[0-9a-f]{40}$/, `${u} is not pinned to a full commit sha`);
  }
});

test('the lockfile is required to be in sync before a release', () => {
  assert.match(yaml, /git diff --exit-code -- package-lock\.json/);
});
