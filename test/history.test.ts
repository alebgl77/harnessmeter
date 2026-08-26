/**
 * Dating a claim from the repository rather than the filesystem.
 *
 * The point is precision the filesystem cannot give: a modification time moves when
 * anything in the file changes, so editing the top of a CLAUDE.md re-dates every rule in
 * it and silently narrows the evidence each one is judged against. A commit knows which
 * lines it touched.
 *
 * These tests build real repositories with real commits at fixed dates. Nothing here is
 * mocked, because the thing under test is whether we read git correctly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resetHistoryCache, sectionChangedMs } from '../src/history.ts';
import { scanHarness } from '../src/harness.ts';

const NL = String.fromCharCode(10);
const DAY_ONE = '2026-01-10T12:00:00';
const DAY_TWO = '2026-06-20T12:00:00';

function git(cwd: string, args: string[], date?: string): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
    cwd,
    stdio: 'ignore',
    env: date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env,
  });
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A repo whose CLAUDE.md has two sections, the second edited months after the first. */
function repoWithTwoSections(): { dir: string; file: string } {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-git-')));
  git(dir, ['init', '-q']);
  const file = path.join(dir, 'CLAUDE.md');

  fs.writeFileSync(
    file,
    [
      '# Alpha',
      'The first section, long enough to survive the trivia filter, padded pad.',
      '',
      '# Beta',
      'The second section, long enough to survive the trivia filter, padded.',
    ].join(NL),
    'utf8',
  );
  git(dir, ['add', 'CLAUDE.md']);
  git(dir, ['commit', '-q', '-m', 'first'], DAY_ONE);

  // Only Beta changes.
  fs.writeFileSync(
    file,
    [
      '# Alpha',
      'The first section, long enough to survive the trivia filter, padded pad.',
      '',
      '# Beta',
      'The second section, rewritten later and still long enough to count here.',
    ].join(NL),
    'utf8',
  );
  git(dir, ['add', 'CLAUDE.md']);
  git(dir, ['commit', '-q', '-m', 'second'], DAY_TWO);

  resetHistoryCache();
  return { dir, file };
}

test('a section is dated by the commit that last touched it, not by the file', () => {
  if (!hasGit()) return;
  const { file } = repoWithTwoSections();

  const alpha = sectionChangedMs(file, 1, 3);
  const beta = sectionChangedMs(file, 4, 5);
  assert.ok(alpha, 'Alpha must have a date');
  assert.ok(beta, 'Beta must have a date');
  assert.equal(new Date(alpha).getUTCFullYear(), 2026);
  assert.ok(beta > alpha, 'the rewritten section must be the newer of the two');
  // The whole file's modification time cannot tell these apart.
  assert.ok(Math.abs(beta - Date.parse(DAY_TWO + 'Z')) < 48 * 3600 * 1000);
});

test('an uncommitted edit dates the section to now', () => {
  if (!hasGit()) return;
  const { file } = repoWithTwoSections();
  fs.appendFileSync(file, NL + 'A line added and never committed, long enough to matter.', 'utf8');
  resetHistoryCache();
  const now = Date.now();
  const changed = sectionChangedMs(file, 1, 10);
  assert.ok(changed, 'still dated');
  assert.ok(Math.abs(changed - now) < 10 * 60 * 1000, 'text that was never committed changed just now');
});

test('a file outside a repository has no git date', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-nogit-')));
  const file = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(file, '# Alone' + NL + 'No repository anywhere above this file at all.', 'utf8');
  resetHistoryCache();
  assert.equal(sectionChangedMs(file, 1, 2), undefined);
});

test('a missing file has no git date', () => {
  resetHistoryCache();
  assert.equal(sectionChangedMs(path.join(os.tmpdir(), 'hm-absent-nowhere.md'), 1, 2), undefined);
});

test('scanHarness dates a versioned claim by git and an unversioned one by mtime', () => {
  if (!hasGit()) return;
  const { dir } = repoWithTwoSections();

  // A user-scope harness that is deliberately not a repository, which is the normal case.
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-git-home-')));
  fs.writeFileSync(
    path.join(home, 'CLAUDE.md'),
    '# User' + NL + 'A user-scope rule, long enough to survive the trivia filter here.',
    'utf8',
  );

  const prev = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  resetHistoryCache();
  try {
    const claims = scanHarness(dir).claims;
    const beta = claims.find((c) => c.label.includes('Beta'));
    const user = claims.find((c) => c.label.includes('User'));
    assert.ok(beta, 'the project section was scanned');
    assert.ok(user, 'the user section was scanned');
    assert.equal(beta.source.datedBy, 'git');
    assert.equal(user.source.datedBy, 'mtime');
    assert.ok(beta.source.modifiedMs > 0);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = prev;
  }
});

test('git dating is precise where a file timestamp is not', () => {
  if (!hasGit()) return;
  const { file } = repoWithTwoSections();
  // Touching the file moves its mtime for every section at once; the commits do not move.
  const alphaBefore = sectionChangedMs(file, 1, 3);
  fs.utimesSync(file, new Date(), new Date());
  resetHistoryCache();
  const alphaAfter = sectionChangedMs(file, 1, 3);
  assert.equal(alphaAfter, alphaBefore, 'a touch is not an edit');
  assert.ok(fs.statSync(file).mtimeMs > (alphaAfter ?? 0), 'while the filesystem now says otherwise');
});
