/**
 * Orchestration: transcripts + harness + evidence -> analysis.
 *
 * Keeps the exact and the estimated strictly apart. Anything sourced from a transcript is
 * exact; anything derived from character counts is labelled an estimate everywhere it is
 * shown.
 */

import fs from 'node:fs';
import type { Analysis, Claim, ClaimEvidence, Proposal, Session } from './types.ts';
import { alwaysOnCost, isKnownModel, turnCostUsd } from './pricing.ts';
import { confidenceFor, runEvidence, zeroHitUpperBound } from './evidence.ts';
import { scanHarness } from './harness.ts';
import type { T2Result } from './evidence-t2.ts';

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export type Prepared = {
  claims: Claim[];
  bodies: Map<string, string>;
  evidence: Map<string, ClaimEvidence>;
};

/**
 * Everything free: claim extraction plus T0/T1 evidence.
 * Split out so T2 can escalate the uncertain claims before the aggregates are computed.
 */
export function prepare(cwd: string): Prepared {
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

  return { claims, bodies, evidence: new Map() };
}

export function analyze(
  cwd: string,
  sessions: Session[],
  pre?: Prepared,
  t2?: T2Result,
  currentProject?: string,
): Analysis {
  const prepared = pre ?? prepare(cwd);
  const { claims, bodies } = prepared;
  const evidence =
    prepared.evidence.size > 0
      ? prepared.evidence
      : runEvidence({ claims, sessions, bodies, currentProject });

  // ---- exact aggregates, straight from the transcripts -----------------------------
  const billed = { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };
  const models: Record<string, number> = {};
  const unknown = new Set<string>();
  let spendUsd = 0;
  let turnCount = 0;

  for (const s of sessions) {
    for (const t of s.turns) {
      if (!isKnownModel(t.model)) unknown.add(t.model);
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

  // How the cache really behaved, rather than the convenient assumption that a prefix is
  // written once and read thereafter. Both figures are medians over measured sessions.
  const medianPrefixWrites = Math.max(1, median(sessions.map((s) => s.prefixWrites)));

  const projectScoped = currentProject
    ? sessions.filter((s) => s.project === currentProject).length
    : sessions.length;
  const hasProjectClaim = claims.some((c) => c.scope === 'project' && c.alwaysOnTokens > 0);
  const judgedAgainst = hasProjectClaim ? Math.min(sessions.length, projectScoped) : sessions.length;
  const oneHourSessions = sessions.filter((s) => s.cacheTtl === '1h').length;
  const cacheTtl: '5m' | '1h' = oneHourSessions * 2 > sessions.length ? '1h' : '5m';

  // ---- estimated harness footprint --------------------------------------------------
  const harnessEstTokens = claims.reduce((n, c) => n + c.alwaysOnTokens, 0);
  const residualTokens = Math.max(0, medianPrefixTokens - harnessEstTokens);

  // ---- dead share, over the part we can actually attribute ---------------------------
  let deadTokens = 0;
  let attributableTokens = 0;
  for (const c of claims) {
    if (c.alwaysOnTokens <= 0) continue;
    const ev = evidence.get(c.id);
    // A claim nothing can ever rule against belongs in neither half of this fraction.
    // Slash commands are the case: an invocation lives in the user's message, which we do
    // not read, so they are permanently unproven. Leaving them in the denominator alone
    // would quietly shrink the dead share by however many commands the user has installed.
    if (ev?.tier === 'none' && ev.verdict === 'unproven' && c.kind === 'command') continue;
    attributableTokens += c.alwaysOnTokens;
    if (ev?.verdict === 'ballast') deadTokens += c.alwaysOnTokens;
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
          class: c.class, protected: false, confidence: confidenceFor(ev.observedIn),
          boundPct: zeroHitUpperBound(ev.observedIn) * 100,
        },
      });
      continue;
    }

    if (c.alwaysOnTokens <= 0) continue;
    if (ev.verdict !== 'ballast') continue;

    const saving = alwaysOnCost(
      c.alwaysOnTokens,
      medianTurnsPerSession,
      cacheTtl,
      medianPrefixWrites,
    );
    // A rule the agent ignored is not the same problem as a rule nothing needed.
    // The first wants rewriting, the second wants demoting — don't conflate them.
    const ignored = ev.note.includes('present but not followed');
    proposals.push({
      claimId: c.id,
      label: c.label,
      action: ignored ? 'investigate' : c.kind === 'prose-section' ? 'demote' : 'evict',
      savingPerSession: Math.round(saving),
      receipt: {
        tier: ev.tier, sessions: ev.observedIn, firedIn: ev.firedIn,
        class: c.class, protected: false,
        confidence: ev.tier === 'none' ? 'low' : confidenceFor(ev.observedIn),
        boundPct: zeroHitUpperBound(ev.observedIn) * 100,
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
    unknownModels: [...unknown].sort(),
    harnessEstTokens,
    residualTokens,
    medianTurnsPerSession,
    medianPrefixWrites,
    cacheTtl,
    models,
    claims,
    evidence,
    proposals,
    deadSharePct,
    // The weakest population any claim was judged against, not the largest. Under --all
    // a project claim is judged only against its own project's sessions, and quoting the
    // whole corpus would advertise a resolution those claims do not have.
    evidenceFloorPct: zeroHitUpperBound(judgedAgainst) * 100,
    cost: {
      tokens: t2?.tokens ?? 0,
      usd: t2?.costUsd ?? 0,
      calls: t2?.calls ?? 0,
      tier: t2 ? 'T0/T1/T2' : 'T0/T1',
      model: t2?.model,
      judged: t2?.verdicts.size,
    },
  };
}
