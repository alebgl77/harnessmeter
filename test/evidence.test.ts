/**
 * Regression tests for the ways this tool can manufacture a false verdict.
 *
 * Every case here corresponds to a bug that shipped. The project's whole claim is that its
 * numbers are honest, so a wrong verdict is not a cosmetic defect — it is the product
 * failing at the only thing it does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runEvidence } from '../src/evidence.ts';
import { mergeT2, type T2Result } from '../src/evidence-t2.ts';
import type { Claim, ClaimEvidence, Session, Turn } from '../src/types.ts';

function turn(tools: string[] = [], commands: string[] = []): Turn {
  return {
    model: 'claude-opus-5',
    usage: {
      inputTokens: 1,
      cacheReadTokens: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      outputTokens: 1,
    },
    tools,
    commands,
  };
}

function session(project: string, turns: Turn[], skills: string[] = []): Session {
  return {
    id: `${project}-${Math.random().toString(36).slice(2, 8)}`,
    project,
    turns,
    skillsUsed: new Set(skills),
    mcpServersUsed: new Set(),
    subagentsUsed: new Set(),
    firstTurnPromptTokens: 1000,
  };
}

function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: 'c1',
    label: 'CLAUDE.md § Testing',
    kind: 'prose-section',
    scope: 'project',
    class: 'workflow',
    classInferred: true,
    loading: 'always-on',
    source: { file: 'CLAUDE.md', startLine: 1, endLine: 3 },
    chars: 100,
    estTokens: 26,
    alwaysOnTokens: 26,
    protected: false,
    ...over,
  };
}

// ── commands must actually be checked ───────────────────────────────────────────────

test('a rule prescribing a command is confirmed by the shell trace', () => {
  const c = claim({ id: 'cmd-hit' });
  const ev = runEvidence({
    claims: [c],
    sessions: [session('p', [turn(['Bash'], ['npm test -- --watch=false'])])],
    bodies: new Map([[c.id, 'Always run npm test before committing.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.tier, 'T1');
  assert.equal(ev.verdict, 'load-bearing');
  assert.equal(ev.firedIn, 1);
});

test('a rule prescribing a command that never ran is ballast', () => {
  const c = claim({ id: 'cmd-miss' });
  const ev = runEvidence({
    claims: [c],
    sessions: [session('p', [turn(['Bash'], ['git status'])])],
    bodies: new Map([[c.id, 'Always run npm test before committing.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.verdict, 'ballast');
  assert.equal(ev.firedIn, 0);
});

test('command rules are not judged on tool names alone', () => {
  // Every shell call is named "Bash". Before commands were read, a command-only rule was
  // guaranteed zero hits and therefore guaranteed false ballast.
  const c = claim({ id: 'cmd-only' });
  const evidence = runEvidence({
    claims: [c],
    sessions: [session('p', [turn(['Bash'], ['pytest -q'])])],
    bodies: new Map([[c.id, 'Run pytest after each change.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.notEqual(evidence.verdict, 'ballast');
  assert.match(evidence.note, /command/);
});

// ── scope: a claim is only judged where it was loaded ────────────────────────────────

test('a project claim is not judged against another project\'s sessions', () => {
  const c = claim({ id: 'proj', scope: 'project' });
  const sessions = [
    session('mine', [turn(['Bash'], ['npm test'])]),
    ...Array.from({ length: 20 }, () => session('other', [turn(['Read'])])),
  ];
  const ev = runEvidence({
    claims: [c],
    sessions,
    bodies: new Map([[c.id, 'Always run npm test.']]),
    currentProject: 'mine',
  }).get(c.id)!;
  // Only the one in-scope session counts, so the rule fired in 1 of 1 — not 1 of 21.
  assert.equal(ev.observedIn, 1);
  assert.equal(ev.firedIn, 1);
  assert.equal(ev.verdict, 'load-bearing');
});

test('a user claim is judged against every session', () => {
  const c = claim({ id: 'user', scope: 'user' });
  const sessions = [
    session('mine', [turn(['Bash'], ['npm test'])]),
    session('other', [turn(['Read'])]),
  ];
  const ev = runEvidence({
    claims: [c],
    sessions,
    bodies: new Map([[c.id, 'Always run npm test.']]),
    currentProject: 'mine',
  }).get(c.id)!;
  assert.equal(ev.observedIn, 2);
  assert.equal(ev.firedIn, 1);
});

test('no sessions in scope yields unproven, never ballast', () => {
  const c = claim({ id: 'orphan', scope: 'project' });
  const ev = runEvidence({
    claims: [c],
    sessions: [session('elsewhere', [turn(['Read'])])],
    bodies: new Map([[c.id, 'Always run npm test.']]),
    currentProject: 'mine',
  }).get(c.id)!;
  assert.equal(ev.verdict, 'unproven');
  assert.equal(ev.observedIn, 0);
});

test('skill presence is scoped the same way', () => {
  const skill = claim({ id: 'p:skill:x', label: 'skill/x', kind: 'skill', scope: 'project', loading: 'on-demand' });
  const ev = runEvidence({
    claims: [skill],
    sessions: [session('mine', [turn()], ['x']), session('other', [turn()])],
    bodies: new Map(),
    currentProject: 'mine',
  }).get(skill.id)!;
  assert.equal(ev.verdict, 'load-bearing');
  assert.equal(ev.observedIn, 1);
});

// ── a protected claim is never condemned ────────────────────────────────────────────

test('a prevention claim stays protected whatever the evidence says', () => {
  const c = claim({ id: 'prev', protected: true, class: 'prevention' });
  const ev = runEvidence({
    claims: [c],
    sessions: [session('p', [turn(['Read'])])],
    bodies: new Map([[c.id, 'Never commit a secret.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.verdict, 'protected');
});

// ── T2: absence of occasion is not evidence of uselessness ──────────────────────────

function t2With(outcome: string): T2Result {
  return {
    verdicts: new Map([['c1', { id: 'c1', outcome: outcome as never, confidence: 'high', why: 'x' }]]),
    costUsd: 0,
    tokens: 0,
    calls: 1,
    model: 'sonnet',
  };
}

function baseEvidence(): Map<string, ClaimEvidence> {
  return new Map([
    ['c1', { claimId: 'c1', tier: 'none', verdict: 'unproven', firedIn: 0, observedIn: 5, note: '' }],
  ]);
}

test('T2 not-applicable does not condemn the claim', () => {
  const ev = baseEvidence();
  mergeT2(ev, t2With('not-applicable'), [claim()]);
  assert.equal(ev.get('c1')!.verdict, 'unproven');
  assert.match(ev.get('c1')!.note, /not evidence either way/);
});

test('T2 violated is ballast — present and ignored', () => {
  const ev = baseEvidence();
  mergeT2(ev, t2With('violated'), [claim()]);
  assert.equal(ev.get('c1')!.verdict, 'ballast');
});

test('T2 complied is load-bearing', () => {
  const ev = baseEvidence();
  mergeT2(ev, t2With('complied'), [claim()]);
  assert.equal(ev.get('c1')!.verdict, 'load-bearing');
});

test('T2 cannot override a protected claim', () => {
  const ev = baseEvidence();
  mergeT2(ev, t2With('violated'), [claim({ protected: true })]);
  assert.equal(ev.get('c1')!.verdict, 'unproven');
});
