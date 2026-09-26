import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-governance-')));
  const cwd = path.join(root, 'project'); const claude = path.join(root, 'claude'); const codex = path.join(root, 'codex');
  for (const directory of [cwd, claude, codex]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# Testing\nAlways run npm test before committing.\n\n# Secrets\nNever disclose passwords or credentials.\n\n@rules.md\n');
  fs.writeFileSync(path.join(cwd, 'rules.md'), '# Imports\nUse the documented project conventions.\n');
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Codex\nAlways run npm test before committing project changes.\n');
  fs.writeFileSync(path.join(claude, 'CLAUDE.md'), '# User secret title\nThis is a private instruction.\n');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_HOME: claude, CODEX_HOME: codex, NO_COLOR: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1' },
    timeout: 30000, maxBuffer: 10 * 1024 * 1024,
  });
  return { root, cwd, claude, codex, run, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('static JSON is a single backward-compatible analysis with imported files and no demotions', () => {
  const f = fixture();
  try {
    const result = f.run(['--static', '--project-only', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.schemaVersion, 1); assert.equal(data.mode, 'static'); assert.equal(data.provider, 'claude');
    assert.equal(data.sessionCount, 0); assert.equal(data.cost.modelCalls, 0); assert.equal(data.cost.networkCalls, 0);
    assert.equal(data.spendKnown, false); assert.deepEqual(data.proposals, []);
    assert.ok(data.claims.every((c: any) => c.scope === 'project'));
    assert.ok(data.claims.some((c: any) => c.source.file.endsWith('rules.md')));
    assert.ok(data.claims.some((c: any) => c.protected));
    assert.equal(fs.existsSync(path.join(f.cwd, '.harnessmeter')), false);
  } finally { f.close(); }
});

test('no sessions succeeds with disclosed static fallback, even when T2 requested', () => {
  const f = fixture();
  try {
    const result = f.run(['--json', '--project-only', '--t2', '--yes']);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stderr, /static harness audit/);
    const data = JSON.parse(result.stdout); assert.equal(data.mode, 'static'); assert.equal(data.cost.modelCalls, 0); assert.deepEqual(data.proposals, []);
  } finally { f.close(); }
});

test('Codex static provider uses AGENTS without Claude instructions or costs', () => {
  const f = fixture();
  try {
    const result = f.run(['--static', '--provider', 'codex', '--project-only', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout); assert.equal(data.provider, 'codex');
    assert.equal(data.claims.length, 1); assert.ok(data.claims[0].source.file.endsWith('AGENTS.md'));
    assert.equal(data.cacheEconomicsKnown, false); assert.equal(data.spendKnown, false);
  } finally { f.close(); }
});

test('baseline saves privately, compares exact boundaries and returns exit 2 on budget violation', () => {
  const f = fixture();
  try {
    const file = '.harnessmeter/baseline.json';
    const saved = f.run(['--static', '--project-only', '--json', '--save-baseline', file]);
    assert.equal(saved.status, 0, saved.stderr); const tokens = JSON.parse(saved.stdout).harnessEstTokens;
    const baseline = fs.readFileSync(path.join(f.cwd, file), 'utf8');
    assert.ok(!baseline.includes(f.root)); assert.ok(!baseline.includes('Never disclose')); assert.ok(!baseline.includes('User secret title'));
    assert.match(fs.readFileSync(path.join(f.cwd, '.harnessmeter', '.gitignore'), 'utf8'), /\n\*\n$/);
    const passed = f.run(['--static', '--project-only', '--json', '--baseline', file, '--max-tokens', String(tokens), '--max-growth', '0']);
    assert.equal(passed.status, 0, passed.stderr); assert.equal(JSON.parse(passed.stdout).baseline.comparison.deltaTokens, 0);
    const failed = f.run(['--static', '--project-only', '--json', '--baseline', file, '--max-tokens', String(tokens - 1)]);
    assert.equal(failed.status, 2, failed.stderr); assert.equal(JSON.parse(failed.stdout).budget.violations.length, 1);
    assert.equal(fs.readFileSync(path.join(f.cwd, file), 'utf8'), baseline);
    fs.appendFileSync(path.join(f.cwd, 'rules.md'), '\nAdditional meaningful project conventions.\n');
    const growth = f.run(['--static', '--project-only', '--json', '--baseline', file, '--max-growth', '0']);
    assert.equal(growth.status, 2, growth.stderr); assert.ok(JSON.parse(growth.stdout).baseline.comparison.changed.length > 0);
  } finally { f.close(); }
});

test('invalid input returns exit 1 and empty stdout without writing artifacts', () => {
  const f = fixture();
  try {
    for (const args of [['--unknown'], ['--max-tokens', 'NaN'], ['--max-growth', '1'], ['--out'], ['--static', '--patch'], ['--provider', 'codex', '--t2']]) {
      const result = f.run([...args, '--json']); assert.equal(result.status, 1, args.join(' ')); assert.equal(result.stdout, '');
    }
    assert.equal(fs.existsSync(path.join(f.cwd, '.harnessmeter')), false);
  } finally { f.close(); }
});

test('same baseline targets including aliases are refused without modification', () => {
  const f = fixture();
  try {
    const file = path.join(f.cwd, 'baseline.json');
    assert.equal(f.run(['--static', '--project-only', '--json', '--save-baseline', file]).status, 0);
    const initial = fs.readFileSync(file, 'utf8');
    const alias = path.join(f.cwd, 'alias.json'); fs.linkSync(file, alias);
    for (const target of ['baseline.json', './baseline.json', alias]) {
      const result = f.run(['--static', '--project-only', '--json', '--baseline', file, '--save-baseline', target]);
      assert.equal(result.status, 1); assert.match(result.stderr, /different files/); assert.equal(result.stdout, '');
    }
    assert.equal(fs.readFileSync(file, 'utf8'), initial);
  } finally { f.close(); }
});

test('baseline mismatch and malformed baseline fail before creating requested output', () => {
  const f = fixture();
  try {
    assert.equal(f.run(['--static', '--project-only', '--json', '--save-baseline', 'base.json']).status, 0);
    for (const options of [[], ['--provider', 'codex', '--project-only']]) {
      const result = f.run(['--static', '--json', '--baseline', 'base.json', '--save-baseline', 'must-not-exist.json', ...options]);
      assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /provider or scope/);
    }
    fs.writeFileSync(path.join(f.cwd, 'base.json'), '{');
    assert.equal(f.run(['--static', '--project-only', '--json', '--baseline', 'base.json', '--save-baseline', 'must-not-exist.json']).status, 1);
    assert.equal(fs.existsSync(path.join(f.cwd, 'must-not-exist.json')), false);
  } finally { f.close(); }
});

test('JSON patch path gets gitignore even without an HTML report', () => {
  const f = fixture();
  try {
    const result = f.run(['--json', '--project-only', '--patch']);
    assert.equal(result.status, 0, result.stderr); JSON.parse(result.stdout);
    assert.match(fs.readFileSync(path.join(f.cwd, '.harnessmeter', '.gitignore'), 'utf8'), /\n\*\n$/);
  } finally { f.close(); }
});

test('explicit source-overwrite and baseline/report destination collisions are rejected', () => {
  const f = fixture();
  try {
    const source = fs.readFileSync(path.join(f.cwd, 'CLAUDE.md'), 'utf8');
    assert.equal(f.run(['--static', '--project-only', '--json', '--save-baseline', 'CLAUDE.md']).status, 1);
    assert.equal(fs.readFileSync(path.join(f.cwd, 'CLAUDE.md'), 'utf8'), source);
    assert.equal(f.run(['--static', '--project-only', '--out', 'same.json', '--save-baseline', 'same.json']).status, 1);
    assert.equal(fs.existsSync(path.join(f.cwd, 'same.json')), false);
  } finally { f.close(); }
});

test('version needs no sessions and prints only the package version', () => {
  const f = fixture();
  try { const result = f.run(['--version']); assert.equal(result.status, 0); assert.equal(result.stdout, VERSION + '\n'); }
  finally { f.close(); }
});

test('baseline file cannot collide with patches or the private gitignore', () => {
  const f = fixture();
  try {
    for (const args of [
      ['--static', '--save-baseline', '.harnessmeter/.gitignore'],
      ['--patch', '--save-baseline', '.harnessmeter/demote.patch'],
      ['--patch', '--save-baseline', '.harnessmeter/demote-user.patch'],
      ['--static', '--save-baseline', '.'],
    ]) {
      const result = f.run([...args, '--json', '--project-only']);
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
    }
    assert.equal(fs.existsSync(path.join(f.cwd, '.harnessmeter')), false);
  } finally { f.close(); }
});

test('terminal and HTML expose changed source paths, token deltas and failing budget', () => {
  const f = fixture();
  try {
    assert.equal(f.run(['--static', '--project-only', '--json', '--save-baseline', 'base.json']).status, 0);
    fs.appendFileSync(path.join(f.cwd, 'rules.md'), '\nAdditional meaningful project conventions.\n');
    const result = f.run(['--static', '--project-only', '--baseline', 'base.json', '--max-growth', '0']);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /changed\s+rules\.md/); assert.match(result.stdout, /Budget FAIL/);
    const html = fs.readFileSync(path.join(f.cwd, '.harnessmeter', 'report.html'), 'utf8');
    assert.match(html, /rules\.md/); assert.match(html, /Budget FAIL/); assert.match(html, /growth-percent/);
  } finally { f.close(); }
});

function captureFiles(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else entries[path.relative(root, file)] = fs.readFileSync(file).toString('base64');
    }
  };
  visit(root);
  return entries;
}

test('output preflight rejects HTML at the private gitignore or an active patch without any mutation', () => {
  const f = fixture();
  try {
    for (const existing of [false, true]) {
      if (existing) {
        fs.mkdirSync(path.join(f.cwd, '.harnessmeter'));
        fs.writeFileSync(path.join(f.cwd, '.harnessmeter', '.gitignore'), '# existing private rules\n*\n');
        fs.writeFileSync(path.join(f.cwd, '.harnessmeter', 'demote.patch'), 'existing project patch');
        fs.writeFileSync(path.join(f.cwd, '.harnessmeter', 'demote-user.patch'), 'existing user patch');
      }
      for (const args of [
        ['--static', '--out', '.harnessmeter/.gitignore'],
        ['--patch', '--out', '.harnessmeter/demote.patch'],
        ['--patch', '--out', '.harnessmeter/demote-user.patch'],
      ]) {
        const before = captureFiles(f.root);
        const result = f.run([...args, '--project-only', '--save-baseline', 'must-not-exist.json']);
        assert.equal(result.status, 1, args.join(' '));
        assert.equal(result.stdout, '');
        assert.deepEqual(captureFiles(f.root), before, 'a failed preflight must leave every existing file and output unchanged');
      }
    }
  } finally { f.close(); }
});

test('output preflight protects Claude, Codex, imported sources and the baseline being read', () => {
  const f = fixture();
  try {
    assert.equal(f.run(['--static', '--project-only', '--json', '--save-baseline', 'base.json']).status, 0);
    for (const args of [
      ['--static', '--out', './CLAUDE.md'],
      ['--static', '--provider', 'codex', '--out', 'AGENTS.md'],
      ['--static', '--out', 'rules.md'],
      ['--static', '--out', 'base.json', '--baseline', './base.json'],
    ]) {
      const before = captureFiles(f.root);
      const result = f.run([...args, '--project-only', '--save-baseline', 'must-not-exist.json']);
      assert.equal(result.status, 1, args.join(' ')); assert.equal(result.stdout, '');
      assert.deepEqual(captureFiles(f.root), before);
    }
  } finally { f.close(); }
});

test('output preflight detects hardlink aliases across every output and protected input', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.cwd, '.harnessmeter'));
    const ignore = path.join(f.cwd, '.harnessmeter', '.gitignore'); fs.writeFileSync(ignore, '*\n');
    fs.linkSync(ignore, path.join(f.cwd, 'ignore-alias.html'));
    fs.linkSync(path.join(f.cwd, 'CLAUDE.md'), path.join(f.cwd, 'source-alias.html'));
    const projectPatch = path.join(f.cwd, '.harnessmeter', 'demote.patch'); fs.writeFileSync(projectPatch, 'existing patch');
    fs.linkSync(projectPatch, path.join(f.cwd, 'patch-alias.html'));
    fs.writeFileSync(path.join(f.cwd, 'report.html'), 'existing report');
    fs.linkSync(path.join(f.cwd, 'report.html'), path.join(f.cwd, 'save-alias.json'));
    assert.equal(f.run(['--static', '--project-only', '--json', '--save-baseline', 'base.json']).status, 0);
    fs.linkSync(path.join(f.cwd, 'base.json'), path.join(f.cwd, 'baseline-alias.html'));
    for (const args of [
      ['--static', '--out', 'ignore-alias.html'],
      ['--static', '--out', 'source-alias.html'],
      ['--patch', '--out', 'patch-alias.html'],
      ['--static', '--out', 'baseline-alias.html', '--baseline', 'base.json'],
      ['--static', '--out', 'report.html', '--save-baseline', 'save-alias.json'],
    ]) {
      const before = captureFiles(f.root);
      const result = f.run([...args, '--project-only']);
      assert.equal(result.status, 1, args.join(' ')); assert.equal(result.stdout, '');
      assert.deepEqual(captureFiles(f.root), before);
    }
    // Both patch destinations are active even if this scan would remove stale patches.
    fs.linkSync(projectPatch, path.join(f.cwd, '.harnessmeter', 'demote-user.patch'));
    const before = captureFiles(f.root);
    const result = f.run(['--patch', '--project-only', '--json']);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.deepEqual(captureFiles(f.root), before);
  } finally { f.close(); }
});

test('output preflight protects source aliases from patch deletion and implicit gitignore writes', () => {
  const f = fixture();
  try {
    const directory = path.join(f.cwd, '.harnessmeter'); fs.mkdirSync(directory);
    fs.linkSync(path.join(f.cwd, 'rules.md'), path.join(directory, 'demote.patch'));
    let before = captureFiles(f.root);
    let result = f.run(['--patch', '--project-only', '--json']);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.deepEqual(captureFiles(f.root), before);
    fs.unlinkSync(path.join(directory, 'demote.patch'));
    fs.linkSync(path.join(f.cwd, 'rules.md'), path.join(directory, '.gitignore'));
    before = captureFiles(f.root);
    result = f.run(['--static', '--project-only']);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.deepEqual(captureFiles(f.root), before);
  } finally { f.close(); }
});

test('inactive HTML destinations in JSON and no-html mode do not block safe output', () => {
  const f = fixture();
  try {
    const before = captureFiles(f.root);
    for (const args of [
      ['--static', '--json', '--out', '.harnessmeter/.gitignore'],
      ['--static', '--no-html', '--out', 'CLAUDE.md'],
    ]) {
      const result = f.run([...args, '--project-only']);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(captureFiles(f.root), before);
    }
  } finally { f.close(); }
});

test('output preflight rejects a file destination used as another output directory', () => {
  const f = fixture();
  try {
    const before = captureFiles(f.root);
    for (const args of [
      ['--static', '--out', '.harnessmeter'],
      ['--static', '--out', 'overlap/report.html', '--save-baseline', 'overlap'],
      ['--static', '--out', 'overlap', '--save-baseline', 'overlap/baseline.json'],
    ]) {
      const result = f.run([...args, '--project-only']);
      assert.equal(result.status, 1, args.join(' ')); assert.equal(result.stdout, '');
      assert.deepEqual(captureFiles(f.root), before);
      assert.equal(fs.existsSync(path.join(f.cwd, 'overlap')), false);
      assert.equal(fs.existsSync(path.join(f.cwd, '.harnessmeter')), false);
    }
  } finally { f.close(); }
});
