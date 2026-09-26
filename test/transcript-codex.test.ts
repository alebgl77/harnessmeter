import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexHome, codexProjectId, readCodexSession, scanCodexSessions } from '../src/transcript-codex.ts';

// Synthetic protocol fixtures only. Never copy a private rollout into the test suite.
const timestamp = '2026-01-01T12:00:00.000Z';
const cwd = path.join(os.tmpdir(), 'hm-codex-project');
const meta = (id = 's1', directory = cwd) => ({ timestamp, type: 'session_meta', payload: { id, cwd: directory, git: { branch: 'main' } } });
const context = (model = 'codex-test-model', directory = cwd) => ({ timestamp, type: 'turn_context', payload: { model, cwd: directory } });
const usage = (input = 100, cached = 60, output = 20, reasoning = 10) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });
const count = (total: unknown = usage(), last: unknown = total) => ({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
const call = (name: string, args: unknown = {}, id = 'call1') => ({ timestamp, type: 'response_item', payload: { type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) } });
function fixture(t: TestContext, lines: unknown[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-codex-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\r\n'));
  return file;
}

test('Codex cumulative readings are deduplicated and subset token fields are not double counted', async (t) => {
  const file = fixture(t, [meta(), context(), count(), count(), count(usage(250, 160, 50, 25), usage(150, 100, 30, 15)), count(usage(250, 160, 50, 25))]);
  const session = (await readCodexSession(file))!;
  assert.equal(session.turns.length, 2);
  assert.deepEqual(session.turns.map((turn) => turn.usage), [
    { inputTokens: 40, cacheReadTokens: 60, cacheWrite5m: 0, cacheWrite1h: 0, outputTokens: 20 },
    { inputTokens: 50, cacheReadTokens: 100, cacheWrite5m: 0, cacheWrite1h: 0, outputTokens: 30 },
  ]);
  assert.equal(session.provider, 'codex');
  assert.equal(session.cacheEconomicsKnown, false);
  assert.equal(session.firstTurnPromptTokens, 100);
  assert.equal(session.prefixWrites, 0);
  assert.equal(session.gitBranch, 'main');
});

test('Codex tools await new usage when a repeated cumulative update occurs', async (t) => {
  const file = fixture(t, [meta(), context(), call('exec_command', { cmd: 'npm test' }), count(), call('exec_command', { cmd: 'npm run build' }, 'call2'), count(), count(usage(200, 120, 40, 20), usage())]);
  const session = (await readCodexSession(file))!;
  assert.equal(session.turns.length, 2);
  assert.deepEqual(session.turns.map((turn) => turn.commands), [['npm test'], ['npm run build']]);
  assert.ok(session.turns.every((turn) => turn.usageKnown));
});

test('Codex counter resets make the remaining tail unknown so replayed history is never billed twice', async (t) => {
  const file = fixture(t, [meta(), context(), count(), count(usage(50, 20, 10, 5)), count(usage(150, 80, 30, 15), usage()), count(usage(160, 100, 40, 20))]);
  const session = (await readCodexSession(file))!;
  assert.deepEqual(session.turns.map((turn) => turn.usageKnown), [true, false, false, false]);
  assert.deepEqual(session.turns.filter((turn) => turn.usageKnown).map((turn) => turn.usage.inputTokens), [40]);
  const replayed = (await readCodexSession(fixture(t, [meta(), context(), count(), count(usage(50, 20, 10, 5)), count(), count()])))!;
  assert.deepEqual(replayed.turns.map((turn) => turn.usageKnown), [true, false, false]);
});

test('Codex malformed/missing cumulative usage is unknown instead of zero-priced telemetry', async (t) => {
  const invalid = [undefined, {}, { input_tokens: 1 }, usage(-1, 0, 0, 0), usage(1, 2, 0, 0), usage(1, 0, 1, 2), { ...usage(), output_tokens: '20' }, { ...usage(), total_tokens: 999 }, { ...usage(), input_tokens: Number.MAX_SAFE_INTEGER + 1 }, { ...usage(), cache_write_input_tokens: -1 }];
  const file = fixture(t, [meta(), context(), ...invalid.map((u) => count(u ?? null)), count()]);
  const session = (await readCodexSession(file))!;
  assert.equal(session.turns.filter((turn) => turn.usageKnown === false).length, invalid.length);
  assert.equal(session.turns.at(-1)?.usageKnown, true);
  assert.equal(session.firstTurnPromptTokens, 0);
});

test('Codex rate limit updates are not turns; unbilled assistant activity is unknown', async (t) => {
  const file = fixture(t, [meta(), context(), { type: 'event_msg', payload: { type: 'token_count', info: null } }, call('apply_patch'), { type: 'event_msg', payload: { type: 'token_count', info: null } }]);
  const session = (await readCodexSession(file))!;
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].usageKnown, false);
});

test('Codex model switches and unattributable cumulative jumps stay distinguishable', async (t) => {
  const file = fixture(t, [meta(), context('first-model'), count(), context('second-model'), count(usage(200, 120, 40, 20), usage()), count(usage(400, 240, 80, 40), usage())]);
  const session = (await readCodexSession(file))!;
  assert.deepEqual(session.turns.map((turn) => turn.model), ['first-model', 'second-model', 'unknown']);
});

test('Codex retains only tool names and truncated shell commands, never message text or arbitrary tool inputs', async (t) => {
  const secret = 'PRIVATE_PROMPT_CONTENT_DO_NOT_RETAIN';
  const file = fixture(t, [meta(), context(),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: secret }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: secret }] } },
    call('functions.exec_command', { cmd: 'npm test ' + 'x'.repeat(500), input: secret }),
    call('functions.exec_command', { cmd: 'npm test ' + 'x'.repeat(500) }),
    call('mcp__docs_server__search', { query: secret }, 'mcp1'),
    call('spawn_agent', { agent_type: 'reviewer', prompt: secret }, 'agent1'),
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'patch', name: 'apply_patch', input: secret } },
    { type: 'response_item', payload: { type: 'local_shell_call', call_id: 'shell', action: { command: ['bash', '-lc', 'cargo test'] } } },
    count(),
  ]);
  const session = (await readCodexSession(file))!;
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].commands[0].length, 400);
  assert.deepEqual(session.turns[0].tools, ['functions.exec_command', 'mcp__docs_server__search', 'spawn_agent', 'apply_patch', 'local_shell']);
  assert.equal(session.turns[0].commands[1], 'bash -lc cargo test');
  assert.ok(session.mcpServersUsed.has('docs_server'));
  assert.ok(session.subagentsUsed.has('reviewer'));
  assert.equal(JSON.stringify(session).includes(secret), false);
});

test('Codex malformed JSON, scalar content, malformed tool arguments and truncated final line do not hide valid records', async (t) => {
  const file = fixture(t, ['null', '[]', '{broken', meta(), context(), { type: 'response_item', payload: 'bad' }, { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{broken' } }, count(), '{"type":']);
  const session = (await readCodexSession(file))!;
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].usageKnown, true);
  assert.deepEqual(session.turns[0].commands, []);
});

test('Codex oversized lines are discarded with valid following and unterminated records intact', async (t) => {
  const file = fixture(t, [meta(), context(), 'x'.repeat(16 * 1024 * 1024 + 1), count()]);
  const session = (await readCodexSession(file))!;
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].usage.inputTokens, 40);
});

test('Codex excludes inherited/forked and multi-project rollouts to prevent double counting and misattribution', async (t) => {
  const fork = meta();
  const forked = { ...fork, payload: { ...fork.payload, forked_from_id: 'parent' } };
  assert.equal(await readCodexSession(fixture(t, [forked, context(), count()])), undefined);
  assert.equal(await readCodexSession(fixture(t, [meta(), context(), count(), context('other', '/other/project'), count(usage(200, 120, 40, 20), usage())])), undefined);
  const copiedMeta = (await readCodexSession(fixture(t, [meta(), meta('parent', '/other/project'), context(), count()])))!;
  assert.equal(copiedMeta.id, 's1');
  assert.equal(copiedMeta.project, codexProjectId(cwd));
});

test('Codex canonical project IDs distinguish sibling paths and normalize Windows paths', () => {
  assert.equal(codexProjectId('C:\\Work\\Repo\\'), codexProjectId('c:/work/repo'));
  assert.equal(codexProjectId('C:\\Work\\Repo\\src\\..'), codexProjectId('c:/work/repo'));
  assert.notEqual(codexProjectId('/work/repo'), codexProjectId('/work/repo-other'));
});

test('Codex scanner respects CODEX_HOME, project isolation, archives, limits and duplicate session IDs', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-codex-scan-'));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const write = (relative: string, id: string, directory: string, modified: number) => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [meta(id, directory), context('test-model', directory), count()].map((entry) => JSON.stringify(entry)).join('\n'));
    fs.utimesSync(file, modified, modified);
  };
  write('sessions/2026/01/01/other.jsonl', 'other', `${cwd}-other`, 400);
  write('sessions/2026/01/01/recent.jsonl', 'recent', cwd, 300);
  write('archived_sessions/duplicate.jsonl', 'recent', cwd, 250);
  write('archived_sessions/older.jsonl', 'older', cwd, 200);
  assert.equal(codexHome(), home);
  assert.deepEqual((await scanCodexSessions({ cwd, limit: 1 })).map((s) => s.id), ['recent']);
  assert.deepEqual((await scanCodexSessions({ cwd })).map((s) => s.id), ['recent', 'older']);
  assert.deepEqual((await scanCodexSessions({ cwd, all: true })).map((s) => s.id), ['other', 'recent', 'older']);
  assert.deepEqual(await scanCodexSessions({ cwd, limit: 0 }), []);
  await assert.rejects(scanCodexSessions({ cwd, limit: -1 }), /non-negative integer/);
  await assert.rejects(scanCodexSessions({ cwd, limit: 1.5 }), /non-negative integer/);
});

test('Codex missing and unreadable files are skipped without leaks or crashes', async () => {
  assert.equal(await readCodexSession(path.join(os.tmpdir(), 'nonexistent-hm-codex-file.jsonl')), undefined);
  assert.equal(await readCodexSession(os.tmpdir()), undefined);
});
