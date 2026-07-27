/**
 * Cache-weighted pricing.
 *
 * This file is the reason the project exists. Every "your CLAUDE.md costs you $X" post
 * multiplies tokens by turns and is wrong by roughly 7x, because a stable prefix is not
 * re-charged at full rate on every turn — it is written once and then read at a tenth.
 *
 *   write, 5-minute TTL ....... 1.25x input rate
 *   write, 1-hour TTL ......... 2.00x input rate
 *   read ...................... 0.10x input rate
 *
 * Transcripts record the 5m/1h split separately, so we apply the correct multiplier
 * rather than assuming one. Nothing here is estimated.
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
 * Written once, then read on every subsequent turn. The naive figure people quote is
 * `tokens * turns`; `naiveRatio` below reports how far off that is.
 */
export function alwaysOnCost(tokens: number, turns: number, ttl: '5m' | '1h' = '5m'): number {
  if (turns <= 0) return 0;
  const writeMult = ttl === '1h' ? CACHE_WRITE_1H_MULT : CACHE_WRITE_5M_MULT;
  return tokens * writeMult + tokens * Math.max(0, turns - 1) * CACHE_READ_MULT;
}

/** How badly naive tokens-x-turns overstates the real cost. */
export function naiveRatio(turns: number, ttl: '5m' | '1h' = '5m'): number {
  if (turns <= 0) return 1;
  const effective = alwaysOnCost(1, turns, ttl);
  return (1 * turns) / effective;
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
