import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBaseline, compareBaselines, validateBaseline, readBaseline, writeBaseline, sameTarget, MAX_BASELINE_BYTES } from '../src/baseline.ts';
import { evaluateBudget, growthPercent } from '../src/budget.ts';
import { parseArgs } from '../src/args.ts';
import type { Claim } from '../src/types.ts';

function claim(root: string, title = 'Rules', line = 1, tokens = 10): Claim {
  return {
    id: `${root}:private-id:${title}`, provider: 'claude', label: `CLAUDE.md § ${title}`, kind: 'prose-section',
    scope: 'project', class: 'workflow', classInferred: true, loading: 'always-on',
    source: { file: path.join(root, 'CLAUDE.md'), startLine: line, endLine: line + 3, modifiedMs: Date.now(), datedBy: 'mtime' },
    chars: 38, estTokens: tokens, alwaysOnTokens: tokens, protected: false,
  };
}
function snapshot(root: string, rows: Claim[] = [claim(root)], body = 'Always test sensitive code.') {
  return createBaseline({ cwd: root, provider: 'claude', includeUser: false, claims: rows, bodies: new Map(rows.map((row) => [row.id, body])) });
}
function temp() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-baseline-')));
  return { root, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('snapshot is portable, private, deterministic across order and line shifts', () => {
  const a = temp(); const b = temp();
  try {
    const original = snapshot(a.root, [claim(a.root, 'A'), claim(a.root, 'B', 10)]);
    const moved = snapshot(b.root, [claim(b.root, 'B', 100), claim(b.root, 'A', 50)]);
    assert.deepEqual(original, moved);
    const encoded = JSON.stringify(original);
    for (const secret of [a.root, b.root, 'Always test sensitive code.', 'private-id', 'mtime', 'CLAUDE.md §']) assert.ok(!encoded.includes(secret));
    assert.deepEqual(compareBaselines(moved, original).changed, []);
  } finally { a.close(); b.close(); }
});

test('snapshot detects body changes at identical token count, additions and removals', () => {
  const f = temp();
  try {
    const before = snapshot(f.root, [claim(f.root, 'A'), claim(f.root, 'B')], 'Original instructions');
    const after = snapshot(f.root, [claim(f.root, 'B'), claim(f.root, 'C')], 'Modified instructions');
    const result = compareBaselines(after, before);
    assert.equal(result.added.length, 1); assert.equal(result.removed.length, 1); assert.equal(result.changed.length, 1);
    assert.equal(result.deltaTokens, 0); assert.equal(result.growthPercent, 0);
  } finally { f.close(); }
});

test('duplicate headings get deterministic distinct identities without original ids', () => {
  const f = temp();
  try {
    const first = claim(f.root, 'Same', 1); const second = claim(f.root, 'Same', 10); second.id += ':duplicate';
    const a = snapshot(f.root, [first, second]); const b = snapshot(f.root, [second, first]);
    assert.deepEqual(a, b); assert.equal(new Set(a.claims.map((c) => c.id)).size, 2);
  } finally { f.close(); }
});

test('external paths and user roots never appear in portable snapshot', () => {
  const f = temp();
  try {
    const entry = claim(f.root); entry.source.file = path.join(os.homedir(), 'private-alice', 'rules.md');
    const current = snapshot(f.root, [entry]);
    assert.match(current.claims[0].path, /^external\/[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(current).includes('private-alice'));
  } finally { f.close(); }
});

test('baseline validates bounded schema, consistent totals and compatible context', () => {
  const f = temp();
  try {
    const current = snapshot(f.root);
    const rejects: unknown[] = [null, [], { ...current, schemaVersion: 2 }, { ...current, totalTokens: 0 },
      { ...current, totalTokens: Infinity }, { ...current, totalTokens: -1 }, { ...current, text: 'secret' },
      { ...current, claims: [...current.claims, current.claims[0]], totalTokens: 20 }];
    for (const field of [{ tokens: NaN }, { tokens: -1 }, { tokens: 0.5 }, { path: '/secret' }, { path: '../secret' },
      { path: 'C:\\Users\\secret' }, { bodyHash: 'invalid' }, { id: 'forged' }, { provider: 'codex' }, { scope: 'user' }, { rawText: 'secret' }]) {
      rejects.push({ ...current, claims: [{ ...current.claims[0], ...field }] });
    }
    for (const invalid of rejects) assert.throws(() => validateBaseline(invalid), /Invalid baseline/);
    assert.throws(() => validateBaseline(current, { provider: 'codex', scope: 'project' }), /provider or scope/);
    assert.throws(() => validateBaseline(current, { provider: 'claude', scope: 'project+user' }), /provider or scope/);
  } finally { f.close(); }
});

test('atomic write replaces complete snapshots and cleans temporary files', () => {
  const f = temp();
  try {
    const file = path.join(f.root, 'nested', 'baseline.json');
    writeBaseline(file, snapshot(f.root));
    writeBaseline(file, snapshot(f.root, [claim(f.root, 'New', 1, 12)]));
    assert.equal(readBaseline(file, { provider: 'claude', scope: 'project' }).totalTokens, 12);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['baseline.json']);
    assert.equal(sameTarget(file, path.join(f.root, 'nested', '..', 'nested', 'baseline.json')), true);
    const alias = path.join(f.root, 'hardlink.json'); fs.linkSync(file, alias);
    assert.equal(sameTarget(file, alias), true);
    fs.writeFileSync(file, '{'); assert.throws(() => readBaseline(file, { provider: 'claude', scope: 'project' }));
    fs.writeFileSync(file, Buffer.alloc(MAX_BASELINE_BYTES + 1));
    assert.throws(() => readBaseline(file, { provider: 'claude', scope: 'project' }), /bounded/);
  } finally { f.close(); }
});

test('write refuses directory symlinks without touching the destination', (t) => {
  const f = temp();
  try {
    const real = path.join(f.root, 'real'); const link = path.join(f.root, 'link'); fs.mkdirSync(real);
    try { fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlinks unavailable'); return; } throw error; }
    assert.throws(() => writeBaseline(path.join(link, 'snapshot.json'), snapshot(f.root)), /symlink/);
    assert.deepEqual(fs.readdirSync(real), []);
    const file = path.join(real, 'snapshot.json'); writeBaseline(file, snapshot(f.root));
    assert.throws(() => readBaseline(path.join(link, 'snapshot.json'), { provider: 'claude', scope: 'project' }), /symlink/);
  } finally { f.close(); }
});

test('failed atomic replacement preserves existing directory and cleans temp file', () => {
  const f = temp();
  try {
    const target = path.join(f.root, 'target'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'safe');
    assert.throws(() => writeBaseline(target, snapshot(f.root)));
    assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'safe');
    assert.deepEqual(fs.readdirSync(f.root), ['target']);
  } finally { f.close(); }
});

test('budgets enforce inclusive boundaries and zero-baseline growth safely', () => {
  assert.equal(evaluateBudget(10, { maxTokens: 10, maxGrowth: 0, baselineTokens: 10 }).passed, true);
  assert.equal(evaluateBudget(11, { maxTokens: 10 }).passed, false);
  assert.equal(evaluateBudget(11, { maxGrowth: 10, baselineTokens: 10 }).passed, true);
  assert.equal(evaluateBudget(12, { maxGrowth: 10, baselineTokens: 10 }).passed, false);
  assert.equal(evaluateBudget(0, { maxTokens: 0, maxGrowth: 0, baselineTokens: 0 }).passed, true);
  const unbounded = evaluateBudget(1, { maxGrowth: Number.MAX_VALUE, baselineTokens: 0 });
  assert.equal(unbounded.passed, false); assert.equal(unbounded.checks[0].actual, null); assert.match(unbounded.checks[0].reason!, /zero baseline/);
  assert.equal(growthPercent(0, 10), -100);
  assert.throws(() => evaluateBudget(1, { maxGrowth: 1 }), /requires baseline/);
  assert.throws(() => evaluateBudget(Infinity, {}));
});

test('arguments reject typos, missing values, nonfinite numbers and unsupported combinations', () => {
  for (const args of [['--unknown'], ['stray'], ['--out'], ['--provider'], ['--provider', 'cursor'], ['--limit', '0'],
    ['--limit', '1.5'], ['--limit', 'Infinity'], ['--limit', 'NaN'], ['--max-tokens', '-1'], ['--max-tokens', '9007199254740992'],
    ['--max-tokens', '0x10'], ['--max-growth', '1'], ['--max-growth', 'NaN', '--baseline', 'a'], ['--static', '--t2'],
    ['--static', '--patch'], ['--provider', 'codex', '--patch'], ['--provider', 'codex', '--t2'],
    ['--t2', '--t2-model', 'x;whoami'], ['--t2-model', 'sonnet'], ['--json', '--json'], ['--out', '--json']]) {
    assert.throws(() => parseArgs(args), args.join(' '));
  }
  const valid = parseArgs(['--static', '--provider', 'codex', '--project-only', '--max-tokens', '0', '--max-growth', '0.5', '--baseline', 'baseline.json']);
  assert.equal(valid.maxTokens, 0); assert.equal(valid.maxGrowth, 0.5); assert.equal(valid.provider, 'codex');
});
