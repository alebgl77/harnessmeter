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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, prepare } from '../src/analyze.ts';
import { alwaysOnCost } from '../src/pricing.ts';
import type { T2Result } from '../src/evidence-t2.ts';
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
    snapshot: new Map(),
    evidence: new Map(ev.map((e) => [e.claimId, e])),
  };
}

test('prepare reuses one file snapshot for every claim body', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-prepare-snapshot-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-prepare-home-'));
  const file = path.join(cwd, 'CLAUDE.md');
  fs.writeFileSync(file, [
    '# One',
    'The first section is long enough to become a claim in this fixture.',
    '# Two',
    'The second section is also long enough to become a separate claim.',
  ].join('\n'), 'utf8');
  const reads = new Map<string, number>();
  const previous = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  try {
    const pre = prepare(cwd, {
      readFile(candidate) {
        const absolute = path.resolve(candidate);
        reads.set(absolute, (reads.get(absolute) ?? 0) + 1);
        return fs.readFileSync(absolute);
      },
    });
    assert.equal(reads.get(path.resolve(file)), 1);
    assert.equal(pre.snapshot.get(path.resolve(file))?.text, fs.readFileSync(file, 'utf8'));
    assert.deepEqual(
      pre.claims.filter((c) => c.source.file === file).map((c) => pre.bodies.get(c.id)),
      [
        '# One\nThe first section is long enough to become a claim in this fixture.',
        '# Two\nThe second section is also long enough to become a separate claim.',
      ],
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = previous;
  }
});

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

test('mixed telemetry uses only complete sessions for token, prefix and cache aggregates', () => {
  const known = session({
    id: 'known',
    turns: [turn({ usage: usage({ inputTokens: 17, outputTokens: 3 }) })],
    firstTurnPromptTokens: 50_517,
    prefixWrites: 7,
    cacheTtl: '1h',
  });
  const mixed = session({
    id: 'mixed',
    turns: [
      turn({ usage: usage({ inputTokens: 23, outputTokens: 5 }) }),
      turn({
        model: 'unpriced-but-unmeasured',
        usageKnown: false,
        usage: usage({ inputTokens: 900_000, cacheReadTokens: 800_000, outputTokens: 700_000 }),
      }),
    ],
    firstTurnPromptTokens: 999_999,
    prefixWrites: 99,
    cacheTtl: '5m',
  });
  const a = analyze('.', [known, mixed], prepared([claim()], [evidence()]));
  assert.deepEqual(a.telemetryCoverage, {
    knownTurns: 2,
    totalTurns: 3,
    prefixSessions: 1,
    cacheSessions: 1,
    status: 'partial',
  });
  assert.equal(a.turnCount, 3);
  assert.equal(a.billedTokens.input, 40);
  assert.equal(a.billedTokens.output, 8);
  assert.equal(a.medianPrefixTokens, 50_517);
  assert.equal(a.medianTurnsPerSession, 1);
  assert.equal(a.medianPrefixWrites, 7);
  assert.equal(a.cacheTtl, '1h');
  assert.deepEqual(a.unknownModels, []);
});

test('no known telemetry reports none without manufacturing cache measurements', () => {
  const unknownTurn = turn({
    model: 'unpriced-but-unmeasured',
    usageKnown: false,
    usage: usage({ inputTokens: 42, cacheReadTokens: 43, outputTokens: 44 }),
  });
  const a = analyze(
    '.',
    [session({ turns: [unknownTurn], firstTurnPromptTokens: 123_456, prefixWrites: 12, cacheTtl: '1h' })],
    prepared([claim()], [evidence()]),
  );
  assert.deepEqual(a.telemetryCoverage, {
    knownTurns: 0,
    totalTurns: 1,
    prefixSessions: 0,
    cacheSessions: 0,
    status: 'none',
  });
  assert.equal(a.turnCount, 1);
  assert.deepEqual(a.billedTokens, { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });
  assert.equal(a.spendUsd, 0);
  assert.equal(a.medianPrefixTokens, 0);
  assert.equal(a.medianTurnsPerSession, 0);
  assert.equal(a.medianPrefixWrites, 0);
  assert.deepEqual(a.unknownModels, []);
  assert.equal(a.proposals[0].savingPerSession, 0);
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
  assert.equal(r.confidenceSource, 'zero-hit-bound');
  assert.ok(r.boundPct > 8.9 && r.boundPct < 9.0, `bound was ${r.boundPct}`);
});

test('a T2 receipt preserves judge confidence, source, sample and bounds its floor', () => {
  const sessions = Array.from({ length: 40 }, (_, i) => session({ id: String(i) }));
  const ev = evidence({
    tier: 'T2',
    observedIn: 18,
    confidence: 'medium',
    confidenceSource: 't2-judge',
  });
  const a = analyze('.', sessions, prepared([claim()], [ev]));
  const r = a.proposals[0].receipt;
  assert.equal(r.confidence, 'medium');
  assert.equal(r.confidenceSource, 't2-judge');
  assert.equal(r.sessions, 18);
  assert.equal(a.evidenceFloorSessions, 18);
  assert.ok(r.boundPct > 15 && r.boundPct < 16, `bound was ${r.boundPct}`);
});

test('a missing T2 evidence confidence fails closed in the receipt', () => {
  const ev = evidence({ tier: 'T2', observedIn: 18, confidenceSource: 't2-judge' });
  const a = analyze('.', Array.from({ length: 40 }, () => session()), prepared([claim()], [ev]));
  assert.equal(a.proposals[0].receipt.confidence, 'low');
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

test('a null current project gives project claims a zero-session floor', () => {
  const sessions = Array.from({ length: 8 }, (_, i) => session({ id: String(i), project: 'other' }));
  const a = analyze(
    '.',
    sessions,
    prepared([claim({ scope: 'project' })], [evidence()]),
    undefined,
    null,
  );
  assert.equal(a.evidenceFloorSessions, 0);
  assert.equal(a.evidenceFloorPct, 100);
});

test('a zero-session T2 judgement makes the evidence floor zero', () => {
  const sessions = Array.from({ length: 8 }, (_, i) => session({ id: String(i) }));
  const a = analyze(
    '.',
    sessions,
    prepared([claim()], [evidence({ tier: 'T2', observedIn: 0, confidenceSource: 't2-judge' })]),
  );
  assert.equal(a.evidenceFloorSessions, 0);
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

test('analysis propagates T2 telemetry coverage and reaches T2 on an attempted Codex call', () => {
  const t2: T2Result = {
    verdicts: new Map(), model: 'codex', attempts: 1, calls: 1,
    modelCalls: 1, networkCalls: null, tokens: null, costUsd: null,
    measuredTokens: 0, measuredCostUsd: 0, tokenResponses: 0, costResponses: 0,
  };
  const a = analyze('.', [session()], prepared([claim()], [evidence()]), t2);
  assert.deepEqual(a.cost, {
    tokens: null, usd: null, attempts: 1, calls: 1, modelCalls: 1, networkCalls: null,
    measuredTokens: 0, measuredCostUsd: 0, tokenResponses: 0, costResponses: 0,
    tier: 'T0/T1/T2', model: 'codex', judged: 0,
  });
});

test('an empty T2 result does not claim that T2 was reached', () => {
  const t2: T2Result = {
    verdicts: new Map(), model: 'codex', attempts: 0, calls: 0,
    modelCalls: 0, networkCalls: 0, tokens: 0, costUsd: 0,
    measuredTokens: 0, measuredCostUsd: 0, tokenResponses: 0, costResponses: 0,
  };
  assert.equal(analyze('.', [session()], prepared([claim()], [evidence()]), t2).cost.tier, 'T0/T1');
});

test('legacy zero telemetry after a successful call fails closed to unknown', () => {
  const legacy = { verdicts: new Map(), model: 'sonnet', calls: 1, tokens: 0, costUsd: 0 } as T2Result;
  const cost = analyze('.', [session()], prepared([claim()], [evidence()]), legacy).cost;
  assert.equal(cost.tokens, null);
  assert.equal(cost.usd, null);
});

test('inconsistent response coverage cannot turn a partial T2 run into a known zero', () => {
  const inconsistent: T2Result = {
    verdicts: new Map(), model: 'sonnet', attempts: 1, calls: 1,
    modelCalls: 1, networkCalls: null, tokens: 0, costUsd: 0,
    measuredTokens: 0, measuredCostUsd: 0, tokenResponses: 0, costResponses: 0,
  };
  const cost = analyze('.', [session()], prepared([claim()], [evidence()]), inconsistent).cost;
  assert.equal(cost.tokens, null);
  assert.equal(cost.usd, null);
});
