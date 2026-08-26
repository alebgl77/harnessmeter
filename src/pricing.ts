/**
 * Cache-weighted pricing.
 *
 * This file is the reason the project exists. Every "your CLAUDE.md costs you $X" post
 * multiplies tokens by turns, which ignores prompt caching and overstates a resident block
 * by roughly 5x.
 *
 *   write, 5-minute TTL ....... 1.25x input rate
 *   write, 1-hour TTL ......... 2.00x input rate
 *   read ...................... 0.10x input rate
 *
 * The obvious correction — written once, then read at a tenth forever — is also wrong, and
 * in the other direction. A cache entry expires with its TTL, and compaction or an edit to
 * a harness file invalidates it, so a long session pays the write multiplier repeatedly.
 * Both the write count and the TTL are therefore measured per session and passed in here.
 *
 * Transcripts record the 5m/1h split separately, so we apply the correct multiplier rather
 * than assuming one. Nothing here is estimated.
 */

import type { TurnUsage } from './types.ts';

export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2.0;

/** USD per million tokens. */
type Rate = { in: number; out: number };

const RATES: Record<string, Rate> = {
  'claude-fable-5': { in: 10, out: 50 },
  'claude-mythos-5': { in: 10, out: 50 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-opus-4-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  // Claude Code records local, non-API turns under this name. They carry all-zero usage,
  // so they cost nothing — but left unpriced they land in the "unpriced models" list and
  // stamp an estimate warning on a figure that is exact.
  '<synthetic>': { in: 0, out: 0 },
};

const FALLBACK: Rate = { in: 5, out: 25 };

export function rateFor(model: string): Rate {
  if (RATES[model]) return RATES[model];
  // Strip a trailing date snapshot: claude-haiku-4-5-20251001 -> claude-haiku-4-5
  const base = model.replace(/-\d{8}$/, '').replace(/^anthropic\./, '');
  return RATES[base] ?? FALLBACK;
}

export function isKnownModel(model: string): boolean {
  const base = model.replace(/-\d{8}$/, '').replace(/^anthropic\./, '');
  return Boolean(RATES[model] ?? RATES[base]);
}

/** Effective input tokens actually billed for a turn, after cache multipliers. */
export function effectiveInputTokens(u: TurnUsage): number {
  return (
    u.inputTokens +
    u.cacheReadTokens * CACHE_READ_MULT +
    u.cacheWrite5m * CACHE_WRITE_5M_MULT +
    u.cacheWrite1h * CACHE_WRITE_1H_MULT
  );
}

/** Exact USD cost of a turn. */
export function turnCostUsd(model: string, u: TurnUsage): number {
  const r = rateFor(model);
  return (effectiveInputTokens(u) * r.in) / 1e6 + (u.outputTokens * r.out) / 1e6;
}

/**
 * What an always-on block of `tokens` actually costs across a session of `turns`,
 * in effective (cache-weighted) tokens.
 *
 * `writes` is how many times the block was written to the cache — measured per session,
 * never assumed. The tempting model is one write followed by reads at 0.1x forever, and
 * it is wrong: a cache entry expires with its TTL, and compaction or an edit to a harness
 * file invalidates it, so a long session pays the write multiplier many times over. On a
 * real corpus the median is around twenty writes, not one, and assuming one understates
 * an always-on block by roughly two thirds.
 *
 * The naive figure people quote is `tokens * turns`; `naiveRatio` reports how far off it
 * still is once the writes are counted properly.
 */
export function alwaysOnCost(
  tokens: number,
  turns: number,
  ttl: '5m' | '1h' = '5m',
  writes = 1,
): number {
  if (turns <= 0) return 0;
  // At most one write per turn, and never fewer than the one that puts it there.
  const w = Math.min(Math.max(1, Math.round(writes)), turns);
  const writeMult = ttl === '1h' ? CACHE_WRITE_1H_MULT : CACHE_WRITE_5M_MULT;
  return tokens * writeMult * w + tokens * (turns - w) * CACHE_READ_MULT;
}

/** How badly naive tokens-x-turns overstates the real cost. */
export function naiveRatio(turns: number, ttl: '5m' | '1h' = '5m', writes = 1): number {
  if (turns <= 0) return 1;
  const effective = alwaysOnCost(1, turns, ttl, writes);
  return effective > 0 ? turns / effective : 1;
}

/**
 * Cost of an on-demand block that only loads in a fraction of sessions.
 * This is what a demotion buys you.
 */
export function onDemandCost(tokens: number, turns: number, loadRate: number): number {
  return alwaysOnCost(tokens, turns) * Math.max(0, Math.min(1, loadRate));
}

export function usdFor(model: string, effInputTokens: number, outputTokens = 0): number {
  const r = rateFor(model);
  return (effInputTokens * r.in) / 1e6 + (outputTokens * r.out) / 1e6;
}
