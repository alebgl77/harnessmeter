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
  isKnownModel,
  naiveRatio,
  onDemandCost,
  rateFor,
  turnCostUsd,
} from '../src/pricing.ts';

test('one write plus reads for every later turn is the floor, not the answer', () => {
  // The README's worked example: 3,400 tokens across a 34-turn session. This is what the
  // arithmetic gives if the prefix really were written once — the middle bar of the
  // diagram, kept here because the default argument still has to produce it exactly.
  assert.equal(alwaysOnCost(3400, 34), 3400 * 1.25 + 3400 * 33 * 0.1);
  assert.equal(alwaysOnCost(3400, 34), 15470);
});

test('the README diagram is arithmetically what the code computes', () => {
  // Three bars: tokens x turns, written once, and the measured two writes at the 1h rate.
  assert.equal(3400 * 34, 115600);
  assert.equal(alwaysOnCost(3400, 34), 15470);
  assert.equal(alwaysOnCost(3400, 34, '1h', 2), 24480);
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

test('naive tokens-x-turns overstates a write-once prefix by ~7x at 34 turns', () => {
  const r = naiveRatio(34);
  assert.ok(r > 7.4 && r < 7.5, `expected ~7.47, got ${r}`);
});

test('counting the real writes shrinks the overstatement to the README figure', () => {
  const r = naiveRatio(34, '1h', 2);
  assert.ok(r > 4.7 && r < 4.8, `expected ~4.72, got ${r}`);
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


// ── the write count is an input, not an assumption ──────────────────────────────────

test('an always-on block is priced at the number of writes it actually took', () => {
  // The default is one write, which is the arithmetic every "your CLAUDE.md costs $X"
  // post uses. It is also wrong for any session long enough for a cache entry to expire.
  assert.equal(alwaysOnCost(1000, 100, '5m', 1), 1000 * 1.25 + 1000 * 99 * 0.1);
  assert.equal(alwaysOnCost(1000, 100, '1h', 20), 1000 * 2 * 20 + 1000 * 80 * 0.1);
});

test('assuming one 5m write understates a resident block across every real profile', () => {
  // Session profiles measured on a real corpus. The correction is not a constant, which is
  // why the report prints the write count instead of a fixed factor — but it is always a
  // large understatement, never an overstatement.
  // Real (turns, writes) pairs read off the deduplicated corpus, spanning its whole range.
  for (const [turns, writes] of [[52, 1], [105, 10], [160, 5], [501, 22], [1608, 53]]) {
    const assumed = alwaysOnCost(1000, turns, '5m', 1);
    const measured = alwaysOnCost(1000, turns, '1h', writes);
    const ratio = measured / assumed;
    assert.ok(ratio > 1.05 && ratio < 2.6, `${turns} turns / ${writes} writes gave ${ratio}`);
    assert.ok(measured > assumed, 'the correction is always upward, never a discount');
  }
});

test('the write count is clamped to something physically possible', () => {
  // Never fewer than the write that puts the block there, never more than one per turn.
  assert.equal(alwaysOnCost(100, 10, '5m', 0), alwaysOnCost(100, 10, '5m', 1));
  assert.equal(alwaysOnCost(100, 10, '5m', 999), 100 * 1.25 * 10);
});

test('the naive ratio shrinks once the real writes are counted', () => {
  assert.ok(naiveRatio(563, '1h', 20) < naiveRatio(563, '5m', 1));
  assert.equal(naiveRatio(0), 1);
});

// ── synthetic turns are not an unpriced model ───────────────────────────────────────

test('local synthetic turns are priced at zero rather than reported as unknown', () => {
  // They carry all-zero usage. Left unpriced they stamp an "estimated" warning across a
  // figure that is exact, for turns that cost nothing.
  assert.equal(isKnownModel('<synthetic>'), true);
  assert.equal(rateFor('<synthetic>').in, 0);
  assert.equal(rateFor('<synthetic>').out, 0);
  assert.equal(
    turnCostUsd('<synthetic>', {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      outputTokens: 0,
    }),
    0,
  );
});

test('a genuinely unknown model is still flagged', () => {
  assert.equal(isKnownModel('some-future-model'), false);
});
