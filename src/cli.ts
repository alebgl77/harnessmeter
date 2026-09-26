#!/usr/bin/env node
/**
 * harnessmeter — a profiler for your agentic harness.
 *
 * T0/T1 reads local files only. T2 calls a model only with explicit opt-in.
 * Reports default to .harnessmeter/; baseline paths are explicitly selected.
 */

import fs from 'node:fs';
import path from 'node:path';
import { analyze, prepare, type Prepared } from './analyze.ts';
import { runEvidence } from './evidence.ts';
import { mergeT2, runT2, t2Candidates, type T2Result } from './evidence-t2.ts';
import { detectAgent } from './agent.ts';
import { buildPatch } from './patch.ts';
import { renderTerminal } from './report-term.ts';
import { renderHtml } from './report-html.ts';
import { claudeHome, findProjectDir, scanSessions } from './transcript.ts';
import { codexProjectId, scanCodexSessions } from './transcript-codex.ts';
import { parseArgs, type Args } from './args.ts';
import { assertSafePath, atomicWrite, compareBaselines, createBaseline, readBaseline, sameTarget, writeBaseline } from './baseline.ts';
import { evaluateBudget } from './budget.ts';
import type { Analysis, Session } from './types.ts';
import { VERSION } from './version.ts';

const HELP = `
harnessmeter ${VERSION} — price the leases your context window is carrying

  usage: npx harnessmeter [options]

  --all              scan every project, not just this directory
  --provider <name>  claude (default) or codex
  --static           audit harness files without reading transcripts or calling models
  --project-only     exclude user harness and installed user plugins
  --limit <n>        cap sessions read, newest first (default 400)
  --json             print machine-readable analysis to stdout
  --no-html          skip writing the HTML report
  --out <path>       HTML output path (default .harnessmeter/report.html)
  --patch            write the demotions as a reviewable diff, and apply nothing

  --save-baseline <path>  explicitly save a portable, text-free footprint snapshot
  --baseline <path>       compare against an existing snapshot (never overwritten)
  --max-tokens <n>        fail if estimated resident tokens exceed this integer
  --max-growth <pct>      fail if growth exceeds this percentage; requires --baseline

  --t2               escalate unproven claims to your local agent for judgement
  --t2-model <m>     model for T2 (default: sonnet)
  --yes              skip the T2 confirmation prompt

  --help / --version

  No transcripts: a disclosed static audit succeeds. No absence-based demotions.
  --static rejects --t2/--patch; Codex currently rejects --t2/--patch.
  Exit codes: 0 pass, 1 invalid input/error, 2 budget exceeded.

  T0/T1 are free: local files only, zero model calls, zero network.
  T2 spends your own quota through your own agent CLI, and says what it cost.
`;

function isDefaultOutput(cwd: string, output: string): boolean {
  const directory = path.join(cwd, '.harnessmeter');
  const rel = path.relative(directory, path.resolve(output));
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** Validate every active writer together before any artifact or model call is made. */
function preflightOutputs(cwd: string, args: Args, prepared: Prepared, htmlOutput: string): void {
  const outputs: { label: string; file: string }[] = [];
  if (!args.json && args.html) outputs.push({ label: 'HTML report', file: htmlOutput });
  if (args.patch) {
    for (const name of ['demote.patch', 'demote-user.patch']) {
      outputs.push({ label: name, file: path.join(cwd, '.harnessmeter', name) });
    }
  }
  if (args.saveBaseline) outputs.push({ label: 'saved baseline', file: args.saveBaseline });

  const privateIgnore = path.join(cwd, '.harnessmeter', '.gitignore');
  if ([args.baseline, ...outputs.map((output) => output.file)].some((file) => file && sameTarget(file, privateIgnore))) {
    throw new Error('Outputs and baselines must not use the private artifact .gitignore path');
  }
  // The implicit privacy file is also a writer: an existing hardlink to a source or
  // baseline must not be replaced just because another report uses this directory.
  if (outputs.some((output) => isDefaultOutput(cwd, output.file))) {
    outputs.push({ label: 'private artifact .gitignore', file: privateIgnore });
  }
  const inputs = [...prepared.snapshot.keys()].map((file) => ({ label: 'scanned harness source', file }));
  if (args.baseline) inputs.push({ label: 'read baseline', file: args.baseline });
  const nested = (parent: string, child: string) => {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };

  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i];
    assertSafePath(output.file);
    if (fs.existsSync(output.file) && !fs.statSync(output.file).isFile()) {
      throw new Error(`${output.label} output must be a regular file`);
    }
    for (const other of [...inputs, ...outputs.slice(0, i)]) {
      if (sameTarget(output.file, other.file) || nested(output.file, other.file) || nested(other.file, output.file)) {
        throw new Error(`${output.label} and ${other.label} must use different files`);
      }
    }
  }
}

/** Every artifact in the default directory is private, including JSON-mode patches. */
function protectDefaultOutput(cwd: string, output: string): void {
  if (!isDefaultOutput(cwd, output)) return;
  const directory = path.join(cwd, '.harnessmeter');
  assertSafePath(directory);
  fs.mkdirSync(directory, { recursive: true });
  const ignore = path.join(directory, '.gitignore');
  assertSafePath(ignore);
  // The final wildcard overrides older exception rules as well as covering new outputs.
  const previous = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  if (!previous.endsWith('\n*\n')) atomicWrite(ignore, previous + '\n# Private harnessmeter artifacts.\n*\n');
}

/**
 * T2 sends data to the user's model provider. That is a different privacy posture from
 * T0/T1, so it is stated plainly and confirmed before anything is sent.
 */
async function confirmT2(candidates: number, model: string, auto: boolean): Promise<boolean> {
  process.stderr.write(
    `\n  T2 will ask your local agent to judge ${candidates} unproven claim${candidates === 1 ? '' : 's'} (model: ${model}).\n` +
      `  It sends: the claim text, and turn counts plus tool-call tallies from sampled sessions.\n` +
      `  It does not send: message content, file contents, or file paths.\n` +
      `  This uses your own quota. Cost is reported when it finishes.\n`,
  );
  if (auto) {
    process.stderr.write('  --yes given, proceeding.\n\n');
    return true;
  }
  if (!process.stdin.isTTY) {
    process.stderr.write('  Not a TTY — rerun with --yes to proceed.\n\n');
    return false;
  }
  process.stderr.write('\n  Proceed? [y/N] ');
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => resolve(String(d).trim().toLowerCase()));
  });
  process.stderr.write('\n');
  return answer === 'y' || answer === 'yes';
}

/**
 * Write the demotions as diffs, and apply nothing.
 *
 * Two patches, because a project's memory file and the user's are applied from different
 * directories and land their skills in different places. Which patch a claim belongs to is
 * its SCOPE — the field the scanner already set — and never where its file happens to sit:
 * a project normally lives inside the home directory, so a containment test would admit
 * every project section into the user patch as well and write its skill into the
 * machine-wide skills directory, putting one project's rule in every other project's
 * always-on prefix.
 */
function writePatches(cwd: string, analysis: Analysis, prepared: Prepared, quiet: boolean): void {
  const home = claudeHome();
  const roots = [
    { root: cwd, scope: 'project' as const, skillDir: '.claude/skills', name: 'demote.patch', label: 'this project' },
    { root: home, scope: 'user' as const, skillDir: 'skills', name: 'demote-user.patch', label: 'your user harness' },
  ];

  const dir = path.join(cwd, '.harnessmeter');
  protectDefaultOutput(cwd, path.join(dir, 'demote.patch'));
  // Reports go to stderr so that --json stdout stays machine-readable.
  const say = (s: string) => (quiet ? process.stderr : process.stdout).write(s);
  let wrote = 0;

  for (const { root, scope, skillDir, name, label } of roots) {
    const set = buildPatch({
      claims: analysis.claims,
      proposals: analysis.proposals,
      bodies: prepared.bodies,
      snapshot: prepared.snapshot,
      root,
      scope,
      skillDir,
    });
    const out = path.join(dir, name);

    if (!set.text) {
      // A patch left from an earlier run still applies cleanly, and would demote a section
      // this run no longer considers dead. Stale advice is worse than none.
      if (fs.existsSync(out)) {
        fs.rmSync(out, { force: true });
        say(`  patch   removed a stale ${name} — nothing to demote in ${label} now\n`);
      }
      for (const s of set.skipped) say(`  skipped ${s.label}: ${s.reason}\n`);
      continue;
    }

    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(out, set.text);
    wrote++;

    const rel = path.relative(cwd, out) || out;
    const saved = set.entries.reduce((n, e) => n + e.savingPerSession, 0);
    const n = set.entries.length;
    say(
      `  patch   ${rel}  ${n} demotion${n === 1 ? '' : 's'} from ${label}` +
        ` — ~${Math.round(saved).toLocaleString('en-US')} eff tok/session\n`,
    );
    // Applied FROM its root, which is not always the directory we are standing in.
    // `git -C` works outside a repository too, so one command covers both roots -- and
    // unlike `patch -p1 < file` it runs in PowerShell, where `<` is not a redirect.
    say(`          review it, then: git -C "${set.root}" apply "${out}"
`);
    for (const s of set.skipped) say(`  skipped ${s.label}: ${s.reason}\n`);
  }

  if (!wrote) say('  patch   nothing to demote — no always-on section was found dead.\n');
  say('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(VERSION + '\n');
    return;
  }

  const cwd = process.cwd();
  const htmlOutput = args.out ?? path.join(cwd, '.harnessmeter', 'report.html');
  const prepared = prepare(cwd, { provider: args.provider, includeUser: !args.projectOnly });
  preflightOutputs(cwd, args, prepared, htmlOutput);
  const previous = args.baseline ? readBaseline(args.baseline, {
    provider: args.provider, scope: args.projectOnly ? 'project' : 'project+user',
  }) : undefined;
  // Static mode never even discovers transcript directories. In measured mode the
  // judged project remains cwd's, independently of --all widening the session corpus.
  const currentProject = args.static ? null : args.provider === 'codex' ? codexProjectId(cwd) : findProjectDir(cwd) ?? null;
  let sessions: Session[] = [];
  if (!args.static) {
    sessions = args.provider === 'codex'
      ? await scanCodexSessions({ cwd, all: args.all, limit: args.limit })
      : args.all || currentProject
        ? await scanSessions({ project: args.all ? undefined : currentProject!, limit: args.limit })
        : [];
  }
  const mode = args.static || sessions.length === 0 ? 'static' : 'measured';
  if (!args.static && mode === 'static') {
    process.stderr.write(`\n  No ${args.provider === 'codex' ? 'Codex' : 'Claude Code'} sessions found; using a static harness audit.\n  Token estimates are available; behavioral evidence and measured economics are unavailable.\n`);
  }
  prepared.evidence = runEvidence({
    claims: prepared.claims,
    sessions,
    bodies: prepared.bodies,
    currentProject: currentProject ?? null,
  });

  let t2: T2Result | undefined;
  if (args.t2 && mode !== 'static') {
    const candidates = t2Candidates(prepared.claims, prepared.evidence);
    if (candidates.length === 0) {
      process.stderr.write('\n  T2: nothing to escalate — no unproven claims at T0/T1.\n');
    } else {
      const agent = await detectAgent();
      if (agent.kind === 'none') {
        process.stderr.write(
          '\n  T2 needs a local agent CLI on PATH (looked for `claude`, `codex`). Skipping.\n',
        );
      } else {
        const model = args.t2Model ?? 'sonnet';
        if (await confirmT2(candidates.length, model, args.yes)) {
          process.stderr.write('  judging');
          t2 = await runT2(candidates, prepared.bodies, sessions, {
            agent,
            model,
            currentProject: currentProject ?? null,
            onProgress: () => process.stderr.write('.'),
          });
          process.stderr.write(' done\n');
          mergeT2(prepared.evidence, t2, prepared.claims);
        }
      }
    }
  }

  const analysis = analyze(cwd, sessions, prepared, t2, currentProject ?? null);
  analysis.provider = args.provider;
  const snapshot = args.baseline || args.saveBaseline
    ? createBaseline({ cwd, provider: args.provider, includeUser: !args.projectOnly,
      claims: prepared.claims, bodies: prepared.bodies })
    : undefined;
  const comparison = previous ? compareBaselines(snapshot!, previous) : null;
  const budget = evaluateBudget(analysis.harnessEstTokens, {
    maxTokens: args.maxTokens, maxGrowth: args.maxGrowth, baselineTokens: previous?.totalTokens,
  });
  if (args.saveBaseline) {
    protectDefaultOutput(cwd, args.saveBaseline);
    writeBaseline(args.saveBaseline, snapshot!);
    process.stderr.write(`  baseline saved: ${args.saveBaseline}\n`);
  }
  const governance = { schemaVersion: 1, provider: args.provider, mode,
    baseline: { comparison, saved: Boolean(args.saveBaseline) }, budget };
  const reportContext = { comparison: comparison ?? undefined, budget };
  if (!budget.passed) {
    process.exitCode = 2;
    for (const check of budget.violations) process.stderr.write(`  Budget exceeded: ${check.metric} ${check.actual ?? 'unbounded'} > ${check.limit}. ${check.reason ?? ''}\n`);
  }

  if (args.json) {
    // --patch is an explicit request and must not be silently dropped by --json. The
    // patch is written and reported on stderr, so stdout stays a single JSON document.
    if (args.patch) writePatches(cwd, analysis, prepared, true);
    process.stdout.write(
      JSON.stringify(
        { ...analysis, ...governance, evidence: Object.fromEntries(analysis.evidence) },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  process.stdout.write(`\n  Provider: ${args.provider} · mode: ${mode} · scope: ${args.projectOnly ? 'project' : 'project + user'}\n`);
  process.stdout.write(renderTerminal(analysis, reportContext) + '\n');

  if (args.patch) writePatches(cwd, analysis, prepared, false);

  if (args.html) {
    const out = htmlOutput;
    protectDefaultOutput(cwd, out);
    atomicWrite(out, renderHtml(analysis, reportContext));
    process.stdout.write(`  report  ${path.relative(cwd, out) || out}\n\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`\n  harnessmeter failed: ${err?.message ?? err}\n\n`);
  process.exitCode = 1;
});
