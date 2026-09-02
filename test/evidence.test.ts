/**
 * Verdict accuracy.
 *
 * The project's whole claim is that its numbers are honest, so a confident wrong verdict is
 * not a cosmetic defect — it is the product failing at the only thing it does. Each case
 * below pins one way a verdict could be reached on evidence that does not support it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  confidenceFor,
  eligibleSessionsForClaim,
  runEvidence,
  zeroHitUpperBound,
} from '../src/evidence.ts';
import { mergeT2, runT2, type T2Result } from '../src/evidence-t2.ts';
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

function fakeT2Agent(
  failMatch = '',
  confidence: unknown = 'medium',
  omitConfidence = false,
  spoofedSampledFiredIn?: number,
  responses: Array<'known' | 'zero' | 'unknown' | 'fail' | 'stdout-fail'> = [],
  kind: 'claude' | 'codex' = 'claude',
): {
  agent: { kind: 'claude' | 'codex'; bin: string };
  prompts: () => string[];
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmeter-t2-'));
  const name = `harnessmeter-t2-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const capture = path.join(root, 'prompts.jsonl');
  const counter = path.join(root, 'counter.txt');
  const script = path.join(root, 'agent.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(prompt) + '\\n');
  const index = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0;
  fs.writeFileSync(${JSON.stringify(counter)}, String(index + 1));
  const mode = ${JSON.stringify(responses)}[index] ?? 'known';
  if (mode === 'fail') {
    process.stderr.write('fixture telemetry failure');
    process.exitCode = 2;
    return;
  }
  if (${JSON.stringify(failMatch)} && prompt.includes(${JSON.stringify(failMatch)})) {
    process.stderr.write('fixture failure');
    process.exitCode = 2;
    return;
  }
  const verdicts = [...prompt.matchAll(/<rule id="([^"]+)">/g)].map((m) => {
    const verdict = { id: m[1], outcome: 'unjudgeable', why: 'fixture' };
    if (!${JSON.stringify(omitConfidence)}) verdict.confidence = ${JSON.stringify(confidence)};
    if (${JSON.stringify(spoofedSampledFiredIn)} !== undefined) {
      verdict.sampledFiredIn = ${JSON.stringify(spoofedSampledFiredIn)};
    }
    return verdict;
  });
  verdicts.push({ id: 'foreign', outcome: 'complied', confidence: 'high', why: 'foreign' });
  if (${JSON.stringify(kind)} === 'codex') {
    process.stdout.write(JSON.stringify({ verdicts }));
  } else {
    const envelope = { result: JSON.stringify({ verdicts }) };
    if (mode === 'known' || mode === 'zero') {
      envelope.total_cost_usd = mode === 'zero' ? 0 : 0.25;
      envelope.usage = { input_tokens: mode === 'zero' ? 0 : 2, output_tokens: mode === 'zero' ? 0 : 3 };
    }
    process.stdout.write(JSON.stringify(envelope));
  }
  if (mode === 'stdout-fail') process.exitCode = 2;
});
`,
  );
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(root, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const shim = path.join(root, name);
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${previousPath ?? ''}`;
  return {
    agent: { kind, bin: name },
    prompts: () =>
      fs.existsSync(capture)
        ? fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [],
    cleanup: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(root, { recursive: true, force: true });
    },
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

test('eligible sessions apply scope and age while retaining unknown timestamps', () => {
  const foreignRecent = session('other', [turn(['Read'], [], '2026-07-01T10:00:00Z')]);
  const projectOld = session('mine', [turn(['Read'], [], '2026-01-15T10:00:00Z')]);
  const projectRecent = session('mine', [turn(['Read'], [], '2026-07-02T10:00:00Z')]);
  const projectUndated = session('mine', [turn(['Read'])]);
  const sessions = [foreignRecent, projectOld, projectRecent, projectUndated];
  const modifiedMs = Date.parse('2026-06-01T00:00:00Z');

  const project = eligibleSessionsForClaim(
    claim({ scope: 'project', source: { file: 'CLAUDE.md', startLine: 1, endLine: 3, modifiedMs, datedBy: 'mtime' } }),
    sessions,
    'mine',
  );
  assert.equal(project.pool, 3);
  assert.deepEqual(project.sessions, [projectRecent, projectUndated]);

  const user = eligibleSessionsForClaim(
    claim({ scope: 'user', source: { file: 'CLAUDE.md', startLine: 1, endLine: 3, modifiedMs, datedBy: 'mtime' } }),
    sessions,
    'mine',
  );
  assert.equal(user.pool, 4);
  assert.deepEqual(user.sessions, [foreignRecent, projectRecent, projectUndated]);

  const unknownProject = eligibleSessionsForClaim(claim(), sessions, undefined);
  assert.equal(unknownProject.pool, 4, 'undefined preserves the historical unscoped API fallback');
  const absentProject = eligibleSessionsForClaim(claim(), sessions, null);
  assert.equal(absentProject.pool, 0, 'null means there is no project population');
  assert.deepEqual(absentProject.sessions, []);
});

test('only the last turn decides session age; an invalid last timestamp stays eligible', () => {
  const modifiedMs = Date.parse('2026-06-01T00:00:00Z');
  const lastUndated = session('mine', [
    turn(['Read'], [], '2026-01-15T10:00:00Z'),
    turn(['Read']),
  ]);
  const lastInvalid = session('mine', [
    turn(['Read'], [], '2026-01-15T10:00:00Z'),
    turn(['Read'], [], 'not-a-date'),
  ]);
  const eligible = eligibleSessionsForClaim(
    claim({ source: { file: 'CLAUDE.md', startLine: 1, endLine: 3, modifiedMs, datedBy: 'mtime' } }),
    [lastUndated, lastInvalid],
    'mine',
  );
  assert.deepEqual(eligible.sessions, [lastUndated, lastInvalid]);
});

test('T2 skips an empty project population without asking and still reports progress', async () => {
  const fake = fakeT2Agent();
  const progress: Array<[number, number]> = [];
  try {
    const c = claim({ id: 'empty-project' });
    const result = await runT2(
      [c],
      new Map([[c.id, 'Keep answers concise.']]),
      [session('foreign', [turn(['Read'])])],
      {
        agent: fake.agent,
        currentProject: null,
        onProgress: (done, total) => progress.push([done, total]),
      },
    );
    assert.deepEqual(fake.prompts(), [], 'the agent must not be invoked for an empty population');
    assert.deepEqual(progress, [[1, 1]]);
    assert.equal(result.calls, 0);
    assert.equal(result.attempts, 0);
    assert.equal(result.modelCalls, 0);
    assert.equal(result.networkCalls, 0);
    assert.equal(result.costUsd, 0);
    assert.equal(result.tokens, 0);
    assert.equal(result.verdicts.size, 0);
  } finally {
    fake.cleanup();
  }
});

test('a successful Codex judgement reports calls but leaves unexposed telemetry unknown', async () => {
  const fake = fakeT2Agent('', 'medium', false, undefined, ['unknown'], 'codex');
  try {
    const c = claim();
    const result = await runT2([c], new Map([[c.id, 'Rule']]), [session('mine', [turn(['Read'])])], {
      agent: fake.agent,
      currentProject: 'mine',
    });
    assert.deepEqual({
      attempts: result.attempts,
      calls: result.calls,
      modelCalls: result.modelCalls,
      networkCalls: result.networkCalls,
      tokens: result.tokens,
      costUsd: result.costUsd,
      measuredTokens: result.measuredTokens,
      measuredCostUsd: result.measuredCostUsd,
      tokenResponses: result.tokenResponses,
      costResponses: result.costResponses,
    }, {
      attempts: 1, calls: 1, modelCalls: 1, networkCalls: null,
      tokens: null, costUsd: null, measuredTokens: 0, measuredCostUsd: 0,
      tokenResponses: 0, costResponses: 0,
    });
  } finally {
    fake.cleanup();
  }
});

test('a failed T2 request is an attempt with unknown model, network, token and cost totals', async () => {
  const fake = fakeT2Agent('', 'medium', false, undefined, ['fail']);
  try {
    const c = claim();
    const result = await runT2([c], new Map([[c.id, 'Rule']]), [session('mine', [turn(['Read'])])], {
      agent: fake.agent,
      currentProject: 'mine',
    });
    assert.equal(result.attempts, 1);
    assert.equal(result.calls, 0);
    assert.equal(result.modelCalls, null);
    assert.equal(result.networkCalls, null);
    assert.equal(result.tokens, null);
    assert.equal(result.costUsd, null);
  } finally {
    fake.cleanup();
  }
});

test('a non-zero agent exit cannot launder a valid stdout envelope into T2 evidence', async () => {
  const fake = fakeT2Agent('', 'high', false, undefined, ['stdout-fail']);
  try {
    const c = claim();
    const result = await runT2([c], new Map([[c.id, 'Rule']]), [session('mine', [turn(['Read'])])], {
      agent: fake.agent,
      currentProject: 'mine',
    });
    assert.equal(result.attempts, 1);
    assert.equal(result.calls, 0);
    assert.equal(result.modelCalls, null);
    assert.equal(result.networkCalls, null);
    assert.equal(result.tokens, null);
    assert.equal(result.costUsd, null);
    assert.equal(result.verdicts.size, 0);
  } finally {
    fake.cleanup();
  }
});

test('T2 preserves explicit zero measurements from a successful response', async () => {
  const fake = fakeT2Agent('', 'medium', false, undefined, ['zero']);
  try {
    const c = claim();
    const result = await runT2([c], new Map([[c.id, 'Rule']]), [session('mine', [turn(['Read'])])], {
      agent: fake.agent,
      currentProject: 'mine',
    });
    assert.equal(result.tokens, 0);
    assert.equal(result.costUsd, 0);
    assert.equal(result.tokenResponses, 1);
    assert.equal(result.costResponses, 1);
  } finally {
    fake.cleanup();
  }
});

test('T2 retains measured subtotals while incomplete responses make totals unknown', async () => {
  for (const responses of [['known', 'unknown'], ['known', 'fail']] as const) {
    const fake = fakeT2Agent('', 'medium', false, undefined, [...responses]);
    const claims = Array.from({ length: 13 }, (_, i) => claim({ id: `telemetry-${i}` }));
    try {
      const result = await runT2(
        claims,
        new Map(claims.map((c) => [c.id, 'Rule'])),
        [session('mine', [turn(['Read'])])],
        { agent: fake.agent, currentProject: 'mine' },
      );
      assert.equal(result.attempts, 2);
      assert.equal(result.calls, responses[1] === 'fail' ? 1 : 2);
      assert.equal(result.modelCalls, responses[1] === 'fail' ? null : 2);
      assert.equal(result.networkCalls, null);
      assert.equal(result.tokens, null);
      assert.equal(result.costUsd, null);
      assert.equal(result.measuredTokens, 5);
      assert.equal(result.measuredCostUsd, 0.25);
      assert.equal(result.tokenResponses, 1);
      assert.equal(result.costResponses, 1);
    } finally {
      fake.cleanup();
    }
  }
});

test('T2 preserves interleaved candidate order and isolates failures and foreign ids', async () => {
  const fake = fakeT2Agent('FAIL_ME');
  const projectA = claim({ id: 'project-a', scope: 'project' });
  const userB = claim({ id: 'user-b', scope: 'user' });
  const projectC = claim({ id: 'project-c', scope: 'project' });
  const progress: Array<[number, number]> = [];
  try {
    const result = await runT2(
      [projectA, userB, projectC],
      new Map([
        [projectA.id, 'FAIL_ME'],
        [userB.id, 'User rule'],
        [projectC.id, 'Project rule'],
      ]),
      [session('mine', [turn(['Read'])]), session('foreign', [turn(['Bash'])])],
      {
        agent: fake.agent,
        currentProject: 'mine',
        onProgress: (done, total) => progress.push([done, total]),
      },
    );
    const promptedIds = fake.prompts().map((prompt) =>
      [...prompt.matchAll(/<rule id="([^"]+)">/g)].map((match) => match[1]),
    );
    assert.deepEqual(promptedIds, [['project-a'], ['user-b'], ['project-c']]);
    assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
    assert.equal(result.calls, 2, 'the failed batch is isolated and later populations still run');
    assert.deepEqual([...result.verdicts.keys()], ['user-b', 'project-c']);
    assert.equal(result.verdicts.has('foreign'), false);
  } finally {
    fake.cleanup();
  }
});

test('T2 caps a contiguous population at twelve claims per call', async () => {
  const fake = fakeT2Agent();
  const claims = Array.from({ length: 13 }, (_, i) => claim({ id: `claim-${i + 1}` }));
  try {
    const result = await runT2(
      claims,
      new Map(claims.map((c) => [c.id, c.id])),
      [session('mine', [turn(['Read'])])],
      { agent: fake.agent, currentProject: 'mine' },
    );
    const batchSizes = fake.prompts().map(
      (prompt) => [...prompt.matchAll(/<rule id="([^"]+)">/g)].length,
    );
    assert.deepEqual(batchSizes, [12, 1]);
    assert.equal(result.calls, 2);
  } finally {
    fake.cleanup();
  }
});

test('T2 records the population actually sampled, capped at eighteen sessions', async () => {
  for (const [population, sampled] of [[5, 5], [40, 18]] as const) {
    const fake = fakeT2Agent();
    try {
      const c = claim({ id: `population-${population}` });
      const result = await runT2(
        [c],
        new Map([[c.id, 'Rule under review']]),
        Array.from({ length: population }, () => session('mine', [turn(['Read'])])),
        { agent: fake.agent, currentProject: 'mine' },
      );
      assert.equal(result.verdicts.get(c.id)?.sampledSessions, sampled);
    } finally {
      fake.cleanup();
    }
  }
});

test('T2 firing counts use exactly the eighteen sessions sent in the digest', async () => {
  const c = claim({ id: 'sample-fire' });
  const bodies = new Map([[c.id, 'Always run npm test before committing.']]);

  for (const [hitIndex, expected] of [[18, 0], [0, 1]] as const) {
    const fake = fakeT2Agent();
    const sessions = Array.from({ length: 19 }, (_, i) =>
      session('mine', [turn(['Bash'], i === hitIndex ? ['npm test'] : ['git status'])]),
    );
    try {
      const result = await runT2([c], bodies, sessions, {
        agent: fake.agent,
        currentProject: 'mine',
      });
      assert.equal(result.verdicts.get(c.id)?.sampledSessions, 18);
      assert.equal(result.verdicts.get(c.id)?.sampledFiredIn, expected);
    } finally {
      fake.cleanup();
    }
  }
});

test('T2 ignores a sampled firing count supplied by the model', async () => {
  const fake = fakeT2Agent('', 'medium', false, 18);
  const c = claim({ id: 'spoofed-fire' });
  try {
    const result = await runT2(
      [c],
      new Map([[c.id, 'Always run npm test before committing.']]),
      Array.from({ length: 18 }, () => session('mine', [turn(['Bash'], ['git status'])])),
      { agent: fake.agent, currentProject: 'mine' },
    );
    assert.equal(result.verdicts.get(c.id)?.sampledFiredIn, 0);
  } finally {
    fake.cleanup();
  }
});

test('T2 fails closed to low confidence when the judge omits or invents confidence', async () => {
  for (const [confidence, omitted] of [['medium', true], ['certain', false]] as const) {
    const fake = fakeT2Agent('', confidence, omitted);
    try {
      const c = claim({ id: `confidence-${String(confidence)}` });
      const result = await runT2(
        [c],
        new Map([[c.id, 'Rule under review']]),
        [session('mine', [turn(['Read'])])],
        { agent: fake.agent, currentProject: 'mine' },
      );
      assert.equal(result.verdicts.get(c.id)?.confidence, 'low');
    } finally {
      fake.cleanup();
    }
  }
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

function t2With(
  outcome: string,
  confidence: 'high' | 'medium' | 'low' = 'high',
  sampledSessions = 5,
  sampledFiredIn = 0,
): T2Result {
  return {
    verdicts: new Map([['c1', {
      id: 'c1', outcome: outcome as never, confidence, sampledSessions, sampledFiredIn, why: 'x',
    }]]),
    costUsd: 0,
    tokens: 0,
    calls: 1,
    attempts: 1,
    modelCalls: 1,
    networkCalls: null,
    measuredTokens: 0,
    measuredCostUsd: 0,
    tokenResponses: 1,
    costResponses: 1,
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

test('T2 low confidence cannot produce a decisive verdict', () => {
  for (const outcome of ['complied', 'violated']) {
    const ev = baseEvidence();
    mergeT2(ev, t2With(outcome, 'low', 3), [claim()]);
    assert.equal(ev.get('c1')!.verdict, 'unproven');
    assert.equal(ev.get('c1')!.confidence, 'low');
    assert.equal(ev.get('c1')!.confidenceSource, 't2-judge');
    assert.equal(ev.get('c1')!.observedIn, 3);
  }
});

test('T2 medium and high confidence remain decisive and preserve their sample', () => {
  for (const confidence of ['medium', 'high'] as const) {
    const complied = baseEvidence();
    mergeT2(complied, t2With('complied', confidence, 4), [claim()]);
    assert.equal(complied.get('c1')!.verdict, 'load-bearing');
    assert.equal(complied.get('c1')!.confidence, confidence);
    assert.equal(complied.get('c1')!.confidenceSource, 't2-judge');
    assert.equal(complied.get('c1')!.observedIn, 4);

    const violated = baseEvidence();
    mergeT2(violated, t2With('violated', confidence, 4), [claim()]);
    assert.equal(violated.get('c1')!.verdict, 'ballast');
    assert.equal(violated.get('c1')!.confidence, confidence);
    assert.equal(violated.get('c1')!.observedIn, 4);
  }
});

test('T2 clamps prior firing counts to the sampled population', () => {
  const ev = baseEvidence();
  ev.set('c1', { ...ev.get('c1')!, firedIn: 12, observedIn: 40 });
  mergeT2(ev, t2With('violated', 'high', 4, 12), [claim()]);
  assert.equal(ev.get('c1')!.observedIn, 4);
  assert.equal(ev.get('c1')!.firedIn, 4);
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

test('indexed evidence preserves the complete verdict matrix', () => {
  const recent = '2026-07-01T00:00:00Z';
  const old = '2026-01-01T00:00:00Z';
  const make = (
    id: string,
    project: string,
    turns: Turn[],
    skills: string[] = [],
    mcps: string[] = [],
    agents: string[] = [],
  ) => {
    const s = session(project, turns, skills);
    s.id = id;
    s.mcpServersUsed = new Set(mcps);
    s.subagentsUsed = new Set(agents);
    return s;
  };
  const sessions = [
    make('recent', 'mine', [turn(['Read', 'Read'], ['NPM TEST', 'npm test'], recent)], ['build', 'solo'], ['Acme-Server', 'Café'], ['reviewer']),
    make('old', 'mine', [turn(['Read'], [], old)]),
    make('undated', 'mine', [turn(['Bash'], ['git status'])], ['build'], ['ACME_SERVER'], ['reviewer']),
    make('quiet', 'mine', [turn([], [], recent)]),
    make('invalid-last', 'mine', [turn([], [], old), turn(['Read'], [], 'not-a-date')]),
    make('foreign', 'other', [turn(['Edit'], ['npm test'], recent)], ['solo']),
  ];
  const modifiedMs = AT('2026-06-01T00:00:00Z');
  const agedSource = { file: 'CLAUDE.md', startLine: 1, endLine: 3, modifiedMs, datedBy: 'mtime' as const };
  const claims = [
    claim({ id: 'prose', source: agedSource }),
    claim({ id: 'user-prose', scope: 'user' }),
    claim({ id: 'skill-a', kind: 'skill', label: 'skill/plugin-a:build' }),
    claim({ id: 'skill-b', kind: 'skill', label: 'skill/plugin-b:build' }),
    claim({ id: 'skill-solo', kind: 'skill', label: 'skill/plugin:solo' }),
    claim({ id: 'agent', kind: 'subagent', label: 'agent/reviewer' }),
    claim({ id: 'command', kind: 'command', label: '/ship' }),
    claim({ id: 'mcp-punctuation', kind: 'mcp-server', label: 'mcp/acme.server' }),
    claim({ id: 'mcp-unicode', kind: 'mcp-server', label: 'mcp/cafe' }),
    claim({ id: 'protected', protected: true }),
  ];
  const bodies = new Map([
    ['prose', 'Use Read and run npm test.'],
    ['user-prose', 'Use Edit.'],
    ['protected', 'Use Write.'],
  ]);

  const actual = runEvidence({ claims, sessions, bodies, currentProject: 'mine' });
  assert.deepEqual(actual, new Map<string, ClaimEvidence>([
    ['prose', { claimId: 'prose', tier: 'T1', verdict: 'load-bearing', firedIn: 2, observedIn: 4, note: 'prescribed behaviour (1 tool name + 1 command) observed in 2 of 4 sessions; 1 session predating when the file was last written not counted' }],
    ['user-prose', { claimId: 'user-prose', tier: 'T1', verdict: 'load-bearing', firedIn: 1, observedIn: 6, note: 'prescribed behaviour (1 tool name) observed in 1 of 6 sessions' }],
    ['skill-a', { claimId: 'skill-a', tier: 'T0', verdict: 'ballast', firedIn: 0, observedIn: 5, note: 'never attributed across 5 sessions — rules out a rate above 45% (95%)' }],
    ['skill-b', { claimId: 'skill-b', tier: 'T0', verdict: 'ballast', firedIn: 0, observedIn: 5, note: 'never attributed across 5 sessions — rules out a rate above 45% (95%)' }],
    ['skill-solo', { claimId: 'skill-solo', tier: 'T0', verdict: 'load-bearing', firedIn: 1, observedIn: 5, note: 'attributed in 1 of 5 sessions' }],
    ['agent', { claimId: 'agent', tier: 'T0', verdict: 'load-bearing', firedIn: 2, observedIn: 5, note: 'dispatched in 2 of 5 sessions' }],
    ['command', { claimId: 'command', tier: 'none', verdict: 'unproven', firedIn: 0, observedIn: 5, note: 'slash-command invocations are not visible in what we read — needs T2' }],
    ['mcp-punctuation', { claimId: 'mcp-punctuation', tier: 'T0', verdict: 'load-bearing', firedIn: 1, observedIn: 5, note: 'used in 1 of 5 sessions' }],
    ['mcp-unicode', { claimId: 'mcp-unicode', tier: 'T0', verdict: 'ballast', firedIn: 0, observedIn: 5, note: 'never used across 5 sessions — schemas still loaded every turn — rules out a rate above 45% (95%)' }],
    ['protected', { claimId: 'protected', tier: 'T1', verdict: 'protected', firedIn: 0, observedIn: 5, note: 'prescribed behaviour (1 tool name) never observed across 5 sessions — rules out a rate above 45% (95%)' }],
  ]));
});

test('evidence indexing reads transcript signals once regardless of claim count', () => {
  const measure = (claimCount: number) => {
    const reads = { turns: 0, tools: 0, commands: 0 };
    const rawTurn = turn([], ['git status'], '2026-07-01T00:00:00Z');
    const measuredTurn = {
      ...rawTurn,
      get tools() { reads.tools++; return rawTurn.tools; },
      get commands() { reads.commands++; return rawTurn.commands; },
    } as Turn;
    const rawSession = session('mine', [measuredTurn]);
    const measuredSession = {
      ...rawSession,
      get turns() { reads.turns++; return rawSession.turns; },
    } as Session;
    const claims = Array.from({ length: claimCount }, (_, i) => claim({ id: `indexed-${i}` }));
    runEvidence({
      claims,
      sessions: [measuredSession],
      bodies: new Map(claims.map((c) => [c.id, 'Use Read and run npm test.'])),
      currentProject: 'mine',
    });
    return reads;
  };

  const one = measure(1);
  const many = measure(40);
  assert.deepEqual(many, one, 'turn/tool/command reads must be corpus-bound, not claim-bound');
});

test('T2 sampled evidence recalculates only the claims in each batch', async () => {
  const fake = fakeT2Agent();
  const claims = Array.from({ length: 13 }, (_, i) => claim({ id: `batch-local-${i}` }));
  let bodyReads = 0;
  const bodies = new Map(claims.map((c) => [c.id, 'Use Read.']));
  const originalGet = bodies.get.bind(bodies);
  bodies.get = ((key: string) => {
    bodyReads++;
    return originalGet(key);
  }) as typeof bodies.get;
  try {
    await runT2(claims, bodies, [session('mine', [turn(['Read'])])], {
      agent: fake.agent,
      currentProject: 'mine',
    });
    assert.equal(bodyReads, claims.length * 2, 'one prompt read and one local evidence read per claim');
  } finally {
    fake.cleanup();
  }
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
