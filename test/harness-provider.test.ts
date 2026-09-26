import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanHarness } from '../src/harness.ts';
import { buildPatch } from '../src/patch.ts';
import type { Claim, Proposal } from '../src/types.ts';

function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-provider-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'repo');
  const cwd = path.join(project, 'packages', 'app');
  const home = path.join(dir, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(project, '.git'));
  const old = { CLAUDE_HOME: process.env.CLAUDE_HOME, CODEX_HOME: process.env.CODEX_HOME, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.CLAUDE_HOME = path.join(home, '.claude');
  process.env.CODEX_HOME = path.join(home, '.codex');
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return { dir, project, cwd, home };
}

function write(file: string, body: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

function prose(title: string): string {
  return `# ${title}\nRun the deterministic test suite before submitting changes to this project.\n`;
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: Explain the repository's architecture when investigating changes.\n---\nRead the relevant files and preserve established module boundaries.\n`;
}

test('Codex chooses nonempty overrides, preserves root-to-cwd order, and isolates dialects', (t) => {
  const { project, cwd, home, dir } = fixture(t);
  const global = write(path.join(home, '.codex', 'AGENTS.override.md'), prose('Global override'));
  write(path.join(home, '.codex', 'AGENTS.md'), prose('Hidden global'));
  const root = write(path.join(project, 'AGENTS.override.md'), prose('Root override'));
  write(path.join(project, 'AGENTS.md'), prose('Hidden root'));
  write(path.join(project, 'packages', 'AGENTS.override.md'), '  \n');
  const middle = write(path.join(project, 'packages', 'AGENTS.md'), prose('Middle'));
  const leaf = write(path.join(cwd, 'AGENTS.md'), prose('Leaf'));
  write(path.join(dir, 'AGENTS.md'), prose('Outside repository'));
  write(path.join(cwd, 'CLAUDE.md'), prose('Other provider'));
  const scan = scanHarness(cwd, { provider: 'codex' });
  assert.deepEqual(scan.claims.map((c) => c.source.file), [global, root, middle, leaf]);
  assert.deepEqual(scan.claims.map((c) => c.scope), ['user', 'project', 'project', 'project']);
  assert.ok(scan.claims.every((c) => c.provider === 'codex'));
  assert.ok(scan.claims.every((c) => scan.bodies.has(c.id)));
});

test('Codex project-only preserves repository skills with duplicate names and excludes all home state', (t) => {
  const { project, cwd, home } = fixture(t);
  write(path.join(home, '.codex', 'AGENTS.md'), prose('Global'));
  write(path.join(home, '.agents', 'skills', 'personal', 'SKILL.md'), skill('personal'));
  write(path.join(project, 'AGENTS.md'), '# Prevention\n- Never disclose credentials or private keys from this repository.\n');
  const rootSkill = write(path.join(project, '.agents', 'skills', 'shared', 'SKILL.md'), skill('shared'));
  const leafSkill = write(path.join(cwd, '.agents', 'skills', 'shared', 'SKILL.md'), skill('shared'));
  const reads: string[] = [];
  const scan = scanHarness(cwd, { provider: 'codex', includeUser: false, readFile(file) {
    reads.push(file);
    return fs.readFileSync(file);
  } });
  assert.ok(scan.claims.every((c) => c.scope === 'project'));
  assert.ok(reads.every((file) => !file.startsWith(home + path.sep)));
  assert.deepEqual(scan.claims.filter((c) => c.kind === 'skill').map((c) => c.source.file), [leafSkill, rootSkill]);
  assert.equal(new Set(scan.claims.map((c) => c.id)).size, scan.claims.length);
  assert.ok(scan.claims.find((c) => c.class === 'prevention')?.protected);
  const full = scanHarness(cwd, { provider: 'codex' });
  assert.ok(full.claims.some((c) => c.kind === 'skill' && c.scope === 'user'));
});

test('Codex treats import syntax as prose and checks only cwd outside a repository', (t) => {
  const { dir } = fixture(t);
  const cwd = path.join(dir, 'plain', 'nested');
  write(path.join(dir, 'plain', 'AGENTS.md'), prose('Outside'));
  const file = write(path.join(cwd, 'AGENTS.md'), prose('Only') + '@extra.md\n');
  write(path.join(cwd, 'extra.md'), prose('Not an import'));
  assert.deepEqual(scanHarness(cwd, { provider: 'codex', includeUser: false }).files, [file]);
});

test('project-only excludes linked home skills, while aliased project skills are read and counted once', (t) => {
  const { cwd, home } = fixture(t);
  const outside = path.join(home, 'external-skill');
  write(path.join(outside, 'SKILL.md'), skill('external'));
  const inside = path.join(cwd, '.agents', 'skills', 'original');
  write(path.join(inside, 'SKILL.md'), skill('original'));
  fs.symlinkSync(outside, path.join(cwd, '.agents', 'skills', 'outside'), 'junction');
  fs.symlinkSync(inside, path.join(cwd, '.agents', 'skills', 'alias'), 'junction');
  const reads: string[] = [];
  const scan = scanHarness(cwd, { provider: 'codex', includeUser: false, readFile(file) {
    reads.push(file);
    return fs.readFileSync(file);
  } });
  assert.equal(scan.claims.length, 1);
  assert.ok(!reads.some((file) => file.includes(`${path.sep}outside${path.sep}`)));
  assert.equal(reads.filter((file) => file.endsWith('SKILL.md')).length, 1);
  assert.ok(scan.bodies.has(scan.claims[0].id));
});

test('Claude loads ancestors and .claude memory once, without conditional rules or descendants', (t) => {
  const { project, cwd, dir } = fixture(t);
  const root = write(path.join(project, 'CLAUDE.md'), prose('Root') + '@packages/app/CLAUDE.md\n');
  const leaf = write(path.join(cwd, 'CLAUDE.md'), prose('Leaf') + '@.claude/CLAUDE.md\n');
  const hidden = write(path.join(cwd, '.claude', 'CLAUDE.md'), prose('Hidden'));
  const local = write(path.join(cwd, 'CLAUDE.local.md'), prose('Local'));
  write(path.join(cwd, '.claude', 'rules', 'scoped.md'), '---\npaths: ["src/**"]\n---\n' + prose('Conditional'));
  write(path.join(cwd, 'nested', 'CLAUDE.md'), prose('Descendant'));
  write(path.join(dir, 'CLAUDE.md'), prose('Outside'));
  const reads = new Map<string, number>();
  const scan = scanHarness(cwd, { includeUser: false, readFile(file) {
    reads.set(file, (reads.get(file) ?? 0) + 1);
    return fs.readFileSync(file);
  } });
  assert.deepEqual(scan.files, [root, leaf, hidden, local]);
  assert.ok(scan.claims.every((c) => c.provider === 'claude'));
  for (const file of scan.files) assert.equal(reads.get(file), 1);
});

test('project-only Claude excludes user memory, user imports, plugins and global MCP files', (t) => {
  const { project, cwd, home } = fixture(t);
  const personal = write(path.join(home, 'personal.md'), prose('Private import'));
  write(path.join(cwd, 'CLAUDE.md'), prose('Project') + `@${personal}\n`);
  write(path.join(home, '.claude', 'CLAUDE.md'), prose('Personal memory'));
  write(path.join(home, '.claude', 'skills', 'private', 'SKILL.md'), skill('private'));
  const plugin = path.join(home, 'plugin');
  write(path.join(plugin, 'skills', 'private', 'SKILL.md'), skill('private'));
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { p: [{ installPath: plugin }] } }));
  write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { global: {} }, projects: { [cwd]: { mcpServers: { local: {} } } } }));
  write(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { project: {} } }));
  const scan = scanHarness(cwd, { includeUser: false });
  assert.equal(scan.claims.length, 2);
  assert.ok(scan.claims.every((c) => c.scope === 'project'));
  assert.ok([...scan.snapshot.keys()].every((file) => file.startsWith(project + path.sep)));
  assert.equal(scan.claims.find((c) => c.kind === 'mcp-server')?.id, 'mcp:project');
});

test('MCP ownership and duplicate precedence are local, project, user, plugin', (t) => {
  const { cwd, home } = fixture(t);
  const global = write(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { shared: {}, global: {}, projectWins: {} },
    projects: { [cwd]: { mcpServers: { shared: {}, local: {} } } },
  }));
  const project = write(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { shared: {}, projectWins: {} } }));
  const settings = write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ mcpServers: { legacy: {} } }));
  const plugin = path.join(home, 'plugin');
  const pluginConfig = write(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { shared: {}, plugin: {}, projectWins: {}, global: {} } }));
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { p: [{ installPath: plugin }] } }));
  const claims = scanHarness(cwd).claims;
  const found = (name: string) => claims.find((c) => c.id === `mcp:${name}`)!;
  assert.equal(claims.length, 6);
  assert.equal(found('shared').source.file, global);
  assert.equal(found('shared').scope, 'project');
  assert.equal(found('local').scope, 'project');
  assert.equal(found('projectWins').source.file, project);
  assert.equal(found('global').scope, 'user');
  assert.equal(found('legacy').source.file, settings);
  assert.equal(found('legacy').scope, 'user');
  assert.equal(found('plugin').source.file, pluginConfig);
  assert.equal(found('plugin').scope, 'user');
});

test('Claude retains first-definition behavior for duplicate plugin capabilities', (t) => {
  const { cwd, home } = fixture(t);
  const first = path.join(home, 'first-plugin');
  const second = path.join(home, 'second-plugin');
  const firstSkill = write(path.join(first, 'skills', 'shared', 'SKILL.md'), skill('shared'));
  write(path.join(second, 'skills', 'shared', 'SKILL.md'), skill('shared'));
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'same@market': [{ installPath: first }, { installPath: second }] },
  }));
  const claims = scanHarness(cwd).claims;
  assert.equal(claims.length, 1);
  assert.equal(claims[0].id, 'user:skill:same:shared');
  assert.equal(claims[0].source.file, firstSkill);
});

test('Git worktree marker files bound ancestor discovery', (t) => {
  const { project, cwd } = fixture(t);
  fs.rmdirSync(path.join(project, '.git'));
  write(path.join(project, '.git'), 'gitdir: ../main/.git/worktrees/example\n');
  const root = write(path.join(project, 'AGENTS.md'), prose('Worktree root'));
  assert.deepEqual(scanHarness(cwd, { provider: 'codex', includeUser: false }).files, [root]);
});

test('Codex overrides are selected and extracted from one immutable read', (t) => {
  const { cwd } = fixture(t);
  const file = write(path.join(cwd, 'AGENTS.override.md'), prose('Original'));
  write(path.join(cwd, 'AGENTS.md'), prose('Fallback'));
  let reads = 0;
  const scan = scanHarness(cwd, { provider: 'codex', includeUser: false, readFile(candidate) {
    const bytes = fs.readFileSync(candidate);
    if (candidate === file) { reads++; fs.writeFileSync(file, prose('Changed')); }
    return bytes;
  } });
  assert.equal(reads, 1);
  assert.equal(scan.claims.length, 1);
  assert.match(scan.bodies.get(scan.claims[0].id)!, /Original/);
});

function proposal(claim: Claim): Proposal {
  return { claimId: claim.id, label: claim.label, action: 'demote', savingPerSession: 1,
    receipt: { tier: 'T1', sessions: 40, firedIn: 0, class: 'workflow', protected: false, confidence: 'high', confidenceSource: 'zero-hit-bound', boundPct: 7.2 } };
}

test('patch generation refuses Codex instructions and ancestors outside the patch root', (t) => {
  const { project, cwd } = fixture(t);
  write(path.join(cwd, 'AGENTS.md'), prose('Codex'));
  write(path.join(project, 'CLAUDE.md'), prose('Ancestor'));
  for (const provider of ['codex', 'claude'] as const) {
    const scan = scanHarness(cwd, { provider, includeUser: false });
    const patch = buildPatch({ ...scan, proposals: scan.claims.map(proposal), root: cwd, scope: 'project', skillDir: '.claude/skills' });
    assert.equal(patch.entries.length, 0);
    assert.equal(patch.text, '');
    assert.match(patch.skipped[0].reason, provider === 'codex' ? /Codex/ : /outside/);
  }
});
