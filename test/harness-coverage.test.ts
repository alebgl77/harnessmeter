/**
 * What the scanner can see, and what it refuses to invent.
 *
 * Two failure modes are covered here. The first is over-reading: a heading parser that
 * fires on shell comments inside fenced code shreds real sections into fragments named
 * after comments, then prices and judges blocks that were never sections. The second is
 * under-reading: skills, commands and imported files the scanner never opened do not stop
 * costing tokens — they move into the unattributed remainder and make the files it does
 * read look like the whole harness.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractCommandClaims,
  extractImportClaims,
  extractPluginClaims,
  extractProseClaims,
  scanHarness,
} from '../src/harness.ts';

const FENCE = String.fromCharCode(96).repeat(3);
const NL = String.fromCharCode(10);

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(dir: string, name: string, lines: string[]): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join(NL), 'utf8');
  return file;
}

// ── what counts as a heading ────────────────────────────────────────────────────────

test('a shell comment inside a fence is not a heading', () => {
  const file = write(tmp('hm-md-'), 'CLAUDE.md', [
    '# Testing',
    'Run the suite before every commit, and keep the fixtures deterministic please.',
    '',
    FENCE + 'bash',
    '# install first',
    'npm ci',
    '# then run',
    'npm test',
    FENCE,
    '',
    'Everything below the fence still belongs to the Testing section, padded pad.',
  ]);
  const claims = extractProseClaims(file, 'project');
  assert.equal(claims.length, 1);
  assert.match(claims[0].label, /Testing$/);
});

test('a tilde fence closes only on tildes', () => {
  const file = write(tmp('hm-md2-'), 'CLAUDE.md', [
    '# Only',
    'One section, long enough to survive the trivia filter, padded padded pad.',
    '~~~',
    '# not a heading',
    FENCE,
    '# still not a heading',
    '~~~',
    'Tail text that belongs to the same section, padded padded padded pad.',
  ]);
  assert.equal(extractProseClaims(file, 'project').length, 1);
});

test('real headings still split', () => {
  const file = write(tmp('hm-md3-'), 'CLAUDE.md', [
    '# One',
    'The first section, long enough to survive the trivia filter, padded pad.',
    '# Two',
    'The second section, also long enough to survive the trivia filter, pad.',
  ]);
  assert.equal(extractProseClaims(file, 'project').length, 2);
});

// ── ids have to survive an edit ─────────────────────────────────────────────────────

test('a claim id survives an edit somewhere else in the file', () => {
  // The point is the LINE NUMBER, so the two fixtures must not put '# Rules' on the same
  // line — otherwise the test passes under exactly the id scheme it exists to forbid.
  const body = (extraLines: number) => [
    '# Header',
    'An intro paragraph, long enough to count as a body all by itself here.',
    ...Array.from({ length: extraLines }, (_, i) => 'An inserted line number ' + i + ', padding the section out.'),
    '# Rules',
    'Keep the rules section stable across edits above it, padded padded pad.',
  ];
  const claimsFor = (extraLines: number) =>
    extractProseClaims(write(tmp('hm-id1-'), 'CLAUDE.md', body(extraLines)), 'project');
  const a = claimsFor(0);
  const b = claimsFor(12);

  const rules = (cs: typeof a) => cs.find((c) => c.label.endsWith('Rules'))!;
  assert.notEqual(rules(a).source.startLine, rules(b).source.startLine, 'the heading must have moved');
  assert.equal(rules(a).id, rules(b).id);
});

test('two imported files sharing a basename both survive scanHarness', () => {
  // Ids are built from the file name and the section title so they survive an edit. Two
  // memory files can share a basename, and scanHarness enforces id uniqueness by keeping
  // the first — so a collision silently deletes a claim. Driving scanHarness rather than
  // handing extractProseClaims a shared map is what makes this test see the wiring.
  const cwd = tmp('hm-id4-');
  const section = ['# Rules', 'A rules section, long enough to survive the trivia filter here.'];
  write(path.join(cwd, 'one'), 'rules.md', section);
  write(path.join(cwd, 'two'), 'rules.md', section);
  write(cwd, 'CLAUDE.md', [
    '# Main',
    'The memory file, long enough to survive the trivia filter here ok then.',
    '@one/rules.md',
    '@two/rules.md',
  ]);
  const home = tmp('hm-id4-home-');
  const prev = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  try {
    const claims = scanHarness(cwd).claims.filter((c) => c.label.includes('rules.md'));
    assert.equal(claims.length, 2, 'both imported sections must survive');
    assert.equal(new Set(claims.map((c) => c.id)).size, 2);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = prev;
  }
});

test('two sections with the same title get distinct ids', () => {
  const file = write(tmp('hm-id3-'), 'CLAUDE.md', [
    '# Rules',
    'The first rules section, long enough to survive the trivia filter here.',
    '# Rules',
    'The second rules section, long enough to survive the trivia filter here.',
  ]);
  const ids = extractProseClaims(file, 'project').map((c) => c.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
});

// ── surfaces that were previously invisible ─────────────────────────────────────────

test('a file pulled in with an import line is harness too', () => {
  const dir = tmp('hm-imp-');
  write(dir, 'extra.md', [
    '# Imported',
    'A rule that lives in another file entirely, long enough to count as one.',
  ]);
  const root = write(dir, 'CLAUDE.md', [
    '# Main',
    'The main memory file, long enough to survive the trivia filter here ok.',
    '',
    '@extra.md',
  ]);
  const imported = extractImportClaims(root, 'project');
  assert.equal(imported.length, 1);
  assert.match(imported[0].label, /extra.md/);
  assert.ok(imported[0].alwaysOnTokens > 0);
});

test('a mention that resolves to no file is not an import', () => {
  const dir = tmp('hm-imp2-');
  const root = write(dir, 'CLAUDE.md', [
    '# Main',
    'Ask @someone about this; it is long enough to survive the filter here.',
    '@nope.md',
  ]);
  assert.equal(extractImportClaims(root, 'project').length, 0);
});

test('an import inside a fence is not followed', () => {
  const dir = tmp('hm-imp3-');
  write(dir, 'extra.md', ['# Imported', 'Body long enough to survive the trivia filter here ok.']);
  const root = write(dir, 'CLAUDE.md', [
    '# Main',
    'Documenting the import syntax, long enough to survive the filter here.',
    FENCE,
    '@extra.md',
    FENCE,
  ]);
  assert.equal(extractImportClaims(root, 'project').length, 0);
});

test('an import cycle terminates', () => {
  const dir = tmp('hm-cyc-');
  write(dir, 'a.md', ['# A', 'Section A, long enough to survive the trivia filter here.', '@b.md']);
  write(dir, 'b.md', ['# B', 'Section B, long enough to survive the trivia filter here.', '@a.md']);
  const claims = extractImportClaims(path.join(dir, 'a.md'), 'project');
  // b.md, and nothing else: a.md is the root and the cycle back to it is refused.
  assert.equal(claims.length, 1);
});

test('an import chain stops at the documented depth', () => {
  const dir = tmp('hm-depth-');
  const link = (n: number, next?: number) => [
    '# Level ' + n,
    'A section at level ' + n + ', long enough to survive the trivia filter here.',
    ...(next === undefined ? [] : ['@l' + next + '.md']),
  ];
  write(dir, 'l1.md', link(1, 2));
  write(dir, 'l2.md', link(2, 3));
  write(dir, 'l3.md', link(3, 4));
  write(dir, 'l4.md', link(4));
  const root = write(dir, 'CLAUDE.md', [
    '# Main',
    'The memory file, long enough to survive the trivia filter here ok then.',
    '@l1.md',
  ]);
  const labels = extractImportClaims(root, 'project').map((c) => c.label);
  // Two levels: the file CLAUDE.md names, and the one that file names. No further.
  assert.equal(labels.length, 2);
  assert.ok(labels.some((l) => l.includes('l1.md')));
  assert.ok(labels.some((l) => l.includes('l2.md')));
  assert.ok(!labels.some((l) => l.includes('l3.md')));
});

/**
 * A plugin fixture shaped like the real thing: a catalogue of everything on offer under
 * `marketplaces/`, an install under `cache/`, and a manifest naming which is which.
 */
function pluginFixture(opts: { enabled?: Record<string, boolean> } = {}): string {
  const home = tmp('hm-plug-');
  const installed = path.join(home, 'plugins', 'cache', 'official', 'acme', 'unknown');
  const catalogue = path.join(home, 'plugins', 'marketplaces', 'official', 'plugins', 'decoy');

  write(installed, path.join('skills', 'deploy', 'SKILL.md'), [
    '---',
    'name: deploy',
    'description: Ship the service to production safely.',
    '---',
    '',
    'A long body that should never be counted as always-on, because it is not.',
  ]);
  write(installed, path.join('agents', 'reviewer.md'), [
    '---',
    'name: reviewer',
    'description: Reviews diffs.',
    '---',
    '',
    'body',
  ]);
  write(installed, path.join('commands', 'ship.md'), [
    '---',
    'name: ship',
    'description: Ship it.',
    '---',
    '',
    'body',
  ]);
  // On offer, never installed. Nothing here is ever put in front of the model.
  write(catalogue, path.join('skills', 'decoy', 'SKILL.md'), [
    '---',
    'name: decoy',
    'description: A catalogue entry that is not installed.',
    '---',
    '',
    'body',
  ]);

  fs.writeFileSync(
    path.join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'acme@official': [{ scope: 'user', installPath: installed }] },
    }),
    'utf8',
  );
  if (opts.enabled) {
    fs.writeFileSync(
      path.join(home, 'settings.json'),
      JSON.stringify({ enabledPlugins: opts.enabled }),
      'utf8',
    );
  }
  return home;
}

test('plugin skills, agents and commands are claims like any other', () => {
  const home = pluginFixture();

  const claims = extractPluginClaims(home);
  assert.deepEqual(claims.map((c) => c.kind).sort(), ['command', 'skill', 'subagent']);

  const skill = claims.find((c) => c.kind === 'skill')!;
  assert.equal(skill.label, 'skill/acme:deploy');
  assert.ok(skill.alwaysOnTokens > 0, 'the description is resident');
  assert.ok(skill.alwaysOnTokens < skill.estTokens, 'the body is not');
});

test('the plugin catalogue is not priced as if it were loaded', () => {
  // marketplaces/ lists everything on offer. Counting it invents context the model never
  // sees — the exact error this tool exists to correct.
  const claims = extractPluginClaims(pluginFixture());
  assert.equal(claims.filter((c) => c.label.includes('decoy')).length, 0);
});

test('a disabled plugin costs nothing', () => {
  const home = pluginFixture({ enabled: { 'acme@official': false } });
  assert.equal(extractPluginClaims(home).length, 0);
});

test('an explicitly enabled plugin is still counted', () => {
  const home = pluginFixture({ enabled: { 'acme@official': true } });
  assert.equal(extractPluginClaims(home).length, 3);
});

test('no manifest yields no claims rather than a guess', () => {
  const home = tmp('hm-plug-none-');
  write(path.join(home, 'plugins', 'marketplaces', 'official', 'plugins', 'ghost'), path.join('skills', 'ghost', 'SKILL.md'), [
    '---',
    'name: ghost',
    'description: Should not be found without a manifest.',
    '---',
    '',
    'body',
  ]);
  assert.equal(extractPluginClaims(home).length, 0);
});

test('a manifest entry whose install path is gone is skipped', () => {
  const home = tmp('hm-plug-gone-');
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'ghost@official': [{ installPath: path.join(home, 'nope') }] } }),
    'utf8',
  );
  assert.equal(extractPluginClaims(home).length, 0);
});

test('a slash command is a capability, never prevention', () => {
  const home = tmp('hm-cmd-');
  write(home, path.join('commands', 'wipe.md'), [
    '---',
    'name: wipe',
    'description: Never commit a secret; wipe the credential cache.',
    '---',
    '',
    'body',
  ]);
  const claims = extractCommandClaims(path.join(home, 'commands'), 'user');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, 'command');
  assert.equal(claims[0].class, 'knowledge');
  assert.equal(claims[0].protected, false);
  // The resident part is the frontmatter description. Asserting only that it is positive
  // lets the whole file body be priced as resident and still pass.
  assert.ok(claims[0].alwaysOnTokens > 0);
  assert.ok(claims[0].alwaysOnTokens < claims[0].estTokens, 'the body is not resident');
  assert.ok(claims[0].alwaysOnTokens < 40, 'a one-line description is not 40 tokens');
});

test('CLAUDE.local.md is scanned alongside CLAUDE.md', () => {
  const cwd = tmp('hm-local-');
  write(cwd, 'CLAUDE.md', ['# Shared', 'The committed memory file, long enough to survive the filter.']);
  write(cwd, 'CLAUDE.local.md', ['# Personal', 'The uncommitted one, long enough to survive the filter here.']);
  const home = tmp('hm-home-');
  const prev = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  try {
    const labels = scanHarness(cwd).claims.map((c) => c.label);
    assert.ok(labels.some((l) => l.includes('CLAUDE.md') && l.includes('Shared')));
    assert.ok(labels.some((l) => l.includes('CLAUDE.local.md') && l.includes('Personal')));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = prev;
  }
});

test('an import to a non-prose file is not read or priced', () => {
  // A claim body is what T2 sends to a model, and its byte length becomes a token figure.
  // Following any path a memory file happens to name is how a key ends up in both.
  const dir = tmp('hm-imp4-');
  write(dir, 'secrets.pem', ['-----BEGIN PRIVATE KEY-----', 'x'.repeat(200)]);
  const root = write(dir, 'CLAUDE.md', [
    '# Main',
    'The main memory file, long enough to survive the trivia filter here ok.',
    '@secrets.pem',
  ]);
  assert.equal(extractImportClaims(root, 'project').length, 0);
});

test('an oversized import is not priced as context', () => {
  const dir = tmp('hm-imp5-');
  write(dir, 'huge.md', ['# Huge', 'x'.repeat(600 * 1024)]);
  const root = write(dir, 'CLAUDE.md', [
    '# Main',
    'The main memory file, long enough to survive the trivia filter here ok.',
    '@huge.md',
  ]);
  assert.equal(extractImportClaims(root, 'project').length, 0);
});

test('a file imported by two memory files is resident once', () => {
  const dir = tmp('hm-imp6-');
  write(dir, 'shared.md', ['# Shared', 'A rule imported from two places, long enough to count here.']);
  const a = write(dir, 'CLAUDE.md', ['# A', 'First memory file, long enough to survive the filter.', '@shared.md']);
  const b = write(dir, 'CLAUDE.local.md', ['# B', 'Second memory file, long enough to survive it too.', '@shared.md']);
  const seen = new Set<string>();
  const claims = [
    ...extractImportClaims(a, 'project', seen),
    ...extractImportClaims(b, 'project', seen),
  ];
  assert.equal(claims.length, 1);
});

test('commands filed into subdirectories are found and namespaced', () => {
  const home = tmp('hm-cmd2-');
  const fm = (name: string) => ['---', 'name: ' + name, 'description: Does the ' + name + ' thing.', '---', '', 'body'];
  write(home, path.join('commands', 'top.md'), fm('top'));
  write(home, path.join('commands', 'git', 'sync.md'), fm('sync'));
  write(home, path.join('commands', 'git', 'deep', 'nested.md'), fm('nested'));
  const labels = extractCommandClaims(path.join(home, 'commands'), 'user')
    .map((c) => c.label)
    .sort();
  assert.deepEqual(labels, ['command/git:deep:nested', 'command/git:sync', 'command/top']);
});

test('every surface scanHarness wires up produces a claim', () => {
  // Each source can otherwise be deleted from the claim list one at a time and go
  // unnoticed. One fixture, one assertion per surface.
  const cwd = tmp('hm-wire-');
  const home = tmp('hm-wire-home-');
  const fm = (name: string) => ['---', 'name: ' + name, 'description: Does the ' + name + ' thing.', '---', '', 'body'];

  write(cwd, 'CLAUDE.md', ['# ProjectSection', 'Project memory, long enough to survive the trivia filter here.', '@side.md']);
  write(cwd, 'side.md', ['# ImportedSection', 'An imported rule, long enough to survive the filter here too.']);
  write(cwd, 'CLAUDE.local.md', ['# LocalSection', 'Local memory, long enough to survive the trivia filter here.']);
  write(cwd, path.join('.claude', 'skills', 'projskill', 'SKILL.md'), fm('projskill'));
  write(cwd, path.join('.claude', 'agents', 'projagent.md'), fm('projagent'));
  write(cwd, path.join('.claude', 'commands', 'projcmd.md'), fm('projcmd'));
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { projmcp: {} } }), 'utf8');

  write(home, 'CLAUDE.md', ['# UserSection', 'User memory, long enough to survive the trivia filter here ok.']);
  write(home, path.join('skills', 'userskill', 'SKILL.md'), fm('userskill'));
  write(home, path.join('agents', 'useragent.md'), fm('useragent'));
  write(home, path.join('commands', 'usercmd.md'), fm('usercmd'));

  const prev = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  try {
    const labels = scanHarness(cwd).claims.map((c) => c.label);
    for (const expected of [
      'ProjectSection',
      'ImportedSection',
      'LocalSection',
      'skill/projskill',
      'agent/projagent',
      'command/projcmd',
      'mcp/projmcp',
      'UserSection',
      'skill/userskill',
      'agent/useragent',
      'command/usercmd',
    ]) {
      assert.ok(
        labels.some((l) => l.includes(expected)),
        expected + ' is not in the ledger: ' + labels.join(', '),
      );
    }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = prev;
  }
});

test('a plugin that contributes only an MCP server is still a claim', () => {
  // The github plugin on the machine this was written against does exactly that: no
  // skills, no agents, no commands, and tool schemas resident on every turn.
  const home = tmp('hm-plug-mcp-');
  const installed = path.join(home, 'plugins', 'cache', 'official', 'gh', 'unknown');
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(
    path.join(installed, '.mcp.json'),
    JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'gh@official': [{ installPath: installed }] } }),
    'utf8',
  );
  const claims = extractPluginClaims(home);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, 'mcp-server');
  // Deliberately not qualified by plugin: a transcript records mcp__github__*, which
  // cannot say whether the server came from a plugin or from the project's own .mcp.json.
  // Two claims would be two ids and one of them permanently unmatchable.
  assert.equal(claims[0].label, 'mcp/github');
  assert.match(claims[0].source.file, /.mcp.json$/);
});
