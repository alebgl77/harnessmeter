/**
 * Transcript parsing, against a synthetic fixture.
 *
 * The point of this file is that harnessmeter reads billed token counts rather than
 * estimating them, so the reader must survive the shapes real transcripts actually take:
 * the 5m/1h cache split, older entries that omit it, non-assistant entries, and malformed
 * lines.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd, findProjectDir, readSession } from '../src/transcript.ts';
import { ask, extractJson } from '../src/agent.ts';

function fixture(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return file;
}

const assistant = (usage: Record<string, unknown>, content: unknown[] = []) => ({
  type: 'assistant',
  sessionId: 's1',
  message: { model: 'claude-opus-5', usage, content },
});

test('reads billed tokens including the 5m/1h cache-write split', async () => {
  const file = fixture([
    assistant({
      input_tokens: 10,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 500,
      cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 },
      output_tokens: 40,
    }),
  ]);
  const s = await readSession(file, 'proj');
  assert.ok(s);
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].usage.cacheWrite5m, 200);
  assert.equal(s.turns[0].usage.cacheWrite1h, 300);
  assert.equal(s.turns[0].usage.cacheReadTokens, 2000);
  assert.equal(s.turns[0].usage.outputTokens, 40);
});

test('falls back to the conservative 5m rate when the split is absent', async () => {
  const file = fixture([
    assistant({
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 900,
      output_tokens: 5,
    }),
  ]);
  const s = await readSession(file, 'proj');
  assert.ok(s);
  // Charging an unknown write at 2x would overstate; 1.25x is the honest floor.
  assert.equal(s.turns[0].usage.cacheWrite5m, 900);
  assert.equal(s.turns[0].usage.cacheWrite1h, 0);
});

test('first-turn prompt size is the measured always-on prefix', async () => {
  const file = fixture([
    assistant({
      input_tokens: 7,
      cache_read_input_tokens: 30_000,
      cache_creation_input_tokens: 12_000,
      cache_creation: { ephemeral_5m_input_tokens: 12_000, ephemeral_1h_input_tokens: 0 },
      output_tokens: 1,
    }),
    assistant({
      input_tokens: 1,
      cache_read_input_tokens: 42_000,
      cache_creation_input_tokens: 0,
      output_tokens: 1,
    }),
  ]);
  const s = await readSession(file, 'proj');
  assert.ok(s);
  assert.equal(s.firstTurnPromptTokens, 7 + 30_000 + 12_000);
  assert.equal(s.turns.length, 2);
});

test('collects tool names, MCP servers and subagent types', async () => {
  const file = fixture([
    assistant({ input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, [
      { type: 'tool_use', name: 'Edit', input: {} },
      { type: 'tool_use', name: 'mcp__chrome-devtools__navigate_page', input: {} },
      { type: 'tool_use', name: 'Task', input: { subagent_type: 'scout' } },
      { type: 'text', text: 'ignored' },
    ]),
  ]);
  const s = await readSession(file, 'proj');
  assert.ok(s);
  assert.deepEqual(s.turns[0].tools.sort(), ['Edit', 'Task', 'mcp__chrome-devtools__navigate_page'].sort());
  assert.ok(s.mcpServersUsed.has('chrome-devtools'));
  assert.ok(s.subagentsUsed.has('scout'));
});

test('picks up skill and MCP attribution from non-assistant entries', async () => {
  const file = fixture([
    { type: 'user', attributionSkill: 'seo', sessionId: 's1' },
    { type: 'user', attributionMcpServer: 'magic', sessionId: 's1' },
    assistant({ input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }),
  ]);
  const s = await readSession(file, 'proj');
  assert.ok(s);
  assert.ok(s.skillsUsed.has('seo'));
  assert.ok(s.mcpServersUsed.has('magic'));
});

test('malformed and blank lines are skipped, not fatal', async () => {
  const file = fixture([
    '{ not json',
    '',
    assistant({ input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 }),
    'also { broken',
  ]);
  const s = await readSession(file, 'proj');
  assert.ok(s);
  assert.equal(s.turns.length, 1);
});

test('a transcript with no usable turns yields nothing', async () => {
  const file = fixture([{ type: 'user', sessionId: 's1' }, { type: 'system', sessionId: 's1' }]);
  assert.equal(await readSession(file, 'proj'), undefined);
});

/**
 * These expectations are transcribed from directory names Claude Code actually wrote,
 * NOT produced by calling encodeCwd. An earlier version of this test asserted the
 * function's own output as the specification, so the encoder and its test agreed with
 * each other and disagreed with reality: every dash run was collapsed, no project
 * directory ever matched, and the default invocation could not find its own transcripts.
 */
test('a cwd is encoded the way Claude Code names project dirs', () => {
  // C:\\Users\\a\\proj  ->  C--Users-a-proj   (the colon AND the separator each become a dash)
  assert.equal(encodeCwd('C:\\Users\\a\\proj'), 'C--Users-a-proj');
  assert.equal(encodeCwd('/home/a/proj'), '-home-a-proj');
  // A dot segment is not a separator, but it is not alphanumeric either.
  assert.equal(encodeCwd('/home/a/.config/x'), '-home-a--config-x');
  assert.equal(encodeCwd('C:\\Users\\a\\my.proj'), 'C--Users-a-my-proj');
});

test('json is recovered from fenced or bare model output', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('sure, here: {"a":2} hope that helps'), { a: 2 });
  assert.equal(extractJson('no object here'), undefined);
});

// ── shell commands ──────────────────────────────────────────────────────────────────

test('bash and powershell command lines are captured', async () => {
  const file = fixture([
    assistant({ input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, [
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --ci' } },
      { type: 'tool_use', name: 'PowerShell', input: { command: 'Get-ChildItem' } },
      { type: 'tool_use', name: 'Edit', input: { command: 'not a shell call' } },
    ]),
  ]);
  const s = await readSession(file, 'proj');
  assert.ok(s);
  assert.deepEqual(s.turns[0].commands, ['npm test -- --ci', 'Get-ChildItem']);
});

test('a command line is truncated to 400 characters', async () => {
  const long = 'echo ' + 'x'.repeat(1000);
  const file = fixture([
    assistant({ input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, [
      { type: 'tool_use', name: 'Bash', input: { command: long } },
    ]),
  ]);
  const s = await readSession(file, 'proj');
  assert.ok(s);
  assert.equal(s.turns[0].commands[0].length, 400);
  assert.ok(long.startsWith(s.turns[0].commands[0]));
});

test('a shell call with no command string yields no command', async () => {
  const file = fixture([
    assistant({ input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, [
      { type: 'tool_use', name: 'Bash', input: {} },
    ]),
  ]);
  const s = await readSession(file, 'proj');
  assert.ok(s);
  assert.deepEqual(s.turns[0].commands, []);
});

// ── agent process failures ──────────────────────────────────────────────────────────

test('asking with no agent installed fails loudly rather than silently', async () => {
  await assert.rejects(
    () => ask({ kind: 'none', bin: '' }, 'anything'),
    /no local agent CLI found/i,
  );
});

test('a missing agent binary rejects instead of hanging', async () => {
  await assert.rejects(
    () => ask({ kind: 'claude', bin: 'harnessmeter-no-such-binary' }, 'x', { timeoutMs: 20_000 }),
    (e: Error) => e instanceof Error,
  );
});

test('an agent that never answers is cut off by the timeout', async () => {
  // The codex path spawns `<bin> exec -`, so a file named `exec` in the working directory
  // makes Node run our script and receive the rest as argv. It then hangs, which is the
  // only way to exercise the timeout rather than an immediate spawn failure.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-hang-'));
  fs.writeFileSync(path.join(dir, 'exec'), 'setInterval(() => {}, 1000);\n');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await assert.rejects(
      () => ask({ kind: 'codex', bin: process.execPath }, 'x', { timeoutMs: 500 }),
      /timed out/i,
    );
  } finally {
    process.chdir(cwd);
    // Windows holds the directory until the killed child fully exits. It is a temp dir;
    // failing to remove it must not fail the test.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* the OS will reclaim it */
    }
  }
});


// ── project matching ────────────────────────────────────────────────────────────────

/**
 * The oracle here is a directory name copied verbatim from ~/.claude/projects, not one
 * produced by the function under test. That distinction is the whole point: the previous
 * fixture built its directory by calling encodeCwd, so the code and its test shared one
 * assumption and neither could detect that it was wrong.
 */
const REAL_DIR = 'C--Users-alexa-Documents-Claude-Projects-Harness';
const REAL_CWD = 'C:\\Users\\alexa\\Documents\\Claude\\Projects\\Harness';

/**
 * findProjectDir resolves its argument, and a Windows path is not absolute on POSIX — it
 * would be prefixed with the process cwd and match nothing. So the directory-matching
 * tests use a path that is absolute on the platform they run on, with its encoding written
 * out by hand on both sides. Still transcribed, never computed.
 */
const OS_CWD = process.platform === 'win32' ? 'C:\\hm\\a.b' : '/hm/a.b';
const OS_DIR = process.platform === 'win32' ? 'C--hm-a-b' : '-hm-a-b';
const SEP = process.platform === 'win32' ? '\\' : '/';

function projectsFixture(dirs: string[]): { home: string; cleanup: () => void } {
  // realpath, because on macOS the temp tree sits behind a symlink and process.cwd()
  // reports the resolved path. A fixture built from the unresolved one describes a machine
  // that does not exist, and the assertions then pass or fail for the wrong reason.
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-proj-')));
  for (const d of dirs) fs.mkdirSync(path.join(home, 'projects', d), { recursive: true });
  const prev = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  return {
    home,
    cleanup: () => {
      if (prev === undefined) delete process.env.CLAUDE_HOME;
      else process.env.CLAUDE_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test('a real Claude Code project directory name is what the encoder produces', () => {
  // Pure string function, so this assertion is meaningful on every platform.
  assert.equal(encodeCwd(REAL_CWD), REAL_DIR);
});

test('a project directory is matched from its cwd', () => {
  const f = projectsFixture([OS_DIR]);
  try {
    assert.equal(encodeCwd(OS_CWD), OS_DIR);
    assert.equal(findProjectDir(OS_CWD), OS_DIR);
  } finally {
    f.cleanup();
  }
});

test('a run from a subdirectory resolves to the project that owns it', () => {
  const f = projectsFixture([OS_DIR]);
  try {
    assert.equal(findProjectDir(OS_CWD + SEP + 'src' + SEP + 'deep'), OS_DIR);
  } finally {
    f.cleanup();
  }
});

test('an unrelated project is never matched by resemblance', () => {
  // A suffix or substring match here would report another project's sessions as this
  // project's evidence, which is worse than reporting none.
  const f = projectsFixture([OS_DIR + 'Other', OS_DIR.slice(0, -1), 'hm-a-b']);
  try {
    assert.equal(findProjectDir(OS_CWD), undefined);
  } finally {
    f.cleanup();
  }
});

// ── cache behaviour, measured rather than assumed ───────────────────────────────────

test('prefix writes are counted, not assumed to be one', async () => {
  const warm = assistant({
    input_tokens: 1,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 40,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40 },
    output_tokens: 5,
  });
  // A cold turn reads back less than the prefix and pays to write it again.
  const cold = assistant({
    input_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 4000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4000 },
    output_tokens: 5,
  });
  const first = assistant({
    input_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 4000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4000 },
    output_tokens: 5,
  });
  const s = await readSession(fixture([first, warm, cold, warm, cold]), 'proj');
  assert.ok(s);
  assert.equal(s.firstTurnPromptTokens, 4010);
  assert.equal(s.prefixWrites, 3); // the first turn, plus two cold ones
  assert.equal(s.cacheTtl, '1h');
});

test('a session that stays warm writes its prefix once', async () => {
  const first = assistant({
    input_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
    output_tokens: 5,
  });
  const warm = assistant({
    input_tokens: 1,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 30,
    cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 0 },
    output_tokens: 5,
  });
  const s = await readSession(fixture([first, warm, warm, warm]), 'proj');
  assert.ok(s);
  assert.equal(s.prefixWrites, 1);
  assert.equal(s.cacheTtl, '5m');
});

test('the cold test compares a turn against itself, not against the first turn', () => {
  // A first turn that errored or was truncated used to poison the yardstick, and with it
  // the whole count. Reads-versus-writes is a question the turn answers about itself.
  const tiny = assistant({
    input_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
    output_tokens: 1,
  });
  const cold = assistant({
    input_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 9000,
    cache_creation: { ephemeral_5m_input_tokens: 9000, ephemeral_1h_input_tokens: 0 },
    output_tokens: 5,
  });
  const warm = assistant({
    input_tokens: 1,
    cache_read_input_tokens: 40_000,
    cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
    output_tokens: 5,
  });
  return readSession(fixture([tiny, warm, cold, warm, warm]), 'proj').then((s) => {
    assert.ok(s);
    // The first turn, plus the one that genuinely wrote more than it read.
    assert.equal(s.prefixWrites, 2);
  });
});

test('a warm turn writing a large tail is not counted as a re-write', () => {
  const first = assistant({
    input_tokens: 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 50_000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50_000 },
    output_tokens: 5,
  });
  const warm = assistant({
    input_tokens: 1,
    cache_read_input_tokens: 50_000,
    cache_creation_input_tokens: 12_000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 12_000 },
    output_tokens: 5,
  });
  return readSession(fixture([first, warm, warm, warm]), 'proj').then((s) => {
    assert.ok(s);
    assert.equal(s.prefixWrites, 1);
  });
});

// ── one response, one bill ──────────────────────────────────────────────────────────

/**
 * Claude Code writes one JSONL entry per content block, so a single API response arrives
 * as several lines — thinking, then text, then one per tool call — every one carrying a
 * COPY of the same `message.usage`. That usage was billed once.
 *
 * Counting each line as a turn charged the same bill two to five times: on a real corpus,
 * 19,663 entries for 9,064 responses, and every billed figure inflated 2.4x. For a tool
 * whose premise is that it reads billed counts rather than estimating them, this was the
 * worst possible defect, and it shipped in every version up to 0.1.5.
 */
const blocks = (id: string, usage: Record<string, unknown>, content: unknown[]) => ({
  type: 'assistant',
  sessionId: 's1',
  requestId: 'req_' + id,
  message: { id, model: 'claude-opus-5', usage, content },
});

const USAGE = {
  input_tokens: 10,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 400,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 400 },
  output_tokens: 100,
};

test('a response split across several entries is one turn and one bill', async () => {
  const s = await readSession(
    fixture([
      blocks('msg_1', USAGE, [{ type: 'thinking' }]),
      blocks('msg_1', USAGE, [{ type: 'text' }]),
      blocks('msg_1', USAGE, [{ type: 'tool_use', name: 'Read', input: {} }]),
      blocks('msg_1', USAGE, [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]),
    ]),
    'proj',
  );
  assert.ok(s);
  assert.equal(s.turns.length, 1, 'four entries, one response');
  assert.equal(s.turns[0].usage.cacheReadTokens, 50_000, 'the bill is taken once');
  assert.equal(s.turns[0].usage.outputTokens, 100);
});

test('tool calls spread across the entries are all kept', async () => {
  // The usage is a copy on every line, but the tool_use blocks really are spread across
  // them. Folding must not lose the evidence T1 depends on.
  const s = await readSession(
    fixture([
      blocks('msg_1', USAGE, [{ type: 'thinking' }]),
      blocks('msg_1', USAGE, [{ type: 'tool_use', name: 'Read', input: {} }]),
      blocks('msg_1', USAGE, [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]),
    ]),
    'proj',
  );
  assert.ok(s);
  assert.deepEqual(s.turns[0].tools, ['Read', 'Bash']);
  assert.deepEqual(s.turns[0].commands, ['npm test']);
});

test('distinct responses stay distinct', async () => {
  const s = await readSession(
    fixture([blocks('msg_1', USAGE, [{ type: 'text' }]), blocks('msg_2', USAGE, [{ type: 'text' }])]),
    'proj',
  );
  assert.ok(s);
  assert.equal(s.turns.length, 2);
});

test('an entry with no id is folded on its own, never merged into another turn', async () => {
  const anon = { type: 'assistant', sessionId: 's1', message: { model: 'claude-opus-5', usage: USAGE, content: [] } };
  const s = await readSession(fixture([anon, anon]), 'proj');
  assert.ok(s);
  assert.equal(s.turns.length, 2);
});

test('the request id folds a response whose message carries no id', async () => {
  const entry = (content: unknown[]) => ({
    type: 'assistant',
    sessionId: 's1',
    requestId: 'req_abc',
    message: { model: 'claude-opus-5', usage: USAGE, content },
  });
  const s = await readSession(fixture([entry([{ type: 'thinking' }]), entry([{ type: 'text' }])]), 'proj');
  assert.ok(s);
  assert.equal(s.turns.length, 1);
});

// ── the reader decides on bytes before it decodes ───────────────────────────────────

/**
 * The scan searches a long line's first kilobyte for its markers rather than all of it,
 * because searching 400 MB for two needles cost more than reading the files off disk. An
 * assistant entry declares itself in its own preamble, so the marker is always in the head;
 * these tests pin both halves of that bargain.
 */
test('a huge assistant entry is read, however large its payload', async () => {
  const bulky = {
    type: 'assistant',
    sessionId: 's1',
    message: {
      id: 'msg_big',
      model: 'claude-opus-5',
      usage: { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3 },
      // Two megabytes of payload after the preamble that identifies the entry.
      content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }],
    },
  };
  const s = await readSession(fixture([bulky]), 'proj');
  assert.ok(s);
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].usage.inputTokens, 7);
});

test('a short attribution entry is read wherever its field sits', async () => {
  // Small records are searched whole, so a marker that is not in the head still counts.
  const marker = {
    type: 'progress',
    sessionId: 's1',
    padding: 'p'.repeat(1500),
    attributionSkill: 'graphify',
  };
  const s = await readSession(
    fixture([
      marker,
      assistant({ input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }),
    ]),
    'proj',
  );
  assert.ok(s);
  assert.deepEqual([...s.skillsUsed], ['graphify']);
});

test('a payload that merely mentions the markers contributes nothing', async () => {
  const noise = {
    type: 'user',
    sessionId: 's1',
    toolUseResult: 'the word attribution and the string "assistant" appear here: ' + 'y'.repeat(64 * 1024),
  };
  const s = await readSession(
    fixture([
      noise,
      assistant({ input_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }),
    ]),
    'proj',
  );
  assert.ok(s);
  assert.equal(s.turns.length, 1, 'only the real assistant entry is a turn');
});

test('a line split across stream chunks is still read whole', async () => {
  // Files past the buffered limit are read in chunks, and a line straddling two of them
  // must be rejoined before it is decoded — otherwise a large session loses turns at every
  // chunk boundary.
  const entries = Array.from({ length: 40 }, (_, i) => ({
    type: 'assistant',
    sessionId: 's1',
    message: {
      id: 'msg_' + i,
      model: 'claude-opus-5',
      usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
      content: [{ type: 'text', text: 'z'.repeat(300 * 1024) }],
    },
  }));
  const file = fixture(entries);
  assert.ok(fs.statSync(file).size > 8 * 1024 * 1024, 'the fixture must take the streaming path');
  const s = await readSession(file, 'proj');
  assert.ok(s);
  assert.equal(s.turns.length, 40);
});

test('multi-byte characters survive the byte-level split', async () => {
  const s = await readSession(
    fixture([
      {
        type: 'assistant',
        sessionId: 's1',
        cwd: '/home/u/caf\u00e9-\u65e5\u672c\u8a9e',
        message: {
          id: 'msg_utf8',
          model: 'claude-opus-5',
          usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo caf\u00e9 \u2014 \u65e5\u672c\u8a9e' } }],
        },
      },
    ]),
    'proj',
  );
  assert.ok(s);
  assert.equal(s.cwd, '/home/u/caf\u00e9-\u65e5\u672c\u8a9e');
  assert.deepEqual(s.turns[0].commands, ['echo caf\u00e9 \u2014 \u65e5\u672c\u8a9e']);
});
