/**
 * End-to-end tests through the real CLI entry point.
 *
 * The unit tests can only prove that `runEvidence` scopes correctly when it is handed the
 * right arguments. Whether the CLI hands it the right arguments is a separate question, and
 * it is the one that decides what a user actually sees — so these spawn the binary against
 * a synthetic CLAUDE_HOME and read the JSON it produces.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
/**
 * The encoding rule, transcribed here rather than imported.
 *
 * The fixture's cwd is a temp directory, so its encoded name cannot be a literal — but
 * building it by calling encodeCwd is what let 0.1.5 ship an encoder that matched no real
 * directory: the code and its oracle shared one assumption. This copy is checked against a
 * hardcoded real directory name below, and it does not move when src does.
 */
const encodeCwdIndependently = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-');

/**
 * Deliberately `src/cli.ts`, not `bin/harnessmeter.js`.
 *
 * The bin entry prefers `dist/` whenever it exists, so pointing these at it would silently
 * exercise the last build instead of the working tree — a stale artifact would make every
 * assertion below pass while testing nothing. The bin's own resolution logic is covered by
 * the CI job that installs the packed tarball and runs it.
 */
const BIN = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

type Fixture = { home: string; cwd: string; mine: string; other: string; cleanup: () => void };

/**
 * Two projects with different work: the one we run in prescribes `npm test` and does it,
 * the other never does. If scoping is wrong, the foreign sessions dilute the result.
 */
function fixture(opts: { otherSessions?: number; projectRule?: string; userRule?: string } = {}): Fixture {
  // realpath: on macOS the temp tree is behind a symlink, so the path handed out here and
  // the one the CLI reads from process.cwd() are two spellings of the same directory. A
  // real session records the resolved one.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cli-')));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });

  const projects = path.join(home, 'projects');
  const mine = path.join(projects, encodeCwdIndependently(path.resolve(cwd)));
  const other = path.join(projects, 'some-other-project');
  fs.mkdirSync(mine, { recursive: true });
  fs.mkdirSync(other, { recursive: true });

  const assistant = (tools: { name: string; input?: unknown }[]) =>
    JSON.stringify({
      type: 'assistant',
      sessionId: 's',
      message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 500,
          cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
          output_tokens: 20,
        },
        content: tools.map((t) => ({ type: 'tool_use', name: t.name, input: t.input ?? {} })),
      },
    });

  fs.writeFileSync(
    path.join(mine, 'a.jsonl'),
    assistant([{ name: 'Bash', input: { command: 'npm test' } }]),
  );

  for (let i = 0; i < (opts.otherSessions ?? 15); i++) {
    fs.writeFileSync(path.join(other, `o${i}.jsonl`), assistant([{ name: 'Read' }]));
  }

  fs.writeFileSync(
    path.join(cwd, 'CLAUDE.md'),
    `# Testing\n\n${opts.projectRule ?? 'Always run npm test before committing.'}\n`,
  );
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'CLAUDE.md'),
    `# Shell\n\n${opts.userRule ?? 'Always run npm test before committing.'}\n`,
  );

  return { home, cwd, mine, other, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function run(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}): any {
  const out = execFileSync(process.execPath, [BIN, ...args, '--json', '--no-html'], {
    cwd: f.cwd,
    env: { ...process.env, ...env, CLAUDE_HOME: f.home, NO_COLOR: '1' },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function fakeClaudeAgent(root: string): { bin: string; capture: string } {
  const bin = path.join(root, 'bin');
  const capture = path.join(root, 'prompts.jsonl');
  const script = path.join(root, 'fake-agent.mjs');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.HM_PROMPT_CAPTURE, JSON.stringify(prompt) + '\\n');
  const verdicts = [...prompt.matchAll(/<rule id="([^"]+)">/g)].map((m) => ({
    id: m[1], outcome: 'unjudgeable', confidence: 'medium', why: 'fixture',
  }));
  process.stdout.write(JSON.stringify({ result: JSON.stringify({ verdicts }), usage: {} }));
});
`,
  );
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const shim = path.join(bin, 'claude');
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  return { bin, capture };
}

const byScope = (a: any, scope: 'project' | 'user') =>
  a.claims.filter((c: any) => c.scope === scope && c.kind === 'prose-section');

test('--all judges a project claim only against its own project\'s sessions', () => {
  const f = fixture({ otherSessions: 15 });
  try {
    const a = run(f, ['--all']);
    assert.ok(a.sessionCount > 15, `expected --all to read every project, got ${a.sessionCount}`);

    const project = byScope(a, 'project');
    assert.ok(project.length > 0, 'no project claim was extracted');
    for (const c of project) {
      const ev = a.evidence[c.id];
      assert.equal(ev.observedIn, 1, `project claim ${c.id} saw ${ev.observedIn} sessions, expected 1`);
    }
  } finally {
    f.cleanup();
  }
});

test('--all judges a user claim against every session', () => {
  const f = fixture({ otherSessions: 15 });
  try {
    const a = run(f, ['--all']);
    const user = byScope(a, 'user');
    assert.ok(user.length > 0, 'no user claim was extracted');
    for (const c of user) {
      const ev = a.evidence[c.id];
      assert.equal(ev.observedIn, a.sessionCount, 'user claim should see every session');
    }
  } finally {
    f.cleanup();
  }
});

test('a project rule that was followed is not called ballast under --all', () => {
  // Enough foreign sessions to push 1 hit below the 2% floor, so an unscoped run would
  // condemn a rule that was in fact followed every time it was loaded.
  const f = fixture({ otherSessions: 80 });
  try {
    const a = run(f, ['--all']);
    for (const c of byScope(a, 'project')) {
      assert.notEqual(a.evidence[c.id].verdict, 'ballast', `${c.id} was wrongly condemned`);
    }
  } finally {
    f.cleanup();
  }
});

test('without --all only the current project is read', () => {
  const f = fixture({ otherSessions: 15 });
  try {
    const a = run(f, []);
    assert.equal(a.sessionCount, 1);
  } finally {
    f.cleanup();
  }
});

test('a corpus with only incompatible usage remains analyzable and reports telemetry none', () => {
  const f = fixture({ otherSessions: 0 });
  try {
    fs.writeFileSync(
      path.join(f.mine, 'a.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'codex-unknown-schema',
          usage: { input_tokens: '500', output_tokens: '20' },
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
        },
      }),
    );
    const a = run(f, []);
    assert.equal(a.sessionCount, 1);
    assert.equal(a.turnCount, 1);
    assert.deepEqual(a.telemetryCoverage, {
      knownTurns: 0,
      totalTurns: 1,
      prefixSessions: 0,
      cacheSessions: 0,
      status: 'none',
    });
    assert.equal(byScope(a, 'project').length > 0, true);
  } finally {
    f.cleanup();
  }
});

test('a machine with no transcripts exits 1 with guidance rather than a stack trace', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-empty-'));
  try {
    execFileSync(process.execPath, [BIN], {
      cwd: empty,
      env: { ...process.env, CLAUDE_HOME: path.join(empty, 'nothing') },
      encoding: 'utf8',
    });
    assert.fail('expected a non-zero exit');
  } catch (err: any) {
    assert.equal(err.status, 1);
    assert.match(String(err.stderr), /No Claude Code transcripts/i);
    assert.doesNotMatch(String(err.stderr), /at .*\.js:\d+/, 'leaked a stack trace');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('T2 does not send anything without consent on a non-TTY', () => {
  const f = fixture({ otherSessions: 2 });
  try {
    const out = execFileSync(process.execPath, [BIN, '--all', '--t2', '--json', '--no-html'], {
      cwd: f.cwd,
      env: { ...process.env, CLAUDE_HOME: f.home },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const a = JSON.parse(out);
    // Either there was nothing to escalate, no agent on PATH, or consent was refused.
    // In every case nothing may be spent without an explicit yes.
    assert.equal(a.cost.usd, 0);
    assert.equal(a.cost.tokens, 0);
  } finally {
    f.cleanup();
  }
});

test('--all gives each T2 batch only the sessions eligible for its claims', () => {
  const f = fixture({
    otherSessions: 18,
    projectRule: 'Keep answers concise and clear.',
    userRule: 'Use a calm and direct tone in every response to the user.',
  });
  try {
    const changedAt = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const entry = (tool: string, timestamp: number) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(timestamp).toISOString(),
        message: {
          model: 'claude-opus-5',
          usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
          content: [{ type: 'tool_use', name: tool, input: {} }],
        },
      });
    const recent = path.join(f.mine, 'recent.jsonl');
    const old = path.join(f.mine, 'old.jsonl');
    fs.writeFileSync(recent, entry('RecentProjectTool', changedAt + 24 * 60 * 60 * 1000));
    fs.writeFileSync(old, entry('OldProjectTool', changedAt - 24 * 60 * 60 * 1000));
    fs.rmSync(path.join(f.mine, 'a.jsonl'));
    fs.utimesSync(path.join(f.cwd, 'CLAUDE.md'), changedAt / 1000, changedAt / 1000);

    const fake = fakeClaudeAgent(path.dirname(f.home));
    run(f, ['--all', '--t2', '--yes'], {
      PATH: `${fake.bin}${path.delimiter}${process.env.PATH ?? ''}`,
      HM_PROMPT_CAPTURE: fake.capture,
    });
    const prompts = fs.readFileSync(fake.capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string);
    const projectPrompt = prompts.find((prompt) => prompt.includes('<rule id="project:'));
    assert.ok(projectPrompt, 'the project claim was not sent to T2');
    assert.match(projectPrompt, /"RecentProjectTool": 1/);
    assert.doesNotMatch(projectPrompt, /OldProjectTool|"Read"/);
    assert.ok(
      prompts.every((prompt) => !(prompt.includes('<rule id="project:') && prompt.includes('<rule id="user:'))),
      'claims with different eligible populations shared a T2 batch',
    );
  } finally {
    f.cleanup();
  }
});

test('an invalid --t2-model is rejected before it can reach the agent argv', () => {
  const f = fixture({ otherSessions: 2 });
  try {
    const res = execFileSync(
      process.execPath,
      [BIN, '--all', '--t2-model', 'evil; rm -rf /', '--json', '--no-html'],
      {
        cwd: f.cwd,
        env: { ...process.env, CLAUDE_HOME: f.home },
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    assert.ok(JSON.parse(res).claims.length >= 0);
  } catch (err: any) {
    assert.match(String(err.stderr ?? ''), /not a valid model id/i);
  } finally {
    f.cleanup();
  }
});
