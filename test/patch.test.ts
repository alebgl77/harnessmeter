/**
 * The patch generator, tested by applying what it produces.
 *
 * A diff that looks right and does not apply is worse than no diff, and a diff that applies
 * to the wrong lines is worse still — it silently edits a memory file. So these tests build
 * real repositories, run the real `git apply`, and check the file afterwards. Where the
 * generator refuses, they check that it refused for the right reason.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPatch, draftDescription, skillSlug } from '../src/patch.ts';
import { extractProseClaims } from '../src/harness.ts';
import type { Claim, Proposal } from '../src/types.ts';

const NL = String.fromCharCode(10);

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function repo(lines: string[], eol = NL): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-patch-')));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), lines.join(eol) + eol, 'utf8');
  return dir;
}

const MEMORY = [
  '# Alpha',
  'The first section, which the agent uses constantly and must be kept here.',
  '',
  '# Beta',
  'A section nothing was ever observed to need, long enough to be a claim.',
  'It has a second line so the removal spans more than one.',
  '',
  '# Gamma',
  'The last section, also kept, and long enough to survive the trivia filter.',
];

/** Claims read from the real file, so line ranges are the ones the scanner produces. */
function claimsFor(dir: string): Claim[] {
  return extractProseClaims(path.join(dir, 'CLAUDE.md'), 'project');
}

function demotion(c: Claim, saving = 1234): Proposal {
  return {
    claimId: c.id,
    label: c.label,
    action: 'demote',
    savingPerSession: saving,
    receipt: {
      tier: 'T1', sessions: 40, firedIn: 0, class: 'workflow',
      protected: false, confidence: 'high', boundPct: 7.2,
    },
  };
}

function bodiesFor(claims: Claim[], dir: string): Map<string, string> {
  const text = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').split(/\r?\n/);
  return new Map(
    claims.map((c) => [c.id, text.slice(c.source.startLine - 1, c.source.endLine).join(NL).trim()]),
  );
}

function apply(dir: string, patch: string): void {
  const file = path.join(dir, 'p.patch');
  fs.writeFileSync(file, patch, 'utf8');
  execFileSync('git', ['apply', '--check', 'p.patch'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['apply', 'p.patch'], { cwd: dir, stdio: 'pipe' });
  fs.rmSync(file);
}

test('a demotion produces a patch that applies and moves the section', () => {
  if (!hasGit()) return;
  const dir = repo(MEMORY);
  const claims = claimsFor(dir);
  const beta = claims.find((c) => c.label.endsWith('Beta'))!;
  const set = buildPatch({ claims, proposals: [demotion(beta)], bodies: bodiesFor(claims, dir), root: dir, scope: 'project', skillDir: '.claude/skills' });

  assert.equal(set.skipped.length, 0, JSON.stringify(set.skipped));
  assert.equal(set.entries.length, 1);
  apply(dir, set.text);

  const after = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.doesNotMatch(after, /# Beta/, 'the section left the memory file');
  assert.match(after, /# Alpha/, 'the others stayed');
  assert.match(after, /# Gamma/);

  // git applies with whatever line endings the repository is configured for, so the shape
  // is asserted line by line rather than as one string.
  const skill = fs.readFileSync(path.join(dir, '.claude/skills/beta/SKILL.md'), 'utf8');
  const head = skill.split(/\r?\n/);
  assert.equal(head[0], '---');
  assert.equal(head[1], 'name: beta');
  // Single-quoted YAML: a double-quoted scalar reads backslashes, and a memory file is
  // full of them (a regex, a Windows path, an escaped pipe in a table).
  assert.match(head[2], /^description: 'Use when working on beta\./);
  assert.equal(head[3], '---');
  assert.match(skill, /nothing was ever observed to need/, 'the body moved, whole');
});

test('two demotions in one file both apply', () => {
  if (!hasGit()) return;
  const dir = repo(MEMORY);
  const claims = claimsFor(dir);
  const picked = claims.filter((c) => /Beta|Gamma/.test(c.label));
  assert.equal(picked.length, 2);
  const set = buildPatch({
    claims,
    proposals: picked.map((c) => demotion(c)),
    bodies: bodiesFor(claims, dir),
    root: dir, scope: 'project', skillDir: '.claude/skills',
  });
  assert.equal(set.skipped.length, 0, JSON.stringify(set.skipped));
  apply(dir, set.text);

  const after = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(after, /# Alpha/);
  assert.doesNotMatch(after, /# Beta/);
  assert.doesNotMatch(after, /# Gamma/);
  assert.ok(fs.existsSync(path.join(dir, '.claude/skills/beta/SKILL.md')));
  assert.ok(fs.existsSync(path.join(dir, '.claude/skills/gamma/SKILL.md')));
});

test('a CRLF memory file is patched byte for byte', () => {
  if (!hasGit()) return;
  // Splitting on /\r?\n/ when emitting would drop the carriage returns and the patch would
  // not apply to the file it was generated from. This is the default on Windows.
  const dir = repo(MEMORY, '\r\n');
  const claims = claimsFor(dir);
  const beta = claims.find((c) => c.label.endsWith('Beta'))!;
  const set = buildPatch({ claims, proposals: [demotion(beta)], bodies: bodiesFor(claims, dir), root: dir, scope: 'project', skillDir: '.claude/skills' });
  assert.equal(set.skipped.length, 0, JSON.stringify(set.skipped));
  apply(dir, set.text);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /# Beta/);
});

test('a section edited since the scan is refused, not patched hopefully', () => {
  if (!hasGit()) return;
  const dir = repo(MEMORY);
  const claims = claimsFor(dir);
  const beta = claims.find((c) => c.label.endsWith('Beta'))!;
  const bodies = bodiesFor(claims, dir);
  // Someone rewrites the file between the scan and the patch.
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), ['# Alpha', 'Entirely different content now.'].join(NL) + NL, 'utf8');

  const set = buildPatch({ claims, proposals: [demotion(beta)], bodies, root: dir, scope: 'project', skillDir: '.claude/skills' });
  assert.equal(set.entries.length, 0);
  assert.equal(set.text, '');
  assert.match(set.skipped[0].reason, /changed since the scan/);
});

test('a claim outside the root is skipped rather than reaching out of it', () => {
  const dir = repo(MEMORY);
  const elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-other-')));
  const claims = claimsFor(dir);
  const beta = claims.find((c) => c.label.endsWith('Beta'))!;
  const set = buildPatch({
    claims,
    proposals: [demotion(beta)],
    bodies: bodiesFor(claims, dir),
    root: elsewhere, scope: 'project', skillDir: '.claude/skills',
  });
  assert.equal(set.entries.length, 0);
  assert.match(set.skipped[0].reason, /^lives outside /);
});

test('an existing skill is never overwritten', () => {
  const dir = repo(MEMORY);
  fs.mkdirSync(path.join(dir, '.claude/skills/beta'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/skills/beta/SKILL.md'), 'mine', 'utf8');
  const claims = claimsFor(dir);
  const beta = claims.find((c) => c.label.endsWith('Beta'))!;
  const set = buildPatch({ claims, proposals: [demotion(beta)], bodies: bodiesFor(claims, dir), root: dir, scope: 'project', skillDir: '.claude/skills' });
  assert.equal(set.entries.length, 0);
  assert.match(set.skipped[0].reason, /already exists/);
  assert.equal(fs.readFileSync(path.join(dir, '.claude/skills/beta/SKILL.md'), 'utf8'), 'mine');
});

test('two sections wanting the same skill name do not collide', () => {
  if (!hasGit()) return;
  const dir = repo(['# Rules', 'The first rules block, long enough to be a claim of its own.', '# Rules', 'The second rules block, long enough to be a claim of its own too.']);
  const claims = claimsFor(dir);
  assert.equal(claims.length, 2);
  const set = buildPatch({
    claims,
    proposals: claims.map((c) => demotion(c)),
    bodies: bodiesFor(claims, dir),
    root: dir, scope: 'project', skillDir: '.claude/skills',
  });
  assert.equal(set.entries.length, 1, 'only the first takes the name');
  assert.match(set.skipped[0].reason, /already claims skills\/rules/);
  apply(dir, set.text);
});

test('only demotions are patched', () => {
  const dir = repo(MEMORY);
  const claims = claimsFor(dir);
  const beta = claims.find((c) => c.label.endsWith('Beta'))!;
  const evict: Proposal = { ...demotion(beta), action: 'evict' };
  const set = buildPatch({ claims, proposals: [evict], bodies: bodiesFor(claims, dir), root: dir, scope: 'project', skillDir: '.claude/skills' });
  assert.equal(set.entries.length, 0);
  assert.equal(set.skipped.length, 0, 'an eviction is not a refusal, it is a different action');
});

test('nothing to demote produces no patch at all', () => {
  const dir = repo(MEMORY);
  const claims = claimsFor(dir);
  const set = buildPatch({ claims, proposals: [], bodies: bodiesFor(claims, dir), root: dir, scope: 'project', skillDir: '.claude/skills' });
  assert.equal(set.text, '');
  assert.equal(set.entries.length, 0);
});

test('the patch says what a description decides before it says anything else', () => {
  if (!hasGit()) return;
  const dir = repo(MEMORY);
  const claims = claimsFor(dir);
  const beta = claims.find((c) => c.label.endsWith('Beta'))!;
  const set = buildPatch({ claims, proposals: [demotion(beta)], bodies: bodiesFor(claims, dir), root: dir, scope: 'project', skillDir: '.claude/skills' });
  const head = set.text.slice(0, set.text.indexOf('diff --git'));
  assert.match(head, /Nothing here has been applied/);
  assert.match(head, /READ THE DESCRIPTIONS BEFORE APPLYING/);
  assert.match(head, /silence the rule/);
});

test('a drafted description names the heading and quotes the author', () => {
  const d = draftDescription('CLAUDE.md § Release process', 'Tag only from main. Never publish from a branch.');
  assert.match(d, /release process/);
  assert.match(d, /Tag only from main\./);
});

test('a slug is stable, lowercase and never empty', () => {
  assert.equal(skillSlug('CLAUDE.md § Release Process'), 'release-process');
  assert.equal(skillSlug('CLAUDE.md § Release Process'), skillSlug('CLAUDE.md § Release  Process'));
  assert.equal(skillSlug('§ ***'), 'demoted-section');
});

test('an applied demotion can be undone', () => {
  if (!hasGit()) return;
  // The safety net that makes this reviewable rather than irreversible: a reader who
  // applies it, dislikes the result and reverses it must get their file back exactly.
  const dir = repo(MEMORY);
  const before = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  const claims = claimsFor(dir);
  const beta = claims.find((c) => c.label.endsWith('Beta'))!;
  const set = buildPatch({ claims, proposals: [demotion(beta)], bodies: bodiesFor(claims, dir), root: dir, scope: 'project', skillDir: '.claude/skills' });

  fs.writeFileSync(path.join(dir, 'p.patch'), set.text, 'utf8');
  execFileSync('git', ['apply', 'p.patch'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['apply', '-R', 'p.patch'], { cwd: dir, stdio: 'pipe' });

  // Content, not bytes: git rewrites line endings on apply according to the repository's
  // own configuration, which is its business and not the patch's.
  const norm = (s: string) => s.replace(/\r\n/g, NL);
  assert.equal(norm(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')), norm(before));
  assert.equal(fs.existsSync(path.join(dir, '.claude/skills/beta/SKILL.md')), false);
});

test('three removals from one file carry the right cumulative offset', () => {
  if (!hasGit()) return;
  // Each hunk's + side is expressed against the file as it will be, so every removal
  // shifts the ones after it. Getting this wrong produces a patch that applies to the
  // wrong lines rather than one that fails loudly.
  const body = (n: string) => 'Section ' + n + ' body, long enough to survive the filter.';
  const dir = repo(['# A', body('A'), '', '# B', body('B'), '', '# C', body('C'), '', '# D', body('D'), '', '# E', body('E')]);
  const claims = claimsFor(dir);
  const title = (c: Claim) => c.label.slice(c.label.lastIndexOf('§ ') + 2).trim();
  const picked = claims.filter((c) => ['B', 'C', 'E'].includes(title(c)));
  assert.equal(picked.length, 3);

  const set = buildPatch({ claims, proposals: picked.map((c) => demotion(c)), bodies: bodiesFor(claims, dir), root: dir, scope: 'project', skillDir: '.claude/skills' });
  assert.equal(set.skipped.length, 0, JSON.stringify(set.skipped));
  apply(dir, set.text);

  const after = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  for (const gone of ['B', 'C', 'E']) assert.doesNotMatch(after, new RegExp('^# ' + gone + '$', 'm'));
  for (const kept of ['A', 'D']) assert.match(after, new RegExp('^# ' + kept + '$', 'm'));
});

test('a section whose body looks like a diff is moved intact', () => {
  if (!hasGit()) return;
  // A memory file that documents patches contains lines starting with - and +, and an
  // @@ header. Emitted without care they read as diff syntax and corrupt the hunk.
  const dir = repo([
    '# Keep',
    'The section that stays, long enough to survive the trivia filter here.',
    '',
    '# Patchwork',
    '-a removed line lookalike',
    '+an added line lookalike',
    '@@ -1,2 +3,4 @@',
    'diff --git a/x b/x',
    'and prose to make the section long enough to count as a claim.',
  ]);
  const claims = claimsFor(dir);
  const target = claims.find((c) => c.label.endsWith('Patchwork'))!;
  const set = buildPatch({ claims, proposals: [demotion(target)], bodies: bodiesFor(claims, dir), root: dir, scope: 'project', skillDir: '.claude/skills' });
  apply(dir, set.text);

  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /Patchwork/);
  const skill = fs.readFileSync(path.join(dir, '.claude/skills/patchwork/SKILL.md'), 'utf8');
  // Compared as plain text: these lines are diff syntax, and writing them as regexes here
  // would only be a second chance to get the escaping wrong.
  assert.ok(skill.includes('-a removed line lookalike'));
  assert.ok(skill.includes('+an added line lookalike'));
  assert.ok(skill.includes('@@ -1,2 +3,4 @@'));
  assert.ok(skill.includes('diff --git a/x b/x'));
});

test('a file with no trailing newline is patched at either end', () => {
  if (!hasGit()) return;
  const lines = ['# One', 'The first section, long enough to survive the trivia filter.', '', '# Two', 'The second, also long enough to survive the trivia filter here.'];
  for (const target of ['One', 'Two']) {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-eof-')));
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), lines.join(NL), 'utf8'); // no final newline
    const claims = claimsFor(dir);
    const c = claims.find((x) => x.label.endsWith(target))!;
    const set = buildPatch({ claims, proposals: [demotion(c)], bodies: bodiesFor(claims, dir), root: dir, scope: 'project', skillDir: '.claude/skills' });
    assert.equal(set.skipped.length, 0, target + ': ' + JSON.stringify(set.skipped));
    apply(dir, set.text);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), new RegExp('^# ' + target + '$', 'm'));
  }
});

// ── the two defects an adversarial review found, pinned ─────────────────────────────

/**
 * Read a YAML single-quoted scalar the way a parser does: no escapes exist inside one,
 * and a doubled quote is a literal quote. Ten lines is cheaper than a dependency, and the
 * point is precisely that the frontmatter must be readable by something that is not us.
 */
function readSingleQuoted(line: string): string {
  const m = /^description: '(.*)'$/.exec(line);
  assert.ok(m, 'the description must be a single-quoted scalar, got: ' + line);
  const raw = m[1];
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "'") {
      // Inside a single-quoted scalar the only special sequence is a doubled quote.
      assert.equal(raw[i + 1], "'", 'a bare quote would end the scalar early: ' + line);
      out += "'";
      i++;
    } else out += raw[i];
  }
  return out;
}

test('a backslash in the section survives into loadable frontmatter', () => {
  if (!hasGit()) return;
  // A double-quoted YAML scalar reads backslash escapes, and a memory file is full of
  // them. Unparseable frontmatter means the skill never loads -- while the same patch has
  // already deleted the section from the memory file. The rule disappears, silently.
  for (const sentence of [
    'Every log line must match \d{4}-\d{2} before it is accepted anywhere at all.',
    'Build output belongs in C:\Users\ci\out and nowhere else on the machine here.',
    'A table cell containing a pipe must be escaped as \| or the row breaks apart.',
    'Someone wrote \\"work email\\" here and the quoting has to survive that too ok.',
  ]) {
    const dir = repo(['# Keep', 'The section that stays, long enough to survive the filter.', '', '# Escapes', sentence]);
    const claims = claimsFor(dir);
    const target = claims.find((c) => c.label.endsWith('Escapes'))!;
    const set = buildPatch({
      claims, proposals: [demotion(target)], bodies: bodiesFor(claims, dir),
      root: dir, scope: 'project', skillDir: '.claude/skills',
    });
    apply(dir, set.text);

    const lines = fs.readFileSync(path.join(dir, '.claude/skills/escapes/SKILL.md'), 'utf8').split(/\r?\n/);
    const value = readSingleQuoted(lines[2]);
    assert.match(value, /^Use when working on escapes\./);
    assert.doesNotMatch(value, /[\u0000-\u001f]/, 'a description is one line');
  }
});

test("a quote in the section does not end the scalar early", () => {
  if (!hasGit()) return;
  const dir = repo(['# Keep', 'The section that stays, long enough to survive the filter.', '', '# Quoting', "Don't put the user's token in the log, and don't log the user's id."]);
  const claims = claimsFor(dir);
  const target = claims.find((c) => c.label.endsWith('Quoting'))!;
  const set = buildPatch({
    claims, proposals: [demotion(target)], bodies: bodiesFor(claims, dir),
    root: dir, scope: 'project', skillDir: '.claude/skills',
  });
  apply(dir, set.text);
  const lines = fs.readFileSync(path.join(dir, '.claude/skills/quoting/SKILL.md'), 'utf8').split(/\r?\n/);
  assert.match(readSingleQuoted(lines[2]), /Don't put the user's token/);
});

test('a project section never lands in the user patch', () => {
  // A project normally lives INSIDE the home directory, so a containment test admits every
  // project section into the user patch as well -- and writes its skill into the
  // machine-wide skills directory, putting one project's rule in every other project's
  // always-on prefix. Scope is what decides, not the path.
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-home-')));
  const project = path.join(home, 'code', 'app');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), MEMORY.join(NL) + NL, 'utf8');

  const claims = extractProseClaims(path.join(project, 'CLAUDE.md'), 'project');
  const beta = claims.find((c) => c.label.endsWith('Beta'))!;
  const bodies = bodiesFor(claims, project);

  const userSet = buildPatch({
    claims, proposals: [demotion(beta)], bodies,
    root: home, scope: 'user', skillDir: 'skills',
  });
  assert.equal(userSet.entries.length, 0, 'a project claim is not the user patch business');
  assert.equal(userSet.text, '');

  const projectSet = buildPatch({
    claims, proposals: [demotion(beta)], bodies,
    root: project, scope: 'project', skillDir: '.claude/skills',
  });
  assert.equal(projectSet.entries.length, 1);
  assert.equal(projectSet.entries[0].skillPath, '.claude/skills/beta/SKILL.md');
});

test('a user section lands under the user skills directory, not a nested .claude', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-uhome-')));
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), MEMORY.join(NL) + NL, 'utf8');
  const claims = extractProseClaims(path.join(home, 'CLAUDE.md'), 'user');
  const beta = claims.find((c) => c.label.endsWith('Beta'))!;
  const set = buildPatch({
    claims, proposals: [demotion(beta)], bodies: bodiesFor(claims, home),
    root: home, scope: 'user', skillDir: 'skills',
  });
  assert.equal(set.entries.length, 1);
  assert.equal(set.entries[0].skillPath, 'skills/beta/SKILL.md');
});

test('a description is not built out of a code fence', () => {
  const body = ['# Deploy', '```bash', 'kubectl rollout restart deployment/api --namespace prod', '```',
                'Do this only after the migration job reports success in the dashboard.'].join(NL);
  const d = draftDescription('CLAUDE.md § Deploy', body);
  assert.doesNotMatch(d, /kubectl/, 'a shell command says nothing about when a rule applies');
  assert.match(d, /migration job reports success/);
});
