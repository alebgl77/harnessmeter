export type BudgetCheck = {
  metric: 'estimated-resident-tokens' | 'growth-percent';
  actual: number | null;
  limit: number;
  passed: boolean;
  reason?: string;
};

export type Budget = { passed: boolean; checks: BudgetCheck[]; violations: BudgetCheck[] };

/** Growth from zero is explicitly unbounded, never serialized as Infinity or NaN. */
export function growthPercent(current: number, baseline: number): number | null {
  if (baseline === 0) return current === 0 ? 0 : null;
  const result = ((current - baseline) / baseline) * 100;
  return Number.isFinite(result) ? result : null;
}

export function evaluateBudget(current: number, options: {
  maxTokens?: number; maxGrowth?: number; baselineTokens?: number;
}): Budget {
  const finite = (n: number) => Number.isFinite(n) && n >= 0;
  if (!finite(current) || (options.baselineTokens !== undefined && !finite(options.baselineTokens)) ||
      (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 0)) ||
      (options.maxGrowth !== undefined && !finite(options.maxGrowth))) throw new Error('Invalid budget numbers');
  const checks: BudgetCheck[] = [];
  if (options.maxTokens !== undefined) checks.push({
    metric: 'estimated-resident-tokens', actual: current, limit: options.maxTokens, passed: current <= options.maxTokens,
  });
  if (options.maxGrowth !== undefined) {
    if (options.baselineTokens === undefined) throw new Error('Growth budget requires baseline tokens');
    const actual = growthPercent(current, options.baselineTokens);
    checks.push({
      metric: 'growth-percent', actual, limit: options.maxGrowth,
      passed: actual !== null && actual <= options.maxGrowth,
      ...(actual === null ? { reason: 'Growth is unbounded from a zero baseline; any positive footprint exceeds a finite growth budget.' } : {}),
    });
  }
  return { passed: checks.every((check) => check.passed), checks, violations: checks.filter((check) => !check.passed) };
}
