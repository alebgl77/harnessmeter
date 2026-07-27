/**
 * The cache arithmetic is this project's central claim. If it is wrong, nothing else
 * matters — so it is the first thing under test, with the exact figures quoted in the
 * README pinned here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alwaysOnCost,
  effectiveInputTokens,
  naiveRatio,
  onDemandCost,
  rateFor,
  turnCostUsd,
} from '../src/pricing.ts';

test('always-on cost = one write plus reads for every later turn', () => {
  // The README's worked example: 3,400 tokens across a 34-turn session.
  assert.equal(alwaysOnCost(3400, 34), 3400 * 1.25 + 3400 * 33 * 0.1);
  assert.equal(alwaysOnCost(3400, 34), 15470);
});

test('a 1-hour TTL write costs 2x, not 1.25x', () => {
  assert.equal(alwaysOnCost(1000, 10, '1h'), 1000 * 2 + 1000 * 9 * 0.1);
  assert.equal(alwaysOnCost(1000, 10, '1h'), 2900);
  assert.ok(alwaysOnCost(1000, 10, '1h') > alwaysOnCost(1000, 10, '5m'));
});

test('a single-turn session pays only the write', () => {
  assert.equal(alwaysOnCost(500, 1), 625);
  assert.equal(alwaysOnCost(500, 0), 0);
});

test('naive tokens-x-turns overstates a stable prefix by ~7x at 34 turns', () => {
  const r = naiveRatio(34);
  assert.ok(r > 7.4 && r < 7.5, `expected ~7.47, got ${r}`);
});

test('the overstatement grows with session length', () => {
  assert.ok(naiveRatio(300) > naiveRatio(34));
  assert.ok(naiveRatio(300) > 9);
});

test('effective input tokens apply each multiplier to its own bucket', () => {
  const eff = effectiveInputTokens({
    inputTokens: 100,
    cacheReadTokens: 1000,
    cacheWrite5m: 200,
    cacheWrite1h: 300,
    outputTokens: 0,
  });
  assert.equal(eff, 100 + 1000 * 0.1 + 200 * 1.25 + 300 * 2);
  assert.equal(eff, 1050);
});

test('turn cost uses the model rate on both sides', () => {
  const usd = turnCostUsd('claude-opus-5', {
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    outputTokens: 1_000_000,
  });
  assert.equal(usd, 5 + 25);
});

test('dated snapshots and bedrock prefixes resolve to the base rate', () => {
  assert.deepEqual(rateFor('claude-haiku-4-5-20251001'), rateFor('claude-haiku-4-5'));
  assert.deepEqual(rateFor('anthropic.claude-opus-5'), rateFor('claude-opus-5'));
});

test('an unknown model falls back rather than throwing', () => {
  const r = rateFor('some-future-model');
  assert.ok(r.in > 0 && r.out > 0);
});

test('on-demand cost scales with how often the block actually loads', () => {
  const full = alwaysOnCost(1000, 20);
  assert.equal(onDemandCost(1000, 20, 1), full);
  assert.equal(onDemandCost(1000, 20, 0), 0);
  assert.ok(Math.abs(onDemandCost(1000, 20, 0.25) - full * 0.25) < 1e-9);
});
