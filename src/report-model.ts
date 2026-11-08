/** Shared presentation contract for the HTML and terminal reports. */
import type { Analysis } from './types.ts';
import type { compareBaselines } from './baseline.ts';
import type { Budget } from './budget.ts';
import { naiveRatio } from './pricing.ts';
import { deadShareClaims } from './claim-metrics.ts';

export type ReportContext = {
  comparison?: ReturnType<typeof compareBaselines>;
  budget?: Budget;
  synthetic?: boolean;
};

export function reportModel(a: Analysis) {
  const coverage = a.telemetryCoverage;
  const hasBilling = coverage.knownTurns > 0;
  const hasSpend = hasBilling && a.spendKnown !== false && a.provider !== 'codex';
  const hasEconomics = a.cacheEconomicsKnown !== false && a.provider !== 'codex' && coverage.cacheSessions > 0;
  const hasPrefix = coverage.prefixSessions > 0;
  const prefixComparable = hasPrefix && a.prefixBreakdownKnown !== false && a.harnessEstTokens <= a.medianPrefixTokens;
  const canJudgeAbsence = a.sessionCount > 0 && a.evidenceFloorSessions > 0 && a.absenceEvidenceKnown !== false && a.provider !== 'codex';
  const providerName = a.provider === 'codex' ? 'Codex' : !a.provider && a.claims.some((claim) => claim.provider === 'codex') ? 'Multiple providers' : 'Claude Code';
  const eligible = deadShareClaims(a);
  const deadShareTokens = a.deadShareTokens ?? eligible.reduce((sum, claim) => sum + claim.alwaysOnTokens, 0);
  const cacheTurns = a.medianCacheTurnsPerSession ?? a.medianTurnsPerSession;
  const ratio = hasPrefix && hasEconomics ? naiveRatio(cacheTurns, a.cacheTtl, a.medianPrefixWrites) : undefined;
  return { hasBilling, hasSpend, hasEconomics, hasPrefix, prefixComparable, canJudgeAbsence, providerName, deadShareTokens, eligibleClaims: eligible.length, cacheTurns, ratio };
}
