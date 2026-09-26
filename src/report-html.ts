/** Self-contained HTML report. No network, no external assets, no fonts to fetch. */

import type { Analysis, Claim, ClaimEvidence } from './types.ts';
import type { compareBaselines } from './baseline.ts';
import type { Budget } from './budget.ts';
import { naiveRatio } from './pricing.ts';
import { VERSION } from './version.ts';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const n = (x: number) => Math.round(x).toLocaleString('en-US');
const delta = (x: number) => (x > 0 ? '+' : '') + n(x);
const percent = (x: number) => (x > 0 ? '+' : '') + x.toLocaleString('en-US', { maximumSignificantDigits: 4 });

export type ReportContext = {
  comparison?: ReturnType<typeof compareBaselines>;
  budget?: Budget;
  /** Only for a generated fixture report, never inferred from user data. */
  synthetic?: boolean;
};

const VERDICT_COLOR: Record<string, string> = {
  'load-bearing': 'var(--green)',
  unproven: 'var(--amber)',
  ballast: 'var(--rust)',
  protected: 'var(--blue)',
};

function flamegraph(a: Analysis): string {
  const total = Math.max(1, a.medianPrefixTokens);
  const segments: { label: string; tokens: number; color: string; note: string }[] = [];

  const byKind = new Map<string, number>();
  for (const c of a.claims) {
    if (c.alwaysOnTokens <= 0) continue;
    byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + c.alwaysOnTokens);
  }
  const labels: Record<string, string> = {
    'prose-section': a.provider === 'codex' ? 'AGENTS.md instructions' : a.claims.some((claim) => claim.provider === 'codex') ? 'instruction files' : 'CLAUDE.md instructions',
    skill: 'skill descriptions',
    subagent: 'subagent descriptions',
    hook: 'hooks',
    'output-style': 'output style',
  };
  const palette = ['var(--amber)', 'var(--green)', 'var(--blue)', 'var(--violet)'];
  let i = 0;
  for (const [kind, tok] of [...byKind].sort((x, y) => y[1] - x[1])) {
    segments.push({
      label: labels[kind] ?? kind,
      tokens: tok,
      color: palette[i++ % palette.length],
      note: 'estimated',
    });
  }
  segments.push({
    label: 'unattributed remainder',
    tokens: a.residualTokens,
    color: 'var(--rust)',
    note: 'composition unknown',
  });

  const bars = segments
    .map((s) => {
      const pct = (s.tokens / total) * 100;
      if (pct < 0.15) return '';
      return `<div class="seg" style="width:${pct.toFixed(3)}%;background:${s.color}" title="${esc(s.label)} — ${n(s.tokens)} tok (${pct.toFixed(1)}%)"></div>`;
    })
    .join('');

  const legend = segments
    .map(
      (s) => `<div class="lg">
        <span class="sw" style="background:${s.color}"></span>
        <span class="lgl">${esc(s.label)}</span>
        <span class="lgv">${n(s.tokens)} tok</span>
        <span class="lgp">${((s.tokens / total) * 100).toFixed(1)}%</span>
        <span class="lgn">${esc(s.note)}</span>
      </div>`,
    )
    .join('');

  return `<div class="flame">${bars}</div><div class="legend">${legend}</div>`;
}

function ledger(a: Analysis): string {
  const rows = a.claims
    .map((claim) => ({ claim, ev: a.evidence.get(claim.id) ?? {
      claimId: claim.id, tier: 'none', verdict: claim.protected ? 'protected' : 'unproven',
      firedIn: 0, observedIn: 0, note: 'Behavioral evidence not evaluated.',
    } as ClaimEvidence }))
    .sort((x, y) => y.claim.alwaysOnTokens - x.claim.alwaysOnTokens);

  if (!rows.length) return '<p class="muted">No harness claims discovered in this project.</p>';
  const kinds = [...new Set(rows.map(({ claim }) => claim.kind))].sort();
  return `<div id="ledger-controls" class="controls" hidden>
    <div class="control"><label for="claim-search">Search label or source</label><input id="claim-search" type="search" placeholder="Find a claim or file" autocomplete="off"></div>
    <div class="control"><label for="claim-verdict">Verdict</label><select id="claim-verdict"><option value="">All verdicts</option><option value="load-bearing">Load-bearing</option><option value="unproven">Unproven</option><option value="ballast">Ballast</option><option value="protected">Protected</option></select></div>
    <div class="control"><label for="claim-kind">Kind</label><select id="claim-kind"><option value="">All kinds</option>${kinds.map((kind) => `<option value="${esc(kind)}">${esc(kind)}</option>`).join('')}</select></div>
    <div class="control"><label for="claim-sort">Sort</label><select id="claim-sort"><option value="tokens-desc">Resident tokens: highest first</option><option value="tokens-asc">Resident tokens: lowest first</option><option value="name">Name: A to Z</option></select></div>
    <button type="button" id="claim-reset">Reset</button>
  </div>
  <p id="claim-count" role="status" aria-live="polite">${rows.length} of ${rows.length} claims shown</p>
  <noscript><p class="muted">All claims are shown. Search, filters and sorting require JavaScript.</p></noscript>
  <p id="claim-empty" class="note" hidden>No claims match these filters. Clear the search or reset the filters.</p>
  <div class="scroll"><table>
    <caption class="sr-only">Harness claims, estimated resident tokens and behavioral evidence</caption>
    <thead><tr>
      <th scope="col">claim / source</th><th scope="col" class="r">resident estimate</th><th scope="col">class</th><th scope="col">tier</th><th scope="col">verdict</th><th scope="col">evidence</th>
    </tr></thead>
    <tbody id="claim-rows">${rows
      .map(
        ({ claim, ev }) => `<tr data-search="${esc((claim.label + ' ' + claim.source.file).toLowerCase())}" data-name="${esc(claim.label)}" data-kind="${esc(claim.kind)}" data-verdict="${esc(ev.verdict)}" data-tokens="${Number.isFinite(claim.alwaysOnTokens) ? claim.alwaysOnTokens : 0}">
        <td><code>${esc(claim.label)}</code><div class="source">${esc(sourceLocation(claim))}</div><div class="source">${esc(claim.kind)} · ${esc(claim.scope)} · ${esc(claim.loading)}</div></td>
        <td class="r">${claim.kind === 'mcp-server' ? '<span class="muted">runtime</span>' : n(claim.alwaysOnTokens) + ' tok'}</td>
        <td>${esc(claim.class)}${claim.classInferred ? '<span class="inf" title="inferred, not declared">?</span>' : ''}</td>
        <td><span class="tier">${esc(ev.tier)}</span></td>
        <td><span class="verdict" style="color:${VERDICT_COLOR[ev.verdict] ?? 'inherit'}">${esc(ev.verdict)}</span></td>
        <td class="muted">${esc(ev.note)}</td>
      </tr>`,
      )
      .join('')}</tbody></table></div>`;
}

function sourceLocation(claim: Claim): string {
  return claim.source.file + (claim.source.startLine > 0 ? `:${claim.source.startLine}${claim.source.endLine > claim.source.startLine ? '–' + claim.source.endLine : ''}` : ' (runtime declaration)');
}

// Fixed application code only. Labels, paths and evidence are escaped HTML, never
// executable interpolation. Filtering reuses server-rendered nodes, including offline.
const LEDGER_SCRIPT = `(() => {
  const body = document.getElementById('claim-rows');
  if (!body) return;
  const rows = Array.from(body.children);
  const search = document.getElementById('claim-search');
  const verdict = document.getElementById('claim-verdict');
  const kind = document.getElementById('claim-kind');
  const sort = document.getElementById('claim-sort');
  const update = () => {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    const ordered = rows.slice().sort((left, right) => sort.value === 'name'
      ? left.dataset.name.localeCompare(right.dataset.name)
      : (Number(left.dataset.tokens) - Number(right.dataset.tokens)) * (sort.value === 'tokens-asc' ? 1 : -1));
    for (const row of ordered) {
      row.hidden = !row.dataset.search.includes(query) || Boolean(verdict.value && row.dataset.verdict !== verdict.value) || Boolean(kind.value && row.dataset.kind !== kind.value);
      if (!row.hidden) shown++;
      body.appendChild(row);
    }
    document.getElementById('claim-count').textContent = shown + ' of ' + rows.length + ' claims shown';
    document.getElementById('claim-empty').hidden = shown !== 0;
  };
  search.addEventListener('input', update);
  for (const control of [verdict, kind, sort]) control.addEventListener('change', update);
  document.getElementById('claim-reset').addEventListener('click', () => {
    search.value = ''; verdict.value = ''; kind.value = ''; sort.value = 'tokens-desc'; update(); search.focus();
  });
  document.getElementById('ledger-controls').hidden = false;
})();`;

function proposals(a: Analysis, hasEconomics: boolean): string {
  if (!a.proposals.length)
    return a.sessionCount === 0
      ? '<p class="muted">Behavioral evidence not evaluated. No behavioral changes are proposed from this inventory.</p>'
      : '<p class="muted">No supported changes to propose from the available evidence.</p>';
  return a.proposals
    .map(
      (p) => `<div class="prop">
        <div class="ph"><code>${esc(p.label)}</code>
          <span class="act">${p.action === 'demote' ? 'demote to on-demand' : p.action === 'evict' ? 'remove' : 'investigate'}</span>
        </div>
        ${!hasEconomics
          ? '<div class="save muted">saving unknown — compatible cache economics unavailable</div>'
          : p.savingPerSession > 0
            ? `<div class="save">saves ~${n(p.savingPerSession)} effective tokens / session</div>`
            : '<div class="save muted">schema size is runtime-only — counted in the residual</div>'}
        <div class="receipt">receipt · tier ${esc(p.receipt.tier)} · fired ${p.receipt.firedIn}/${p.receipt.sessions} sessions · class ${esc(p.receipt.class)} · confidence ${esc(p.receipt.confidence)}${p.receipt.confidenceSource === 't2-judge' ? ' · T2 judge' : ''}${p.receipt.confidenceSource === 'zero-hit-bound' && p.receipt.sessions > 0 && p.receipt.firedIn === 0 && p.receipt.boundPct > 0 ? ` · loads &lt;${p.receipt.boundPct < 10 ? p.receipt.boundPct.toFixed(1) : p.receipt.boundPct.toFixed(0)}% of the time (95%)` : ''}${p.receipt.protected ? ' · prevention protected' : ''}</div>
      </div>`,
    )
    .join('');
}

function comparisonReport(context: ReportContext): string {
  const comparison = context.comparison;
  const checks = context.budget?.checks ?? [];
  if (!comparison && !checks.length) return '';
  const changes = comparison ? [
    ...comparison.added.map((claim) => ({ state: 'added', claim, before: 0, after: claim.tokens })),
    ...comparison.removed.map((claim) => ({ state: 'removed', claim, before: claim.tokens, after: 0 })),
    ...comparison.changed.map((change) => ({ state: 'changed', claim: change.after, before: change.before.tokens, after: change.after.tokens })),
  ] : [];
  return `<h2>BASELINE &amp; BUDGET</h2>
  ${comparison ? `<div class="grid">
    <div class="card"><div class="k">baseline estimate</div><div class="v">${n(comparison.beforeTokens)} <small>tok</small></div></div>
    <div class="card"><div class="k">current estimate</div><div class="v">${n(comparison.currentTokens)} <small>tok</small></div></div>
    <div class="card"><div class="k">change</div><div class="v">${delta(comparison.deltaTokens)} <small>tok · ${comparison.growthPercent === null ? 'unbounded from zero' : percent(comparison.growthPercent) + '%'}</small></div></div>
  </div><p class="muted">${comparison.added.length} added · ${comparison.removed.length} removed · ${comparison.changed.length} changed. Differences compare estimated resident file tokens, not billed savings.</p>` : ''}
  ${checks.length ? `<div class="note"><strong>Budget ${context.budget!.passed ? 'PASS' : 'FAIL'}</strong><ul>${checks.map((check) => `<li>${esc(check.metric)}: ${check.actual === null ? 'unbounded from zero' : check.actual} / limit ${check.limit} — ${check.passed ? 'PASS' : 'FAIL'}${check.reason ? `. ${esc(check.reason)}` : ''}</li>`).join('')}</ul></div>` : ''}
  ${changes.length ? `<div class="scroll"><table><caption class="sr-only">Every changed harness block compared with the baseline</caption><thead><tr><th scope="col">change</th><th scope="col">block / source</th><th scope="col" class="r">before</th><th scope="col" class="r">current</th><th scope="col" class="r">delta</th></tr></thead><tbody>${changes.map((change) => `<tr><td>${change.state}</td><td><code>${esc(change.claim.section)}</code><div class="source">${esc(change.claim.path)} · ${esc(change.claim.kind)}</div></td><td class="r">${n(change.before)}</td><td class="r">${n(change.after)}</td><td class="r">${delta(change.after - change.before)} tok</td></tr>`).join('')}</tbody></table></div>` : comparison ? '<p class="muted">No blocks changed from the baseline.</p>' : ''}`;
}

export function renderHtml(a: Analysis, context: ReportContext = {}): string {
  const coverage = a.telemetryCoverage;
  const hasBilling = coverage.knownTurns > 0;
  const hasSpend = hasBilling && a.spendKnown !== false && a.provider !== 'codex';
  const hasEconomics = a.cacheEconomicsKnown !== false && a.provider !== 'codex' && coverage.cacheSessions > 0;
  // Complete aggregate usage can coexist with a missing first-turn measurement.
  const hasPrefix = coverage.prefixSessions > 0;
  const hasBehavioralEvidence = a.sessionCount > 0 && a.evidenceFloorSessions > 0;
  const canJudgeAbsence = hasBehavioralEvidence && a.absenceEvidenceKnown !== false && a.provider !== 'codex';
  const providerName = a.provider === 'codex' ? 'Codex' : !a.provider && a.claims.some((claim) => claim.provider === 'codex') ? 'Multiple providers' : 'Claude Code';
  const ratio = hasPrefix && hasEconomics
    ? naiveRatio(a.medianTurnsPerSession, a.cacheTtl, a.medianPrefixWrites)
    : undefined;
  const saved = a.proposals.reduce((s, x) => s + x.savingPerSession, 0);
  const b = a.billedTokens;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>harnessmeter · ${providerName} report</title>
<style>
:root{--bg:#0B0E14;--panel:#11151D;--line:#1C232E;--fg:#E6EDF3;--mut:#8B949E;--dim:#8994A3;
--amber:#B8873B;--green:#4E9A6B;--rust:#A8503F;--blue:#4A7FA8;--violet:#7A6BA8}
@media(prefers-color-scheme:light){:root{--bg:#FBFAF7;--panel:#fff;--line:#E4E0D8;--fg:#1A1D22;--mut:#5C6470;--dim:#667080}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:40px 24px}
main{max-width:1080px;margin:0 auto}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.5px}
h1 span{color:var(--amber)}
h2{font-size:12px;letter-spacing:1.6px;color:var(--amber);margin:44px 0 14px;font-weight:600}
.sub{color:var(--mut);margin:0 0 32px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px}
.k{color:var(--dim);font-size:11px;letter-spacing:1px;text-transform:uppercase}
.v{font-size:24px;margin-top:6px}
.v small{font-size:12px;color:var(--mut)}
.flame{display:flex;height:34px;border-radius:5px;overflow:hidden;border:1px solid var(--line);background:var(--panel)}
.seg{height:100%}
.legend{margin-top:14px;display:grid;gap:6px}
.lg{display:grid;grid-template-columns:14px 1fr auto auto auto;gap:12px;align-items:center;font-size:13px}
.sw{width:11px;height:11px;border-radius:2px}
.lgv{color:var(--mut)}.lgp{color:var(--fg);min-width:52px;text-align:right}
.lgn{color:var(--dim);font-size:11px;min-width:230px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:end}
.controls .control{display:grid;gap:4px;flex:1;min-width:150px}
.controls label{color:var(--mut);font-size:12px}
.controls input,.controls select,.controls button{font:inherit;color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:5px;padding:9px;min-height:42px;max-width:100%}
.controls button{cursor:pointer}
:focus-visible{outline:2px solid var(--amber);outline-offset:3px}
.source{color:var(--mut);font-size:11px;overflow-wrap:anywhere;margin-top:4px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:640px){body{padding:24px 16px}.lg{grid-template-columns:14px 1fr auto}.lgp,.lgn{grid-column:2 / -1;min-width:0;text-align:left}.bal div{gap:12px;flex-wrap:wrap}}
table{width:100%;min-width:640px;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim);font-weight:500;font-size:11px;letter-spacing:1px;
text-transform:uppercase;padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
td.r,th.r{text-align:right}
code{color:var(--fg)}
.muted,.lgn{color:var(--dim)}
.tier{background:var(--line);padding:1px 6px;border-radius:3px;font-size:11px;color:var(--mut)}
.inf{color:var(--amber);margin-left:3px;cursor:help}
.prop{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--green);
border-radius:6px;padding:14px 16px;margin-bottom:10px}
.ph{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:baseline}
.act{color:var(--green);font-size:12px}
.save{margin-top:6px;color:var(--green);font-size:13px}
.receipt{margin-top:6px;color:var(--dim);font-size:11px}
.ok{color:var(--green)}
.bal{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:18px 20px}
.bal div{display:flex;justify-content:space-between;padding:4px 0}
footer{margin-top:56px;color:var(--dim);font-size:11px;border-top:1px solid var(--line);padding-top:18px}
.note{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--amber);
border-radius:6px;padding:12px 16px;color:var(--mut);font-size:12.5px;margin:14px 0}
</style></head><body><main>

<h1>harness<span>meter</span></h1>
${context.synthetic ? '<div class="note" role="note"><strong>Synthetic demo</strong> — every project, claim, session and measurement below is fictional test data.</div>' : ''}
<p class="sub">${providerName} · ${a.sessionCount === 0 ? 'Static inventory · ' : ''}${n(a.sessionCount)} sessions · ${n(a.turnCount)} turns · ${a.projects.length} project${a.projects.length === 1 ? '' : 's'} · ${esc(a.scannedAt.slice(0, 16).replace('T', ' '))}</p>
${comparisonReport(context)}

<h2>BILLED — ${coverage.status === 'full' ? 'MEASURED TOKENS' : coverage.status === 'partial' ? 'MEASURED SUBTOTAL' : 'UNKNOWN'}</h2>
<div class="grid">
  <div class="card"><div class="k">api-equivalent</div><div class="v">${hasSpend ? `$${a.spendUsd.toFixed(2)}<small> list price${coverage.status === 'partial' ? ' · measured subtotal' : ''}</small>` : 'unknown'}</div></div>
  <div class="card"><div class="k">input (uncached)</div><div class="v">${hasBilling ? n(b.input) : 'unknown'}</div></div>
  <div class="card"><div class="k">cache reads ${hasEconomics ? '<small>0.1×</small>' : ''}</div><div class="v">${hasBilling ? n(b.cacheRead) : 'unknown'}</div></div>
  <div class="card"><div class="k">cache writes ${hasEconomics ? '<small>1.25× / 2×</small>' : ''}</div><div class="v">${hasBilling && hasEconomics ? n(b.cacheWrite5m + b.cacheWrite1h) : 'unknown'}</div></div>
  <div class="card"><div class="k">output</div><div class="v">${hasBilling ? n(b.output) : 'unknown'}</div></div>
</div>
<div class="note">${coverage.status === 'full'
    ? hasEconomics ? 'Read from your transcripts, including the 5-minute / 1-hour cache-write split, so each write is priced at its own multiplier.' : 'Compatible token counts are read from your transcripts. Cache-write and pricing semantics are unavailable for this provider.'
    : coverage.status === 'partial'
      ? `Measured subtotal from <strong>${coverage.knownTurns}/${coverage.totalTurns} turns</strong> with compatible usage telemetry.`
      : `Usage is unknown: <strong>${coverage.knownTurns}/${coverage.totalTurns} turns</strong> have compatible usage telemetry.`}
${hasSpend ? 'The dollar figure is the <strong>list-price value of these measured tokens</strong>, not a bill — on a subscription plan you did not pay it.' : 'Dollar value is <strong>unknown</strong>. No token or dollar zero is inferred from missing fields.'}${
    hasSpend && a.unknownModels.length
      ? ` <strong style="color:var(--amber)">Partly estimated:</strong> ${a.unknownModels.length} model${a.unknownModels.length === 1 ? '' : 's'} in these transcripts have no known rate and were priced at a fallback (${esc(a.unknownModels.slice(0, 4).join(', '))}). Treat the total as an estimate, not a reading.`
      : ''
  }</div>

<h2>CONTEXT — WHERE THE ALWAYS-ON PREFIX GOES</h2>
${hasPrefix ? flamegraph(a) : '<div class="card"><div class="k">first-turn prompt / cache behavior</div><div class="v">unknown</div></div>'}
<div class="note">${hasPrefix && ratio !== undefined
    ? `Median first-turn prompt is <strong>${n(a.medianPrefixTokens)} tokens</strong> — an <strong>upper bound</strong> on the resident prefix, because it also contains the opening user message. At ${a.medianTurnsPerSession} turns per session, prompt caching makes that prefix <strong>${ratio >= 1 ? ratio.toFixed(1) + '× cheaper' : (1 / ratio).toFixed(1) + '× more expensive'}</strong> than tokens × turns would suggest. This corpus writes the prefix <strong>${a.medianPrefixWrites}×</strong> per session at the <strong>${a.cacheTtl}</strong> rate. That count is measured per session, not assumed. The <strong>unattributed remainder</strong> cannot be tied to a harness file; its composition is unknown.${coverage.status === 'partial' ? ` Prefix/cache medians use ${coverage.cacheSessions}/${a.sessionCount} complete sessions.` : ''}`
    : hasPrefix
      ? `Median first-turn prompt is <strong>${n(a.medianPrefixTokens)} tokens</strong> — an <strong>upper bound</strong> that includes the opening user message. The <strong>unattributed remainder</strong> has unknown composition. Cache economics and proposal savings are <strong>unknown</strong>; no pricing assumptions from another provider are applied.`
      : 'First-turn prompt and unattributed remainder are <strong>unknown</strong>: no session has complete compatible usage telemetry. Harness-file sizes remain estimates. Cache economics are unavailable.'}</div>

<h2>DEAD SHARE</h2>
<div class="card"><div class="k">of attributed harness context, with no observable consequence</div>
<div class="v" style="color:${!canJudgeAbsence ? 'var(--mut)' : a.deadSharePct > 50 ? 'var(--rust)' : a.deadSharePct > 25 ? 'var(--amber)' : 'var(--green)'}">${canJudgeAbsence ? `${a.deadSharePct.toFixed(0)}%<small> of ${n(a.harnessEstTokens)} tok</small>` : 'not evaluated'}</div></div>
<div class="note">${!canJudgeAbsence
    ? `Inventory footprint: <strong>${n(a.harnessEstTokens)} estimated resident tokens</strong>. An unevaluated dead share is not a zero or a clean bill of health.`
    : hasPrefix
    ? `This percentage is scoped to the context we can attribute to a file — ${n(a.harnessEstTokens)} tokens, or ${a.medianPrefixTokens > 0 ? ((a.harnessEstTokens / a.medianPrefixTokens) * 100).toFixed(0) : '0'}% of your ${n(a.medianPrefixTokens)}-token prefix. The remaining ${n(a.residualTokens)} tokens are unattributed — harnessmeter cannot tie them to a file or see inside them, so they are <strong>not</strong> counted as either live or dead. Reporting one number as if it covered the whole prefix would be the exact error this tool exists to correct.`
    : `This percentage is scoped only to the estimated ${n(a.harnessEstTokens)} tokens attributable to harness files. Their share of the prefix and the unattributed remainder are <strong>unknown</strong>.`}</div>
<div class="note">${!canJudgeAbsence
    ? a.sessionCount === 0 ? '<strong>Behavioral evidence not evaluated.</strong> This inventory measures file sizes, not whether instructions are useful. No sessions were supplied.' : '<strong>Absence is not evaluated.</strong> Available observations cannot establish that an unused claim is unnecessary. Positive evidence and prevention protection remain visible in the ledger.'
    : `<strong>Resolution.</strong> ${a.evidenceFloorSessions} of the ${n(a.sessionCount)} sessions read can testify about this project's claims. A claim that never fired can only be shown to load less than <strong>${a.evidenceFloorPct < 10 ? a.evidenceFloorPct.toFixed(1) : a.evidenceFloorPct.toFixed(0)}%</strong> of the time, at 95% confidence. ${a.evidenceFloorPct > 50 ? 'That is too thin to condemn anything at T0/T1. Rerun with <code>--all</code>, or come back after more sessions.' : 'The bound describes this observed corpus, not a guarantee about future tasks.'}`}</div>

<h2>LEASE LEDGER</h2>
${ledger(a)}

<h2>PROPOSALS</h2>
${proposals(a, hasEconomics)}
<div class="note">Nothing here is applied automatically. Prevention-class claims are excluded from eviction entirely: a prevention rule looks useless precisely because it works, so observational evidence can never condemn it.</div>

<h2>BALANCE</h2>
<div class="bal">
  <div><span>tiers reached</span><strong>${a.cost.tier}</strong></div>
  <div><span>analysis cost</span><strong style="color:${a.cost.attempts > 0 ? 'var(--amber)' : 'var(--green)'}">${a.cost.attempts === 0 ? '0 tokens <small>(no model call, no network)</small>' : `${a.cost.tokens === null ? 'unknown tokens' : n(a.cost.tokens) + ' tokens'} · ${a.cost.usd === null ? 'cost unknown' : '$' + a.cost.usd.toFixed(3)}`}</strong></div>
  ${a.cost.attempts > 0 ? `<div><span>agent attempts</span><strong>${a.cost.attempts} attempt${a.cost.attempts === 1 ? '' : 's'} · ${a.cost.calls} successful response${a.cost.calls === 1 ? '' : 's'}<small style="color:var(--dim)"> · model calls ${a.cost.modelCalls === null ? 'unknown' : n(a.cost.modelCalls)} · network calls unknown</small></strong></div>` : '<div><span>network calls</span><strong style="color:var(--green)">0</strong></div>'}
  ${a.cost.attempts > 0 && a.cost.tokens === null && a.cost.tokenResponses > 0 ? `<div><span>measured subtotal</span><strong>${n(a.cost.measuredTokens)} tokens <small style="color:var(--dim)">(${a.cost.tokenResponses}/${a.cost.calls} responses)</small></strong></div>` : ''}
  ${a.cost.attempts > 0 && a.cost.usd === null && a.cost.costResponses > 0 ? `<div><span>measured subtotal</span><strong>$${a.cost.measuredCostUsd.toFixed(3)} <small style="color:var(--dim)">(${a.cost.costResponses}/${a.cost.calls} responses)</small></strong></div>` : ''}
  ${a.cost.attempts > 0 ? `<div><span>claims judged at T2</span><strong>${a.cost.judged ?? 0} <small style="color:var(--dim)">via ${esc(a.cost.model ?? '')}, your own quota</small></strong></div>` : ''}
  <div><span>proposals would save</span><strong style="color:${!hasEconomics ? 'var(--amber)' : 'var(--green)'}">${!hasEconomics ? 'saving unknown' : saved > 0 ? '~' + n(saved) + ' eff tok / session' : '—'}</strong></div>
  ${hasEconomics && a.cost.tokens !== null && a.cost.tokens > 0 && saved > 0 ? `<div><span>payback</span><strong style="color:var(--green)">${a.cost.tokens / saved < 1 ? 'first session' : '~' + Math.ceil(a.cost.tokens / saved) + ' sessions'}</strong></div>` : ''}
</div>

<footer>
harnessmeter ${VERSION} · evidence tiers reached in this run: ${a.cost.tier === 'T0/T1/T2' ? 'T0 (presence), T1 (consequence), T2 (judgement)' : 'T0 (presence), T1 (consequence) — run with <code>--t2</code> to escalate unproven claims'}.
T3 natural experiments and T4 field randomisation are not in this release.<br>
${coverage.status === 'full' ? 'Compatible session token counts are measured.' : coverage.status === 'partial' ? `Session token counts are a measured subtotal covering ${coverage.knownTurns}/${coverage.totalTurns} turns.` : 'Session-level token figures are unknown.'} Dollar values use list-price estimates when available; unavailable pricing or cache semantics remain unknown. Per-claim token counts are calibrated estimates at
~3.8 chars/token and are labelled as such wherever shown.
</footer>
</main><script id="ledger-script">${LEDGER_SCRIPT}</script></body></html>`;
}
