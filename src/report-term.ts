/** Terminal report. The thing people screenshot. */

import type { Analysis } from './types.ts';
import type { ReportContext } from './report-html.ts';
import { naiveRatio } from './pricing.ts';
import { VERSION } from './version.ts';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string | number) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2;37');
const bold = c('1');
const amber = c('38;5;179');
const green = c('38;5;71');
const rust = c('38;5;131');
const grey = c('38;5;244');

const n = (x: number) => Math.round(x).toLocaleString('en-US');

function bar(frac: number, width = 22): string {
  const full = Math.max(0, Math.min(width, Math.round(frac * width)));
  return '█'.repeat(full) + dim('·'.repeat(width - full));
}

export function renderTerminal(a: Analysis, context: ReportContext = {}): string {
  const L: string[] = [];
  const p = (s = '') => L.push(s);
  const coverage = a.telemetryCoverage;
  const hasBilling = coverage.knownTurns > 0;
  const hasSpend = hasBilling && a.spendKnown !== false && a.provider !== 'codex';
  const hasEconomics = a.cacheEconomicsKnown !== false && a.provider !== 'codex' && coverage.cacheSessions > 0;
  // Complete aggregate usage can coexist with a missing first-turn measurement.
  const hasPrefix = coverage.prefixSessions > 0;
  const canJudgeAbsence = a.sessionCount > 0 && a.evidenceFloorSessions > 0 && a.absenceEvidenceKnown !== false && a.provider !== 'codex';
  const providerName = a.provider === 'codex' ? 'Codex' : !a.provider && a.claims.some((claim) => claim.provider === 'codex') ? 'Multiple providers' : 'Claude Code';

  p();
  p(`  ${bold('harnessmeter')} ${dim(VERSION)} · ${providerName}${a.sessionCount === 0 ? ' · static inventory' : ''}`);
  p(`  ${grey(`${n(a.sessionCount)} sessions · ${n(a.turnCount)} turns · ${a.projects.length} project${a.projects.length === 1 ? '' : 's'}`)}`);
  p();

  if (context.comparison || context.budget?.checks.length) {
    p(`  ${amber('BASELINE & BUDGET')}`);
    const comparison = context.comparison;
    if (comparison) {
      const delta = (value: number) => (value > 0 ? '+' : '') + n(value);
      p(`    ${n(comparison.beforeTokens)} → ${n(comparison.currentTokens)} estimated resident tok · ${delta(comparison.deltaTokens)} tok · ${comparison.growthPercent === null ? 'unbounded from zero' : (comparison.growthPercent > 0 ? '+' : '') + comparison.growthPercent.toLocaleString('en-US', { maximumSignificantDigits: 4 }) + '%'}`);
      p(`    ${comparison.added.length} added · ${comparison.removed.length} removed · ${comparison.changed.length} changed`);
      for (const claim of comparison.added) p(`    added   ${claim.path} § ${claim.section} · +${n(claim.tokens)} tok`);
      for (const claim of comparison.removed) p(`    removed ${claim.path} § ${claim.section} · -${n(claim.tokens)} tok`);
      for (const change of comparison.changed) p(`    changed ${change.after.path} § ${change.after.section} · ${n(change.before.tokens)} → ${n(change.after.tokens)} tok (${delta(change.deltaTokens)})`);
      p(`    ${dim('File estimates, not billed savings.')}`);
    }
    if (context.budget?.checks.length) {
      p(`    Budget ${context.budget.passed ? green('PASS') : rust('FAIL')}`);
      for (const check of context.budget.checks) p(`    ${check.metric}: ${check.actual === null ? 'unbounded from zero' : check.actual} / limit ${check.limit} · ${check.passed ? 'PASS' : 'FAIL'}${check.reason ? ' · ' + check.reason : ''}`);
    }
    p();
  }
  // ---- billed telemetry --------------------------------------------------------
  const billedStatus =
    coverage.status === 'full'
      ? 'measured tokens, read from transcripts'
      : coverage.status === 'partial'
        ? `measured subtotal · ${coverage.knownTurns}/${coverage.totalTurns} turns`
        : `unknown · ${coverage.knownTurns}/${coverage.totalTurns} turns have compatible usage`;
  p(`  ${amber('BILLED')}  ${dim(billedStatus)}`);
  p();
  const b = a.billedTokens;
  if (hasBilling) {
    p(`    input (uncached)      ${n(b.input).padStart(12)}`);
    p(`    cache reads ${hasEconomics ? dim(' 0.1x') : '     '}     ${n(b.cacheRead).padStart(12)}`);
    if (hasEconomics) {
      p(`    cache writes ${dim('1.25x')}    ${n(b.cacheWrite5m).padStart(12)}`);
      p(`    cache writes ${dim('2x')}       ${n(b.cacheWrite1h).padStart(12)}`);
    } else p(`    cache writes                 ${amber('unknown')}`);
    p(`    output                ${n(b.output).padStart(12)}`);
    p(`    ${bold('api-equivalent')}        ${hasSpend ? bold('$' + a.spendUsd.toFixed(2)) : amber('unknown')}${hasSpend && coverage.status === 'partial' ? dim('  measured subtotal') : ''}`);
    p(`    ${dim(hasSpend ? 'list-price value of these measured tokens — not an invoice' : 'dollar value unavailable; measured token counts remain visible')}`);
  } else {
    p(`    input / cache / output       ${amber('unknown')}`);
    p(`    ${bold('api-equivalent')}              ${amber('unknown')}`);
    p(`    ${dim(a.sessionCount === 0 ? 'no sessions supplied; inventory sizes are estimates' : 'the transcript has assistant activity but no compatible usage fields')}`);
  }
  if (hasSpend && a.unknownModels.length) {
    p(
      `    ${amber('estimated')} ${dim(`— ${a.unknownModels.length} unpriced model${a.unknownModels.length === 1 ? '' : 's'} billed at a fallback rate:`)}`,
    );
    p(`    ${dim(a.unknownModels.slice(0, 3).join(', ').slice(0, 68))}`);
  }
  p();

  // ---- prefix ------------------------------------------------------------------
  const ratio = hasPrefix && hasEconomics
    ? naiveRatio(a.medianTurnsPerSession, a.cacheTtl, a.medianPrefixWrites)
    : undefined;
  const prefixStatus = hasPrefix
    ? `measured in ${coverage.prefixSessions}/${a.sessionCount} sessions — an upper bound`
    : 'unknown — no measured first-turn prompt';
  p(`  ${amber('ALWAYS-ON PREFIX')}  ${dim(prefixStatus)}`);
  p();
  if (hasPrefix) {
    p(`    median first turn     ${n(a.medianPrefixTokens).padStart(12)} tok`);
    p(`    ${dim('includes the opening user message, which cannot be separated')}`);
    p(`    ${grey('├─ harness files')}      ${grey(n(a.harnessEstTokens).padStart(12) + ' tok  (estimated)')}`);
    p(`    ${grey('└─ unattributed')}       ${grey(n(a.residualTokens).padStart(12) + ' tok  (composition unknown)')}`);
    p();
    if (ratio !== undefined) {
    p(`    ${dim(`at ${a.medianTurnsPerSession} turns/session, prompt caching makes the prefix`)}`);
    // Once a session writes its prefix often enough, caching stops being a discount. Rare,
    // but printing "0.9x cheaper" would be nonsense rather than a small number.
    p(`    ${dim(ratio >= 1
      ? `${ratio.toFixed(1)}x cheaper than tokens x turns would suggest.`
      : `${(1 / ratio).toFixed(1)}x MORE than tokens x turns would suggest.`)}`);
    p(`    ${dim(`measured: ${a.medianPrefixWrites} prefix write${a.medianPrefixWrites === 1 ? '' : 's'} per session at the ${a.cacheTtl} rate,`)}`);
    p(`    ${dim('not one — cache entries expire and compaction rebuilds the prompt.')}`);
    } else p(`    ${dim('cache economics and proposal savings are unknown for this provider.')}`);
  } else {
    p(`    median first turn          ${amber('unknown')}`);
    p(`    ${grey('├─ harness files')}      ${grey(n(a.harnessEstTokens).padStart(12) + ' tok  (estimated)')}`);
    p(`    ${grey('└─ unattributed')}             ${grey('unknown')}`);
    p();
    p(`    ${dim('cache economics and prompt-cache ratio are unknown.')}`);
  }
  p();

  // ---- dead share --------------------------------------------------------------
  const attributable = a.claims.filter((x) => x.alwaysOnTokens > 0);
  const attributedPct =
    a.medianPrefixTokens > 0 ? (a.harnessEstTokens / a.medianPrefixTokens) * 100 : 0;
  p(`  ${amber('DEAD SHARE')}  ${dim(`of the harness context we can attribute`)}`);
  p();
  const pct = a.deadSharePct;
  const col = pct > 50 ? rust : pct > 25 ? amber : green;
  p(canJudgeAbsence ? `    ${col(bar(pct / 100))}  ${bold(pct.toFixed(0) + '%')}` : `    ${grey('not evaluated')}`);
  p(`    ${grey(`of ${n(a.harnessEstTokens)} tok across ${attributable.length} claims`)}`);
  p();
  if (hasPrefix) {
    p(`    ${dim(`scope: those claims are ${attributedPct.toFixed(0)}% of your ${n(a.medianPrefixTokens)}-tok prefix.`)}`);
    p(`    ${dim(`the other ${n(a.residualTokens)} tok is unattributed and not judged here.`)}`);
  } else {
    p(`    ${dim('scope: the harness claims are estimated; their share of the prefix is unknown.')}`);
    p(`    ${dim('the unattributed remainder is unknown and is not judged here.')}`);
  }
  // A quiet corpus and a clean harness produce the same zero. Say which one this is.
  const floor = a.evidenceFloorPct;
  // The floor is computed over the weakest population any claim was judged against, so
  // printing the size of the whole scan beside it would advertise a resolution most of
  // the ledger does not have.
  const floorN = a.evidenceFloorSessions;
  if (canJudgeAbsence) {
  p(
    `    ${dim(
      floorN === a.sessionCount
        ? `resolution: ${floorN} session${floorN === 1 ? '' : 's'} read — never firing only`
        : `resolution: ${floorN} of ${a.sessionCount} sessions judge this project — never firing only`,
    )}`,
  );
  p(`    ${dim(`rules out a load rate above ${floor < 10 ? floor.toFixed(1) : floor.toFixed(0)}%.`)}`);
  if (floor > 50) {
    // A T2 run reaches its verdicts by reading the trajectory, not by counting silences,
    // so a thin corpus does not disqualify them. Say which one this sentence is about.
    p(
      `    ${amber('too thin to condemn anything at T0/T1')} ${dim(
        a.cost.tier === 'T0/T1/T2' ? '— the T2 verdicts above stand on their own.' : '— rerun with --all, or come back later.',
      )}`,
    );
  }
  } else {
    p(`    ${dim(a.sessionCount === 0 ? 'Behavioral evidence not evaluated. No sessions were supplied.' : 'Absence is not evaluated: this telemetry cannot prove a claim is unnecessary.')}`);
  }
  p();

  // ---- ledger ------------------------------------------------------------------
  const rows = a.claims
    .filter((x) => x.alwaysOnTokens > 0 || x.kind === 'mcp-server')
    .map((claim) => ({ claim, ev: a.evidence.get(claim.id)! }))
    .filter((r) => r.ev)
    .sort((x, y) => y.claim.alwaysOnTokens - x.claim.alwaysOnTokens)
    .slice(0, 12);

  if (rows.length) {
    p(`  ${amber('LEASE LEDGER')}  ${dim('top 12 by always-on footprint')}`);
    p();
    for (const { claim, ev } of rows) {
      const mark =
        ev.verdict === 'ballast' ? rust('■')
        : ev.verdict === 'load-bearing' ? green('■')
        : ev.verdict === 'protected' ? green('◆')
        : amber('■');
      const tok = claim.alwaysOnTokens > 0 ? `${n(claim.alwaysOnTokens)} tok` : dim('runtime');
      p(`    ${mark} ${claim.label.slice(0, 46).padEnd(46)} ${tok.padStart(11)}  ${dim(ev.tier.padEnd(4))} ${grey(ev.verdict)}`);
      p(`      ${dim(claim.source.file + (claim.source.startLine > 0 ? ':' + claim.source.startLine : ''))}`);
    }
    p();
    p(`    ${green('■')} ${dim('load-bearing')}   ${amber('■')} ${dim('unproven')}   ${rust('■')} ${dim('ballast')}   ${green('◆')} ${dim('protected (prevention)')}`);
    p();
  }

  // ---- proposals ---------------------------------------------------------------
  const top = a.proposals;
  if (top.length) {
    p(`  ${amber('PROPOSALS')}  ${dim('nothing is applied automatically')}`);
    p();
    for (const pr of top) {
      const verb = pr.action === 'demote' ? 'demote to on-demand' : pr.action === 'evict' ? 'remove' : 'investigate';
      p(`    ${bold(pr.label.slice(0, 56))}`);
      const saving = !hasEconomics
        ? amber('  saving unknown')
        : pr.savingPerSession > 0
          ? green(`  saves ~${n(pr.savingPerSession)} eff tok/session`)
          : '';
      p(`      ${green('→')} ${verb}${saving}`);
      const bound = pr.receipt.boundPct;
      p(
        `      ${dim(
            `receipt: ${pr.receipt.tier} · ${pr.receipt.firedIn}/${pr.receipt.sessions} sessions · class ${pr.receipt.class} · ` +
            `confidence ${pr.receipt.confidence}` +
            (pr.receipt.confidenceSource === 't2-judge' ? ` · T2 judge` : ``) +
            (pr.receipt.confidenceSource === 'zero-hit-bound' && pr.receipt.sessions > 0 && pr.receipt.firedIn === 0 && bound > 0
              ? ` · loads <${bound < 10 ? bound.toFixed(1) : bound.toFixed(0)}% of the time (95%)`
              : ``),
        )}`,
      );
      p();
    }
  } else {
    p(`  ${amber('PROPOSALS')}`);
    p();
    p(`    ${grey('none')} ${dim(a.sessionCount === 0 ? '— behavioral evidence not evaluated.' : '— no supported changes from the available evidence.')}`);
    p();
  }

  // ---- balance -----------------------------------------------------------------
  const saved = a.proposals.reduce((s, x) => s + x.savingPerSession, 0);
  p(`  ${amber('BALANCE')}  ${dim(`tiers reached: ${a.cost.tier}`)}`);
  p();
  if (a.cost.attempts > 0) {
    const tokenTotal = a.cost.tokens === null ? amber('unknown tokens') : amber(n(a.cost.tokens) + ' tokens');
    const dollarTotal = a.cost.usd === null ? 'cost unknown' : `$${a.cost.usd.toFixed(3)}`;
    p(
      `    analysis cost         ${tokenTotal} ${dim(`· ${dollarTotal} · ${a.cost.attempts} attempt${a.cost.attempts === 1 ? '' : 's'} · ${a.cost.calls} successful response${a.cost.calls === 1 ? '' : 's'} · ${a.cost.model ?? 'local agent'}`)}`,
    );
    p(`    ${dim(`model calls ${a.cost.modelCalls === null ? 'unknown' : n(a.cost.modelCalls)} · network calls unknown`)}`);
    if (a.cost.tokens === null && a.cost.tokenResponses > 0) {
      p(`    ${dim(`measured subtotal ${n(a.cost.measuredTokens)} tokens (${a.cost.tokenResponses}/${a.cost.calls} responses)`)}`);
    }
    if (a.cost.usd === null && a.cost.costResponses > 0) {
      p(`    ${dim(`measured subtotal $${a.cost.measuredCostUsd.toFixed(3)} (${a.cost.costResponses}/${a.cost.calls} responses)`)}`);
    }
    p(`    ${dim(`judged ${a.cost.judged ?? 0} claims your own quota paid for`)}`);
  } else {
    p(`    analysis cost         ${green('0 tokens')} ${dim('(no model call, no network)')}`);
  }
  p(`    proposals would save  ${!hasEconomics ? amber('saving unknown') : saved > 0 ? green(`~${n(saved)} eff tok/session`) : dim('—')}`);
  if (hasEconomics && a.cost.tokens !== null && a.cost.tokens > 0 && saved > 0) {
    const payback = a.cost.tokens / saved;
    p(
      `    ${dim(`pays for itself after ${payback < 1 ? 'the first session' : `~${Math.ceil(payback)} sessions`}`)}`,
    );
  }
  p();

  return L.join('\n');
}
