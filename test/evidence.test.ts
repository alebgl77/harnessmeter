/**
 * Verdict accuracy.
 *
 * The project's whole claim is that its numbers are honest, so a confident wrong verdict is
 * not a cosmetic defect — it is the product failing at the only thing it does. Each case
 * below pins one way a verdict could be reached on evidence that does not support it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { confidenceFor, runEvidence, zeroHitUpperBound } from '../src/evidence.ts';
import { mergeT2, type T2Result } from '../src/evidence-t2.ts';
import type { Claim, ClaimEvidence, Session, Turn } from '../src/types.ts';

function turn(tools: string[] = [], commands: string[] = [], timestamp?: string): Turn {
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
    timestamp,
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
    prefixWrites: 1,
    cacheTtl: '5m',
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
    source: { file: 'CLAUDE.md', startLine: 1, endLine: 3, modifiedMs: 0, datedBy: 'mtime' },
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

test('a rule prescribing a command that never ran, over enough sessions, is ballast', () => {
  const c = claim({ id: 'cmd-miss' });
  const ev = runEvidence({
    claims: [c],
    sessions: Array.from({ length: 30 }, () => session('p', [turn(['Bash'], ['git status'])])),
    bodies: new Map([[c.id, 'Always run npm test before committing.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.verdict, 'ballast');
  assert.equal(ev.firedIn, 0);
  // The verdict must carry the strength of the sample it rests on.
  assert.match(ev.note, /rules out a rate above/);
});

test('one quiet session does not condemn a rule', () => {
  // Never firing in a single session is consistent with a rule that fires 95% of the time.
  // Reporting that as ballast is not a measurement, and it is the fastest way to make a
  // user delete something that was working.
  const c = claim({ id: 'cmd-thin' });
  const ev = runEvidence({
    claims: [c],
    sessions: [session('p', [turn(['Bash'], ['git status'])])],
    bodies: new Map([[c.id, 'Always run npm test before committing.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.verdict, 'unproven');
  assert.equal(ev.firedIn, 0);
});

test('the ballast threshold is the rule of three, not a round number', () => {
  // Four sessions leaves a 53% upper bound; five brings it under half.
  const c = claim({ id: 'cmd-edge' });
  const verdictAt = (n: number) =>
    runEvidence({
      claims: [c],
      sessions: Array.from({ length: n }, () => session('p', [turn(['Bash'], ['git status'])])),
      bodies: new Map([[c.id, 'Always run npm test before committing.']]),
      currentProject: 'p',
    }).get(c.id)!.verdict;
  assert.equal(verdictAt(4), 'unproven');
  assert.equal(verdictAt(5), 'ballast');
});

test('the reported bound tightens as the sample grows', () => {
  const c = claim({ id: 'cmd-bound' });
  const noteAt = (n: number) =>
    runEvidence({
      claims: [c],
      sessions: Array.from({ length: n }, () => session('p', [turn(['Bash'], ['git status'])])),
      bodies: new Map([[c.id, 'Always run npm test before committing.']]),
      currentProject: 'p',
    }).get(c.id)!.note;
  assert.match(noteAt(10), /above 26%/);
  assert.match(noteAt(60), /above 4\.9%/);
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

// ── the checkable vocabulary comes from the corpus ──────────────────────────────────

test('a rule naming an MCP tool is checkable', () => {
  // A hardcoded tool list can never contain mcp__server__tool, so before the vocabulary
  // was derived from the transcripts every MCP rule reported "no consequence to look
  // for" and dropped straight to unproven.
  const c = claim({ id: 'mcp-rule' });
  const sessions = Array.from({ length: 30 }, () =>
    session('p', [turn(['mcp__chrome-devtools__navigate_page'])]),
  );
  const ev = runEvidence({
    claims: [c],
    sessions,
    bodies: new Map([[c.id, 'Always call mcp__chrome-devtools__navigate_page before asserting.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.tier, 'T1');
  assert.equal(ev.verdict, 'load-bearing');
});

test('a tool name is matched whole, not as a prefix', () => {
  const c = claim({ id: 'mcp-prefix' });
  const sessions = Array.from({ length: 30 }, () => session('p', [turn(['mcp__a__b'])]));
  const ev = runEvidence({
    claims: [c],
    sessions,
    bodies: new Map([[c.id, 'Always call mcp__a__bcd first.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.firedIn, 0);
});

// ── a command is not observable, and says so ────────────────────────────────────────

test('a slash command reports unproven rather than manufactured ballast', () => {
  // Invocations live in the user's message, and we read counts and tool names, never
  // message content. Judging them on silence would condemn every installed command.
  const c = claim({ id: 'cmd', kind: 'command', label: 'command/deploy' });
  const ev = runEvidence({
    claims: [c],
    sessions: Array.from({ length: 50 }, () => session('p', [turn(['Read'])])),
    bodies: new Map([[c.id, 'Deploy the service. Always run npm test first.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.verdict, 'unproven');
  assert.match(ev.note, /not visible/);
});

test('a plugin skill is matched with or without its plugin prefix', () => {
  const c = claim({ id: 'ps', kind: 'skill', label: 'skill/acme:deploy' });
  const ev = runEvidence({
    claims: [c],
    sessions: [session('p', [turn(['Read'])], ['deploy'])],
    bodies: new Map(),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.firedIn, 1);
  assert.equal(ev.verdict, 'load-bearing');
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

// ── a dispatcher is not evidence about what it dispatched ───────────────────────────

test('a rule naming a specific skill is not confirmed by the generic Skill tool', () => {
  // "always use the graphify skill" names Skill; so does every other skill invocation in
  // the corpus. Admitting it would report the rule load-bearing whenever the user invoked
  // any skill at all.
  const c = claim({ id: 'skill-rule' });
  const ev = runEvidence({
    claims: [c],
    sessions: Array.from({ length: 30 }, () => session('p', [turn(['Skill'])])),
    bodies: new Map([[c.id, 'When the user asks about the codebase, invoke the Skill graphify.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.tier, 'none');
  assert.match(ev.note, /no mechanically checkable consequence/);
});

test('Task and Agent are excluded for the same reason', () => {
  for (const tool of ['Task', 'Agent']) {
    const c = claim({ id: 'dispatch-' + tool });
    const ev = runEvidence({
      claims: [c],
      sessions: Array.from({ length: 30 }, () => session('p', [turn([tool])])),
      bodies: new Map([[c.id, 'Dispatch the scout agent with the ' + tool + ' tool first.']]),
      currentProject: 'p',
    }).get(c.id)!;
    assert.equal(ev.tier, 'none', tool + ' should not be a checkable signal');
  }
});

test('a specific tool in the same rule is still checkable', () => {
  const c = claim({ id: 'mixed' });
  const ev = runEvidence({
    claims: [c],
    sessions: Array.from({ length: 30 }, () => session('p', [turn(['Grep'])])),
    bodies: new Map([[c.id, 'Dispatch with the Task tool only after a Grep.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.tier, 'T1');
  assert.equal(ev.verdict, 'load-bearing');
});

test('an ambiguous bare skill name is not credited to either skill', () => {
  // A personal ~/.claude/skills/review and a plugin skill acme:review both answer to
  // "review". Attribution recorded one of them; crediting both is manufacturing evidence.
  const mine = claim({ id: 's1', kind: 'skill', label: 'skill/review' });
  const theirs = claim({ id: 's2', kind: 'skill', label: 'skill/acme:review' });
  const ev = runEvidence({
    claims: [mine, theirs],
    sessions: [session('p', [turn(['Read'])], ['review'])],
    bodies: new Map(),
    currentProject: 'p',
  });
  assert.equal(ev.get('s1')!.firedIn, 1, 'the exact label still matches');
  assert.equal(ev.get('s2')!.firedIn, 0, 'the ambiguous bare name does not');
});

test('an unambiguous bare name is still credited', () => {
  const only = claim({ id: 's3', kind: 'skill', label: 'skill/acme:deploy' });
  const ev = runEvidence({
    claims: [only],
    sessions: [session('p', [turn(['Read'])], ['deploy'])],
    bodies: new Map(),
    currentProject: 'p',
  }).get('s3')!;
  assert.equal(ev.firedIn, 1);
});

// ── the numbers stamped on a receipt ────────────────────────────────────────────────

test('the zero-hit bound is the rule of three', () => {
  // 1 - 0.05^(1/n): the rate above which we would have seen it fire, with 95% probability.
  assert.ok(Math.abs(zeroHitUpperBound(1) - 0.95) < 1e-9);
  assert.ok(Math.abs(zeroHitUpperBound(3) - 0.631597) < 1e-5);
  assert.ok(Math.abs(zeroHitUpperBound(29) - 0.098145) < 1e-5);
  assert.equal(zeroHitUpperBound(0), 1);
  // Strictly tightening, never flat — a constant would pass a looser assertion.
  for (let n = 1; n < 40; n++) assert.ok(zeroHitUpperBound(n + 1) < zeroHitUpperBound(n));
});

test('confidence follows the bound, and is not a constant', () => {
  assert.equal(confidenceFor(40), 'high');
  assert.equal(confidenceFor(29), 'high');
  assert.equal(confidenceFor(28), 'medium');
  assert.equal(confidenceFor(11), 'medium');
  assert.equal(confidenceFor(10), 'low');
  assert.equal(confidenceFor(1), 'low');
  assert.equal(new Set([confidenceFor(40), confidenceFor(20), confidenceFor(2)]).size, 3);
});

test('a bound is printed only for a claim that never fired', () => {
  // The rule of three answers "how dead is dead". Printing it beside a claim that DID fire
  // would attach a zero-observation bound to a non-zero observation.
  const c = claim({ id: 'fired' });
  const ev = runEvidence({
    claims: [c],
    sessions: Array.from({ length: 30 }, () => session('p', [turn(['Bash'], ['npm test'])])),
    bodies: new Map([[c.id, 'Always run npm test before committing.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.ok(ev.firedIn > 0);
  assert.doesNotMatch(ev.note, /rules out a rate above/);
});

// ── a claim is judged on the work its own text could have shaped ────────────────────

const AT = (iso: string) => Date.parse(iso);

test('sessions that finished before the claim was last edited are not counted', () => {
  // A rule rewritten today was not in force last month. Counting last month's sessions as
  // chances it had to fire turns an edit into evidence of uselessness.
  const c = claim({ id: 'aged', source: { file: 'CLAUDE.md', startLine: 1, endLine: 3, modifiedMs: AT('2026-06-01T00:00:00Z'), datedBy: 'mtime' } });
  const old = Array.from({ length: 30 }, () => session('p', [turn(['Read'], [], '2026-01-15T10:00:00Z')]));
  const recent = Array.from({ length: 6 }, () => session('p', [turn(['Read'], [], '2026-07-01T10:00:00Z')]));
  const ev = runEvidence({
    claims: [c],
    sessions: [...old, ...recent],
    bodies: new Map([[c.id, 'Always run npm test before committing.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.observedIn, 6, 'only the sessions that could have seen this text');
  assert.match(ev.note, /30 sessions predating when the file was last written not counted/);
});

test('a claim edited after every session reports unproven, not dead', () => {
  const c = claim({ id: 'fresh', source: { file: 'CLAUDE.md', startLine: 1, endLine: 3, modifiedMs: AT('2027-01-01T00:00:00Z'), datedBy: 'mtime' } });
  const ev = runEvidence({
    claims: [c],
    sessions: Array.from({ length: 40 }, () => session('p', [turn(['Read'], [], '2026-05-01T10:00:00Z')])),
    bodies: new Map([[c.id, 'Always run npm test before committing.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.verdict, 'unproven');
  assert.match(ev.note, /predates when the file was last written/);
});

test('a session with no timestamp is never excluded by age', () => {
  // An unknown date is not evidence of an old one.
  const c = claim({ id: 'undated', source: { file: 'CLAUDE.md', startLine: 1, endLine: 3, modifiedMs: AT('2026-06-01T00:00:00Z'), datedBy: 'mtime' } });
  const ev = runEvidence({
    claims: [c],
    sessions: Array.from({ length: 30 }, () => session('p', [turn(['Read'])])),
    bodies: new Map([[c.id, 'Always run npm test before committing.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.observedIn, 30);
});

test('an unknown edit time excludes nothing', () => {
  const c = claim({ id: 'nomtime' });
  const ev = runEvidence({
    claims: [c],
    sessions: Array.from({ length: 12 }, () => session('p', [turn(['Read'], [], '2020-01-01T00:00:00Z')])),
    bodies: new Map([[c.id, 'Always run npm test before committing.']]),
    currentProject: 'p',
  }).get(c.id)!;
  assert.equal(ev.observedIn, 12);
});

// ── firing somewhere is not the same as being load-bearing ──────────────────────────

test('a rate below two percent reads as unproven, above it as load-bearing', () => {
  // The verdict flips on this threshold, so it is pinned from both sides: an untested one
  // can drift by a factor of twenty-five without a test noticing.
  const c = claim({ id: 'rare' });
  const verdictAt = (hits: number, total: number) =>
    runEvidence({
      claims: [c],
      sessions: [
        ...Array.from({ length: hits }, () => session('p', [turn(['Bash'], ['npm test'])])),
        ...Array.from({ length: total - hits }, () => session('p', [turn(['Bash'], ['git status'])])),
      ],
      bodies: new Map([[c.id, 'Always run npm test before committing.']]),
      currentProject: 'p',
    }).get(c.id)!.verdict;
  assert.equal(verdictAt(1, 100), 'unproven', '1 in 100 is 1%');
  assert.equal(verdictAt(3, 100), 'load-bearing', '3 in 100 is 3%');
});
