/** Terminal report. The thing people screenshot. */

import type { Analysis } from './types.ts';
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

export function renderTerminal(a: Analysis): string {
  const L: string[] = [];
  const p = (s = '') => L.push(s);

  p();
  p(`  ${bold('harnessmeter')} ${dim(VERSION)}`);
  p(
    `  ${grey(`${n(a.sessionCount)} sessions · ${n(a.turnCount)} turns · ${a.projects.length} project${a.projects.length === 1 ? '' : 's'}`)}`,
  );
  p();

  // ---- exact -------------------------------------------------------------------
  p(`  ${amber('BILLED')}  ${dim('exact, read from transcripts')}`);
  p();
  const b = a.billedTokens;
  p(`    input (uncached)      ${n(b.input).padStart(12)}`);
  p(`    cache reads  ${dim('0.1x')}     ${n(b.cacheRead).padStart(12)}`);
  p(`    cache writes ${dim('1.25x')}    ${n(b.cacheWrite5m).padStart(12)}`);
  p(`    cache writes ${dim('2x')}       ${n(b.cacheWrite1h).padStart(12)}`);
  p(`    output                ${n(b.output).padStart(12)}`);
  p(`    ${bold('api-equivalent')}        ${bold('$' + a.spendUsd.toFixed(2))}`);
  p(`    ${dim('list-price value of these tokens — not an invoice')}`);
  if (a.unknownModels.length) {
    p(
      `    ${amber('estimated')} ${dim(`— ${a.unknownModels.length} unpriced model${a.unknownModels.length === 1 ? '' : 's'} billed at a fallback rate:`)}`,
    );
    p(`    ${dim(a.unknownModels.slice(0, 3).join(', ').slice(0, 68))}`);
  }
  p();

  // ---- prefix ------------------------------------------------------------------
  const ratio = naiveRatio(a.medianTurnsPerSession);
  p(`  ${amber('ALWAYS-ON PREFIX')}  ${dim('first-turn prompt — an upper bound')}`);
  p();
  p(`    median first turn     ${n(a.medianPrefixTokens).padStart(12)} tok`);
  p(`    ${dim('includes the opening user message, which cannot be separated')}`);
  p(`    ${grey('├─ harness files')}      ${grey(n(a.harnessEstTokens).padStart(12) + ' tok  (estimated)')}`);
  p(`    ${grey('└─ base + mcp schemas')} ${grey(n(a.residualTokens).padStart(12) + ' tok  (residual)')}`);
  p();
  p(
    `    ${dim(`at ${a.medianTurnsPerSession} turns/session, prompt caching makes the prefix`)}`,
  );
  p(`    ${dim(`${ratio.toFixed(1)}x cheaper than tokens x turns would suggest.`)}`);
  p();

  // ---- dead share --------------------------------------------------------------
  const attributable = a.claims.filter((x) => x.alwaysOnTokens > 0);
  const attributedPct =
    a.medianPrefixTokens > 0 ? (a.harnessEstTokens / a.medianPrefixTokens) * 100 : 0;
  p(`  ${amber('DEAD SHARE')}  ${dim(`of the harness context we can attribute`)}`);
  p();
  const pct = a.deadSharePct;
  const col = pct > 50 ? rust : pct > 25 ? amber : green;
  p(`    ${col(bar(pct / 100))}  ${bold(pct.toFixed(0) + '%')}`);
  p(`    ${grey(`of ${n(a.harnessEstTokens)} tok across ${attributable.length} claims`)}`);
  p();
  p(
    `    ${dim(`scope: those claims are ${attributedPct.toFixed(0)}% of your ${n(a.medianPrefixTokens)}-tok prefix.`)}`,
  );
  p(`    ${dim(`the other ${n(a.residualTokens)} tok is base prompt + MCP schemas, not judged here.`)}`);
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
    }
    p();
    p(`    ${green('■')} ${dim('load-bearing')}   ${amber('■')} ${dim('unproven')}   ${rust('■')} ${dim('ballast')}   ${green('◆')} ${dim('protected (prevention)')}`);
    p();
  }

  // ---- proposals ---------------------------------------------------------------
  const top = a.proposals.slice(0, 5);
  if (top.length) {
    p(`  ${amber('PROPOSALS')}  ${dim('nothing is applied automatically')}`);
    p();
    for (const pr of top) {
      const verb = pr.action === 'demote' ? 'demote to on-demand' : pr.action === 'evict' ? 'remove' : 'investigate';
      p(`    ${bold(pr.label.slice(0, 56))}`);
      p(`      ${green('→')} ${verb}${pr.savingPerSession > 0 ? green(`  saves ~${n(pr.savingPerSession)} eff tok/session`) : ''}`);
      p(
        `      ${dim(`receipt: ${pr.receipt.tier} · ${pr.receipt.firedIn}/${pr.receipt.sessions} sessions · class ${pr.receipt.class} · confidence ${pr.receipt.confidence}`)}`,
      );
      p();
    }
  } else {
    p(`  ${amber('PROPOSALS')}`);
    p();
    p(`    ${green('none')} ${dim('— no always-on claim was found dead at T0/T1.')}`);
    p();
  }

  // ---- balance -----------------------------------------------------------------
  const saved = a.proposals.reduce((s, x) => s + x.savingPerSession, 0);
  p(`  ${amber('BALANCE')}  ${dim(`tiers reached: ${a.cost.tier}`)}`);
  p();
  if (a.cost.tokens > 0) {
    p(
      `    analysis cost         ${amber(n(a.cost.tokens) + ' tokens')} ${dim(`· $${a.cost.usd.toFixed(3)} · ${a.cost.calls} call${a.cost.calls === 1 ? '' : 's'} · ${a.cost.model}`)}`,
    );
    p(`    ${dim(`judged ${a.cost.judged ?? 0} claims your own quota paid for`)}`);
  } else {
    p(`    analysis cost         ${green('0 tokens')} ${dim('(no model call, no network)')}`);
  }
  p(
    `    proposals would save  ${saved > 0 ? green(`~${n(saved)} eff tok/session`) : dim('—')}`,
  );
  if (a.cost.tokens > 0 && saved > 0) {
    const payback = a.cost.tokens / saved;
    p(
      `    ${dim(`pays for itself after ${payback < 1 ? 'the first session' : `~${Math.ceil(payback)} sessions`}`)}`,
    );
  }
  p();

  return L.join('\n');
}
