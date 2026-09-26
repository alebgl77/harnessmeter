/**
 * Orchestration: transcripts + harness + evidence -> analysis.
 *
 * Keeps the exact and the estimated strictly apart. Anything sourced from a transcript is
 * exact; anything derived from character counts is labelled an estimate everywhere it is
 * shown.
 */

import type { Analysis, Claim, ClaimEvidence, Proposal, Session } from './types.ts';
import { alwaysOnCost, isKnownModel, turnCostUsd } from './pricing.ts';
import { confidenceFor, runEvidence, zeroHitUpperBound } from './evidence.ts';
import { scanHarness, type HarnessScanOptions, type HarnessSnapshot } from './harness.ts';
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
  /** Immutable source files used to extract both claims and bodies. Not serialized. */
  snapshot: HarnessSnapshot;
  evidence: Map<string, ClaimEvidence>;
};

/**
 * Everything free: claim extraction plus T0/T1 evidence.
 * Split out so T2 can escalate the uncertain claims before the aggregates are computed.
 */
export function prepare(cwd: string, options: HarnessScanOptions = {}): Prepared {
  const { claims, bodies, snapshot } = scanHarness(cwd, options);
  return { claims, bodies, snapshot, evidence: new Map() };
}

export function analyze(
  cwd: string,
  sessions: Session[],
  pre?: Prepared,
  t2?: T2Result,
  currentProject?: string | null,
): Analysis {
  const prepared = pre ?? prepare(cwd);
  const { claims, bodies } = prepared;
  const providers = new Set(sessions.length > 0
    ? sessions.map((s) => s.provider ?? 'claude')
    : claims.map((c) => c.provider ?? 'claude'));
  const provider = providers.size === 1 ? [...providers][0] : providers.size === 0 ? 'claude' : undefined;
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
  let knownTurns = 0;

  for (const s of sessions) {
    for (const t of s.turns) {
      turnCount++;
      models[t.model] = (models[t.model] ?? 0) + 1;
      if (t.usageKnown === false) continue;
      knownTurns++;
      if (s.provider === 'codex' || !isKnownModel(t.model)) unknown.add(t.model);
      billed.input += t.usage.inputTokens;
      billed.cacheRead += t.usage.cacheReadTokens;
      billed.cacheWrite5m += t.usage.cacheWrite5m;
      billed.cacheWrite1h += t.usage.cacheWrite1h;
      billed.output += t.usage.outputTokens;
      if (s.provider !== 'codex') spendUsd += turnCostUsd(t.model, t.usage);
    }
  }

  const completeSessions = sessions.filter(
    (s) => s.turns.length > 0 && s.turns.every((t) => t.usageKnown !== false),
  );
  const cacheSessions = completeSessions.filter((s) => s.provider !== 'codex' && s.cacheEconomicsKnown !== false);
  const cacheEconomicsKnown = cacheSessions.length > 0 && !sessions.some((s) => s.provider === 'codex');
  const spendKnown = knownTurns > 0 && !sessions.some((s) => s.provider === 'codex');
  const prefixSessions = completeSessions.filter((s) => s.firstTurnPromptTokens > 0);
  const medianPrefixTokens = median(
    prefixSessions.map((s) => s.firstTurnPromptTokens),
  );
  const medianTurnsPerSession = completeSessions.length > 0
    ? Math.max(1, median(completeSessions.map((s) => s.turns.length)))
    : 0;
  const medianCacheTurns = median(cacheSessions.map((s) => s.turns.length));

  // How the cache really behaved, rather than the convenient assumption that a prefix is
  // written once and read thereafter. Both figures are medians over measured sessions.
  const medianPrefixWrites = cacheSessions.length > 0
    ? Math.max(1, median(cacheSessions.map((s) => s.prefixWrites)))
    : 0;

  const populations = new Map<string, { all: number; project: number }>();
  for (const session of sessions) {
    const key = session.provider ?? 'claude';
    let counts = populations.get(key);
    if (!counts) { counts = { all: 0, project: 0 }; populations.set(key, counts); }
    counts.all++;
    if (currentProject === undefined || session.project === currentProject) counts.project++;
  }
  const absenceEvidenceKnown = claims.length > 0 && claims.every((claim) =>
    claim.provider !== 'codex' && evidence.get(claim.id)?.absenceEvidenceKnown !== false,
  );
  // Unrelated providers cannot invalidate observable Claude claims, but a Codex claim
  // has no statistical absence resolution. The corpus is only a ceiling. Evidence records
  // left after provider, project, age and T2 sampling filters; never rescan its turns.
  const judgedAgainst = absenceEvidenceKnown ? claims.reduce((floor, claim) => {
    const counts = populations.get(claim.provider ?? 'claude');
    const observed = evidence.get(claim.id)?.observedIn;
    const measured = typeof observed === 'number' && Number.isFinite(observed)
      ? Math.max(0, Math.trunc(observed)) : 0;
    return Math.min(floor, measured, (claim.scope === 'user' ? counts?.all : counts?.project) ?? 0);
  }, claims.length > 0 ? sessions.length : 0) : 0;
  const oneHourSessions = cacheSessions.filter((s) => s.cacheTtl === '1h').length;
  const cacheTtl: '5m' | '1h' = oneHourSessions * 2 > cacheSessions.length ? '1h' : '5m';

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
    // Codex absence and cache-write economics are not measured. Even externally
    // supplied verdicts cannot turn its observations into destructive proposals.
    if (c.provider === 'codex' || !populations.has(c.provider ?? 'claude')) continue;

    if (c.kind === 'mcp-server' && ev.verdict === 'ballast') {
      const fromT2 = ev.confidenceSource === 't2-judge';
      proposals.push({
        claimId: c.id,
        label: c.label,
        action: 'evict',
        savingPerSession: 0, // schema size is runtime-only; reported as part of the residual
        receipt: {
          tier: ev.tier, sessions: ev.observedIn, firedIn: ev.firedIn,
          class: c.class, protected: false,
          confidence: fromT2 ? (ev.confidence ?? 'low') : confidenceFor(ev.observedIn),
          confidenceSource: fromT2 ? 't2-judge' : 'zero-hit-bound',
          boundPct: zeroHitUpperBound(ev.observedIn) * 100,
        },
      });
      continue;
    }

    if (c.alwaysOnTokens <= 0) continue;
    if (ev.verdict !== 'ballast') continue;

    const saving = cacheSessions.length > 0
      ? alwaysOnCost(c.alwaysOnTokens, medianCacheTurns, cacheTtl, medianPrefixWrites)
      : 0;
    // A rule the agent ignored is not the same problem as a rule nothing needed.
    // The first wants rewriting, the second wants demoting — don't conflate them.
    const ignored = ev.note.includes('present but not followed');
    const fromT2 = ev.confidenceSource === 't2-judge';
    proposals.push({
      claimId: c.id,
      label: c.label,
      action: ignored ? 'investigate' : c.kind === 'prose-section' ? 'demote' : 'evict',
      savingPerSession: Math.round(saving),
      receipt: {
        tier: ev.tier, sessions: ev.observedIn, firedIn: ev.firedIn,
        class: c.class, protected: false,
        confidence: fromT2
          ? (ev.confidence ?? 'low')
          : ev.tier === 'none' ? 'low' : confidenceFor(ev.observedIn),
        confidenceSource: fromT2 ? 't2-judge' : 'zero-hit-bound',
        boundPct: zeroHitUpperBound(ev.observedIn) * 100,
      },
    });
  }

  proposals.sort((a, b) => b.savingPerSession - a.savingPerSession);

  const nonNegative = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  const calls = Math.trunc(nonNegative(t2?.calls) ?? 0);
  const attempts = Math.max(calls, Math.trunc(nonNegative(t2?.attempts) ?? calls));
  const rawTokens = t2?.tokens;
  const rawCost = t2?.costUsd;
  const numericTokens = nonNegative(rawTokens);
  const numericCost = nonNegative(rawCost);
  const suppliedTokenResponses = nonNegative(t2?.tokenResponses);
  const suppliedCostResponses = nonNegative(t2?.costResponses);
  const tokenResponses = Math.min(
    calls,
    Math.trunc(suppliedTokenResponses ?? (numericTokens !== undefined && numericTokens > 0 ? calls : 0)),
  );
  const costResponses = Math.min(
    calls,
    Math.trunc(suppliedCostResponses ?? (numericCost !== undefined && numericCost > 0 ? calls : 0)),
  );
  // Legacy callers used zero as an absence placeholder. Once a call happened, that shape
  // cannot distinguish a true measured zero from missing telemetry, so fail closed.
  const tokens = attempts === 0
    ? 0
    : rawTokens === null || calls !== attempts || tokenResponses !== calls
    ? null
    : numericTokens === undefined || (numericTokens === 0 && suppliedTokenResponses === undefined)
      ? null
      : numericTokens;
  const usd = attempts === 0
    ? 0
    : rawCost === null || calls !== attempts || costResponses !== calls
    ? null
    : numericCost === undefined || (numericCost === 0 && suppliedCostResponses === undefined)
      ? null
      : numericCost;
  const measuredTokens = nonNegative(t2?.measuredTokens) ?? (tokens ?? 0);
  const measuredCostUsd = nonNegative(t2?.measuredCostUsd) ?? (usd ?? 0);
  const t2Reached = attempts > 0 || (t2?.verdicts.size ?? 0) > 0;

  return {
    scannedAt: new Date().toISOString(),
    provider,
    cacheEconomicsKnown,
    spendKnown,
    absenceEvidenceKnown,
    projects: [...new Set(sessions.map((s) => s.project))],
    sessionCount: sessions.length,
    turnCount,
    telemetryCoverage: {
      knownTurns,
      totalTurns: turnCount,
      prefixSessions: prefixSessions.length,
      cacheSessions: cacheSessions.length,
      status: turnCount > 0 && knownTurns === turnCount ? 'full' : knownTurns > 0 ? 'partial' : 'none',
    },
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
    evidenceFloorSessions: judgedAgainst,
    cost: {
      tokens,
      usd,
      attempts,
      calls,
      modelCalls: attempts === 0
        ? 0
        : nonNegative(t2?.modelCalls) !== undefined
          ? Math.trunc(t2!.modelCalls as number)
          : calls === attempts ? calls : null,
      networkCalls: attempts === 0 ? 0 : null,
      measuredTokens,
      measuredCostUsd,
      tokenResponses,
      costResponses,
      tier: t2Reached ? 'T0/T1/T2' : 'T0/T1',
      model: t2?.model,
      judged: t2?.verdicts.size,
    },
  };
}
