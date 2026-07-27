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
import { encodeCwd, readSession } from '../src/transcript.ts';
import { extractJson } from '../src/agent.ts';

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

test('cwd encoding collapses separators the way Claude Code names project dirs', () => {
  assert.equal(encodeCwd('C:\\Users\\a\\proj'), 'C-Users-a-proj');
  assert.equal(encodeCwd('/home/a/proj'), '-home-a-proj');
});

test('json is recovered from fenced or bare model output', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('sure, here: {"a":2} hope that helps'), { a: 2 });
  assert.equal(extractJson('no object here'), undefined);
});
