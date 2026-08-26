/**
 * The pipeline that turns sessions and claims into the numbers people act on.
 *
 * Until 0.2.0 nothing imported `analyze`, so every value this release exists to produce —
 * the measured write count, the TTL, the resolution floor, and the write-aware saving on
 * every proposal — could be reverted to its pre-0.2.0 form with a green suite. These tests
 * pin the aggregates from their inputs, arithmetically, so a regression has to show up.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze.ts';
import { alwaysOnCost } from '../src/pricing.ts';
import type { Claim, ClaimEvidence, Session, Turn, TurnUsage } from '../src/types.ts';

function usage(over: Partial<TurnUsage> = {}): TurnUsage {
  return {
    inputTokens: 10,
    cacheReadTokens: 50_000,
    cacheWrite5m: 0,
    cacheWrite1h: 500,
    outputTokens: 100,
    ...over,
  };
}

function turn(over: Partial<Turn> = {}): Turn {
  return { model: 'claude-opus-5', usage: usage(), tools: [], commands: [], ...over };
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's',
    project: 'p',
    turns: [turn(), turn(), turn(), turn()],
    skillsUsed: new Set(),
    mcpServersUsed: new Set(),
    subagentsUsed: new Set(),
    firstTurnPromptTokens: 50_510,
    prefixWrites: 3,
    cacheTtl: '1h',
    ...over,
  };
}

function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: 'c1',
    label: 'CLAUDE.md § Testing',
    kind: 'prose-section',
    scope: 'user',
    class: 'workflow',
    classInferred: true,
    loading: 'always-on',
    source: { file: 'CLAUDE.md', startLine: 1, endLine: 3, modifiedMs: 0, datedBy: 'mtime' },
    chars: 400,
    estTokens: 105,
    alwaysOnTokens: 105,
    protected: false,
    ...over,
  };
}

function evidence(over: Partial<ClaimEvidence> = {}): ClaimEvidence {
  return {
    claimId: 'c1',
    tier: 'T1',
    verdict: 'ballast',
    firedIn: 0,
    observedIn: 40,
    note: 'never observed',
    ...over,
  };
}

function prepared(claims: Claim[], ev: ClaimEvidence[]) {
  return {
    claims,
    bodies: new Map<string, string>(),
    evidence: new Map(ev.map((e) => [e.claimId, e])),
  };
}

// ── the measured cache figures reach the analysis ────────────────────────────────────

test('the write count is the median of what the sessions measured', () => {
  const sessions = [
    session({ id: 'a', prefixWrites: 2 }),
    session({ id: 'b', prefixWrites: 6 }),
    session({ id: 'c', prefixWrites: 40 }),
  ];
  const a = analyze('.', sessions, prepared([claim()], [evidence()]));
  assert.equal(a.medianPrefixWrites, 6, 'median, so one runaway session cannot set it');
});

test('a write count is never reported below one', () => {
  const a = analyze('.', [session({ prefixWrites: 0 })], prepared([claim()], [evidence()]));
  assert.equal(a.medianPrefixWrites, 1);
});

test('the TTL follows the majority of sessions, not the first one', () => {
  const at = (n5: number, n1: number) => {
    const s = [
      ...Array.from({ length: n5 }, (_, i) => session({ id: '5-' + i, cacheTtl: '5m' })),
      ...Array.from({ length: n1 }, (_, i) => session({ id: '1-' + i, cacheTtl: '1h' })),
    ];
    return analyze('.', s, prepared([claim()], [evidence()])).cacheTtl;
  };
  assert.equal(at(1, 3), '1h');
  assert.equal(at(3, 1), '5m');
  // A tie is not a majority, and 5m is the cheaper of the two — the conservative answer.
  assert.equal(at(2, 2), '5m');
});

// ── proposals are priced with the measured figures, not the assumed ones ─────────────

test('a saving is priced at the measured write count and TTL', () => {
  const c = claim({ alwaysOnTokens: 1000 });
  const sessions = Array.from({ length: 3 }, (_, i) =>
    session({ id: String(i), prefixWrites: 8, cacheTtl: '1h', turns: Array.from({ length: 100 }, () => turn()) }),
  );
  const a = analyze('.', sessions, prepared([c], [evidence()]));
  assert.equal(a.medianTurnsPerSession, 100);
  assert.equal(a.medianPrefixWrites, 8);
  assert.equal(a.cacheTtl, '1h');

  const expected = Math.round(alwaysOnCost(1000, 100, '1h', 8));
  assert.equal(a.proposals[0].savingPerSession, expected);
  // And it must not be the pre-0.2.0 figure.
  assert.notEqual(a.proposals[0].savingPerSession, Math.round(alwaysOnCost(1000, 100)));
});

test('a proposal receipt carries the bound its confidence rests on', () => {
  const a = analyze('.', [session()], prepared([claim()], [evidence({ observedIn: 32 })]));
  const r = a.proposals[0].receipt;
  assert.equal(r.confidence, 'high');
  assert.ok(r.boundPct > 8.9 && r.boundPct < 9.0, `bound was ${r.boundPct}`);
});

test('a protected claim is never proposed', () => {
  const a = analyze('.', [session()], prepared([claim({ protected: true })], [evidence({ verdict: 'protected' })]));
  assert.equal(a.proposals.length, 0);
});

// ── the resolution floor describes the weakest population, not the largest ───────────

test('the resolution floor is the rule of three over the sessions read', () => {
  const sessions = Array.from({ length: 32 }, (_, i) => session({ id: String(i) }));
  const a = analyze('.', sessions, prepared([claim()], [evidence()]));
  assert.ok(a.evidenceFloorPct > 8.9 && a.evidenceFloorPct < 9.0, `floor was ${a.evidenceFloorPct}`);
});

test('a project claim shrinks the floor to its own project', () => {
  // Under --all the corpus is large but a project claim is judged against its own sessions
  // only. Quoting the corpus would advertise a resolution those claims do not have.
  const sessions = [
    ...Array.from({ length: 30 }, (_, i) => session({ id: 'other' + i, project: 'other' })),
    ...Array.from({ length: 2 }, (_, i) => session({ id: 'mine' + i, project: 'mine' })),
  ];
  const wide = analyze('.', sessions, prepared([claim({ scope: 'user' })], [evidence()]));
  const narrow = analyze('.', sessions, prepared([claim({ scope: 'project' })], [evidence()]), undefined, 'mine');
  assert.ok(narrow.evidenceFloorPct > wide.evidenceFloorPct);
  assert.ok(narrow.evidenceFloorPct > 50, 'two sessions can rule out almost nothing');
});

// ── the dead share counts only what could be ruled against ──────────────────────────

test('a slash command is in neither half of the dead share', () => {
  const prose = claim({ id: 'p1', alwaysOnTokens: 100 });
  const cmd = claim({ id: 'k1', kind: 'command', label: 'command/ship', alwaysOnTokens: 900 });
  const a = analyze(
    '.',
    [session()],
    prepared(
      [prose, cmd],
      [
        evidence({ claimId: 'p1', verdict: 'ballast' }),
        evidence({ claimId: 'k1', tier: 'none', verdict: 'unproven', note: 'not visible' }),
      ],
    ),
  );
  // 100 of 100 attributable tokens are dead; the command's 900 count for neither side.
  assert.equal(a.deadSharePct, 100);
});

test('an unpriced model is named and a synthetic one is not', () => {
  const s = session({
    turns: [turn({ model: 'some-future-model' }), turn({ model: '<synthetic>' }), turn()],
  });
  const a = analyze('.', [s], prepared([claim()], [evidence()]));
  assert.deepEqual(a.unknownModels, ['some-future-model']);
});
