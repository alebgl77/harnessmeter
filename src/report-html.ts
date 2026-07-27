/** Self-contained HTML report. No network, no external assets, no fonts to fetch. */

import type { Analysis, Claim, ClaimEvidence } from './types.ts';
import { naiveRatio } from './pricing.ts';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (x: number) => Math.round(x).toLocaleString('en-US');

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
    'prose-section': 'CLAUDE.md',
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
    label: 'base system prompt + MCP tool schemas',
    tokens: a.residualTokens,
    color: 'var(--rust)',
    note: 'residual — measured minus attributed',
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
    .map((claim) => ({ claim, ev: a.evidence.get(claim.id) }))
    .filter((r): r is { claim: Claim; ev: ClaimEvidence } => Boolean(r.ev))
    .filter((r) => r.claim.alwaysOnTokens > 0 || r.claim.kind === 'mcp-server')
    .sort((x, y) => y.claim.alwaysOnTokens - x.claim.alwaysOnTokens);

  if (!rows.length) return '<p class="muted">No harness claims discovered in this project.</p>';

  return `<div class="scroll"><table>
    <thead><tr>
      <th>claim</th><th class="r">always-on</th><th>class</th><th>tier</th><th>verdict</th><th>evidence</th>
    </tr></thead>
    <tbody>${rows
      .map(
        ({ claim, ev }) => `<tr>
        <td><code>${esc(claim.label)}</code></td>
        <td class="r">${claim.alwaysOnTokens > 0 ? n(claim.alwaysOnTokens) + ' tok' : '<span class="muted">runtime</span>'}</td>
        <td>${esc(claim.class)}${claim.classInferred ? '<span class="inf" title="inferred, not declared">?</span>' : ''}</td>
        <td><span class="tier">${ev.tier}</span></td>
        <td><span class="verdict" style="color:${VERDICT_COLOR[ev.verdict] ?? 'inherit'}">${ev.verdict}</span></td>
        <td class="muted">${esc(ev.note)}</td>
      </tr>`,
      )
      .join('')}</tbody></table></div>`;
}

function proposals(a: Analysis): string {
  if (!a.proposals.length)
    return '<p class="ok">No always-on claim was found dead at T0/T1. Nothing to propose.</p>';
  return a.proposals
    .slice(0, 12)
    .map(
      (p) => `<div class="prop">
        <div class="ph"><code>${esc(p.label)}</code>
          <span class="act">${p.action === 'demote' ? 'demote to on-demand' : p.action === 'evict' ? 'remove' : 'investigate'}</span>
        </div>
        ${p.savingPerSession > 0 ? `<div class="save">saves ~${n(p.savingPerSession)} effective tokens / session</div>` : '<div class="save muted">schema size is runtime-only — counted in the residual</div>'}
        <div class="receipt">receipt · tier ${p.receipt.tier} · fired ${p.receipt.firedIn}/${p.receipt.sessions} sessions · class ${p.receipt.class} · confidence ${p.receipt.confidence}</div>
      </div>`,
    )
    .join('');
}

export function renderHtml(a: Analysis): string {
  const ratio = naiveRatio(a.medianTurnsPerSession);
  const saved = a.proposals.reduce((s, x) => s + x.savingPerSession, 0);
  const b = a.billedTokens;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>harnessmeter report</title>
<style>
:root{--bg:#0B0E14;--panel:#11151D;--line:#1C232E;--fg:#E6EDF3;--mut:#8B949E;--dim:#5A636E;
--amber:#B8873B;--green:#4E9A6B;--rust:#A8503F;--blue:#4A7FA8;--violet:#7A6BA8}
@media(prefers-color-scheme:light){:root{--bg:#FBFAF7;--panel:#fff;--line:#E4E0D8;--fg:#1A1D22;--mut:#5C6470;--dim:#8A929C}}
*{box-sizing:border-box}
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
<p class="sub">${n(a.sessionCount)} sessions · ${n(a.turnCount)} turns · ${a.projects.length} project${a.projects.length === 1 ? '' : 's'} · ${esc(a.scannedAt.slice(0, 16).replace('T', ' '))}</p>

<h2>BILLED — EXACT</h2>
<div class="grid">
  <div class="card"><div class="k">api-equivalent</div><div class="v">$${a.spendUsd.toFixed(2)}<small> list price</small></div></div>
  <div class="card"><div class="k">cache reads <small>0.1×</small></div><div class="v">${n(b.cacheRead)}</div></div>
  <div class="card"><div class="k">cache writes <small>1.25× / 2×</small></div><div class="v">${n(b.cacheWrite5m + b.cacheWrite1h)}</div></div>
  <div class="card"><div class="k">output</div><div class="v">${n(b.output)}</div></div>
</div>
<div class="note">Read from your transcripts, including the 5-minute / 1-hour cache-write split, so each write is priced at its own multiplier. Nothing on this row is estimated. The dollar figure is the <strong>list-price value of these tokens</strong>, not a bill — on a subscription plan you did not pay it.</div>

<h2>CONTEXT — WHERE THE ALWAYS-ON PREFIX GOES</h2>
${flamegraph(a)}
<div class="note">Median measured prefix is <strong>${n(a.medianPrefixTokens)} tokens</strong>. At ${a.medianTurnsPerSession} turns per session, prompt caching makes that prefix <strong>${ratio.toFixed(1)}× cheaper</strong> than the tokens-×-turns figure quoted everywhere else. The residual is what we measured but cannot attribute to a file: Claude Code's own system prompt plus MCP tool schemas, whose size is only knowable at runtime.</div>

<h2>DEAD SHARE</h2>
<div class="card"><div class="k">always-on context with no observable consequence</div>
<div class="v" style="color:${a.deadSharePct > 50 ? 'var(--rust)' : a.deadSharePct > 25 ? 'var(--amber)' : 'var(--green)'}">${a.deadSharePct.toFixed(0)}%</div></div>

<h2>LEASE LEDGER</h2>
${ledger(a)}

<h2>PROPOSALS</h2>
${proposals(a)}
<div class="note">Nothing here is applied automatically. Prevention-class claims are excluded from eviction entirely: a prevention rule looks useless precisely because it works, so observational evidence can never condemn it.</div>

<h2>BALANCE</h2>
<div class="bal">
  <div><span>tiers reached</span><strong>${a.cost.tier}</strong></div>
  <div><span>analysis cost</span><strong style="color:${a.cost.tokens > 0 ? 'var(--amber)' : 'var(--green)'}">${a.cost.tokens > 0 ? `${n(a.cost.tokens)} tokens · $${a.cost.usd.toFixed(3)}` : '0 tokens'}</strong></div>
  ${a.cost.tokens > 0 ? `<div><span>claims judged at T2</span><strong>${a.cost.judged ?? 0} <small style="color:var(--dim)">via ${esc(a.cost.model ?? '')}, your own quota</small></strong></div>` : '<div><span>network calls</span><strong style="color:var(--green)">0</strong></div>'}
  <div><span>proposals would save</span><strong style="color:var(--green)">${saved > 0 ? '~' + n(saved) + ' eff tok / session' : '—'}</strong></div>
  ${a.cost.tokens > 0 && saved > 0 ? `<div><span>payback</span><strong style="color:var(--green)">${a.cost.tokens / saved < 1 ? 'first session' : '~' + Math.ceil(a.cost.tokens / saved) + ' sessions'}</strong></div>` : ''}
</div>

<footer>
harnessmeter 0.1.0 · evidence tiers reached in this run: ${a.cost.tier === 'T0/T1/T2' ? 'T0 (presence), T1 (consequence), T2 (judgement)' : 'T0 (presence), T1 (consequence) — run with <code>--t2</code> to escalate unproven claims'}.
T3 natural experiments and T4 field randomisation are not in this release.<br>
Session-level figures are exact. Per-claim token counts are calibrated estimates at
~3.8 chars/token and are labelled as such wherever shown.
</footer>
</main></body></html>`;
}
