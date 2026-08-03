/**
 * Class inference, pinned from both directions.
 *
 * Prevention claims are protected from eviction, so this classifier decides what the tool
 * is allowed to judge at all. Too wide and it covers the whole harness and reports nothing;
 * too narrow and a real prohibition gets condemned. Both failure modes are asserted here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { estTokens, inferClass } from '../src/harness.ts';

test('a real prohibition in a rule line is prevention', () => {
  const { cls } = inferClass('# Rules\n\n- Never commit a secret to the repository.', 'prose-section');
  assert.equal(cls, 'prevention');
});

test('a secret-family noun in a rule line is prevention', () => {
  const { cls } = inferClass('- Store the API key in the vault, not in .env', 'prose-section');
  assert.equal(cls, 'prevention');
});

test('"avoid" alone is not a prohibition', () => {
  const { cls } = inferClass('# Style\n\nAvoid overly long lines where a short one reads better.', 'prose-section');
  assert.notEqual(cls, 'prevention');
});

test('the word "security" alone is not a prohibition', () => {
  const { cls } = inferClass('# Notes\n\nThis module handles security headers and CORS.', 'prose-section');
  assert.notEqual(cls, 'prevention');
});

test('capability definitions are never prevention, whatever they contain', () => {
  const designSkill =
    'Never use generic AI aesthetics. Do not use purple gradients. Avoid system fonts.';
  assert.equal(inferClass(designSkill, 'skill').cls, 'knowledge');
  assert.equal(inferClass(designSkill, 'subagent').cls, 'knowledge');
  assert.equal(inferClass(designSkill, 'mcp-server').cls, 'knowledge');
});

test('a prevention claim is protected, a knowledge claim is not', () => {
  assert.equal(inferClass('- Never force-push to main.', 'prose-section').cls, 'prevention');
  assert.notEqual(inferClass('Run the linter when convenient.', 'prose-section').cls, 'prevention');
});

test('workflow, architecture and style are distinguished from each other', () => {
  assert.equal(inferClass('Always run the test suite before pushing.', 'prose-section').cls, 'workflow');
  assert.equal(inferClass('Respect the module boundary between core and ui.', 'prose-section').cls, 'architecture');
  assert.equal(inferClass('Use kebab-case naming for files.', 'prose-section').cls, 'style');
});

test('class inference is always reported as inferred, never as declared', () => {
  assert.equal(inferClass('anything at all', 'prose-section').inferred, true);
  assert.equal(inferClass('anything at all', 'skill').inferred, true);
});

test('token estimation is monotonic and calibrated to ~3.8 chars per token', () => {
  assert.equal(estTokens(380), 100);
  assert.ok(estTokens(1000) > estTokens(500));
  assert.equal(estTokens(0), 0);
});
