/**
 * Orchestration: transcripts + harness + evidence -> analysis.
 *
 * Keeps the exact and the estimated strictly apart. Anything sourced from a transcript is
 * exact; anything derived from character counts is labelled an estimate everywhere it is
 * shown.
 */

import fs from 'node:fs';
import type { Analysis, Claim, Proposal, Session } from './types.ts';
import { alwaysOnCost, turnCostUsd } from './pricing.ts';
import { runEvidence } from './evidence.ts';
import { scanHarness } from './harness.ts';

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function analyze(cwd: string, sessions: Session[]): Analysis {
  const { claims } = scanHarness(cwd);

  const bodies = new Map<string, string>();
  for (const c of claims) {
    if (c.source.startLine === 0) continue;
    try {
      const text = fs.readFileSync(c.source.file, 'utf8');
      const lines = text.split(/\r?\n/);
      bodies.set(c.id, lines.slice(c.source.startLine - 1, c.source.endLine).join('\n'));
    } catch {
      /* unreadable — evidence falls back to the label */
    }
  }

  const evidence = runEvidence({ claims, sessions, bodies });

  // ---- exact aggregates, straight from the transcripts -----------------------------
  const billed = { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };
  const models: Record<string, number> = {};
  let spendUsd = 0;
  let turnCount = 0;

  for (const s of sessions) {
    for (const t of s.turns) {
      billed.input += t.usage.inputTokens;
      billed.cacheRead += t.usage.cacheReadTokens;
      billed.cacheWrite5m += t.usage.cacheWrite5m;
      billed.cacheWrite1h += t.usage.cacheWrite1h;
      billed.output += t.usage.outputTokens;
      spendUsd += turnCostUsd(t.model, t.usage);
      models[t.model] = (models[t.model] ?? 0) + 1;
      turnCount++;
    }
  }

  const medianPrefixTokens = median(
    sessions.map((s) => s.firstTurnPromptTokens).filter((n) => n > 0),
  );
  const medianTurnsPerSession = Math.max(1, median(sessions.map((s) => s.turns.length)));

  // ---- estimated harness footprint --------------------------------------------------
  const harnessEstTokens = claims.reduce((n, c) => n + c.alwaysOnTokens, 0);
  const residualTokens = Math.max(0, medianPrefixTokens - harnessEstTokens);

  // ---- dead share, over the part we can actually attribute ---------------------------
  let deadTokens = 0;
  let attributableTokens = 0;
  for (const c of claims) {
    if (c.alwaysOnTokens <= 0) continue;
    attributableTokens += c.alwaysOnTokens;
    const v = evidence.get(c.id)?.verdict;
    if (v === 'ballast') deadTokens += c.alwaysOnTokens;
  }
  const deadSharePct = attributableTokens > 0 ? (deadTokens / attributableTokens) * 100 : 0;

  // ---- proposals ---------------------------------------------------------------------
  const proposals: Proposal[] = [];
  for (const c of claims) {
    const ev = evidence.get(c.id);
    if (!ev) continue;

    // Prevention claims are never proposed for removal. Their yield is inverted.
    if (c.protected) continue;

    if (c.kind === 'mcp-server' && ev.verdict === 'ballast') {
      proposals.push({
        claimId: c.id,
        label: c.label,
        action: 'evict',
        savingPerSession: 0, // schema size is runtime-only; reported as part of the residual
        receipt: {
          tier: ev.tier, sessions: ev.observedIn, firedIn: ev.firedIn,
          class: c.class, protected: false, confidence: ev.observedIn >= 20 ? 'high' : 'medium',
        },
      });
      continue;
    }

    if (c.alwaysOnTokens <= 0) continue;
    if (ev.verdict !== 'ballast') continue;

    const saving = alwaysOnCost(c.alwaysOnTokens, medianTurnsPerSession);
    proposals.push({
      claimId: c.id,
      label: c.label,
      action: c.kind === 'prose-section' ? 'demote' : 'evict',
      savingPerSession: Math.round(saving),
      receipt: {
        tier: ev.tier, sessions: ev.observedIn, firedIn: ev.firedIn,
        class: c.class, protected: false,
        confidence: ev.tier === 'none' ? 'low' : ev.observedIn >= 20 ? 'high' : 'medium',
      },
    });
  }

  proposals.sort((a, b) => b.savingPerSession - a.savingPerSession);

  return {
    scannedAt: new Date().toISOString(),
    projects: [...new Set(sessions.map((s) => s.project))],
    sessionCount: sessions.length,
    turnCount,
    spendUsd,
    billedTokens: billed,
    medianPrefixTokens,
    harnessEstTokens,
    residualTokens,
    medianTurnsPerSession,
    models,
    claims,
    evidence,
    proposals,
    deadSharePct,
    analysisCostTokens: 0,
  };
}
