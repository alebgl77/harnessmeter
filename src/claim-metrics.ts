import type { Analysis } from './types.ts';

/** Claims eligible for the dead-share denominator, shared by analysis and reports. */
export function deadShareClaims(a: Pick<Analysis, 'claims' | 'evidence'>) {
  return a.claims.filter((claim) => {
    const ev = a.evidence.get(claim.id);
    return claim.alwaysOnTokens > 0 && !(claim.kind === 'command' && ev?.tier === 'none' && ev.verdict === 'unproven');
  });
}
