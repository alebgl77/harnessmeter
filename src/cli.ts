#!/usr/bin/env node
/**
 * harnessmeter — a profiler for your agentic harness.
 *
 * Reads only local files. Makes no network calls and no model calls.
 * Writes nothing outside .harnessmeter/ in the current project.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { analyze, prepare, type Prepared } from './analyze.ts';
import { runEvidence } from './evidence.ts';
import { mergeT2, runT2, t2Candidates, type T2Result } from './evidence-t2.ts';
import { detectAgent } from './agent.ts';
import { buildPatch } from './patch.ts';
import { renderTerminal } from './report-term.ts';
import { renderHtml } from './report-html.ts';
import { claudeHome, findProjectDir, listProjectDirs, scanSessions } from './transcript.ts';
import type { Analysis } from './types.ts';
import { VERSION } from './version.ts';

const HELP = `
harnessmeter ${VERSION} — price the leases your context window is carrying

  usage: npx harnessmeter [options]

  --all              scan every project, not just this directory
  --limit <n>        cap sessions read, newest first (default 400)
  --json             print machine-readable analysis to stdout
  --no-html          skip writing the HTML report
  --out <path>       HTML output path (default .harnessmeter/report.html)
  --patch            write the demotions as a reviewable diff, and apply nothing

  --t2               escalate unproven claims to your local agent for judgement
  --t2-model <m>     model for T2 (default: sonnet)
  --yes              skip the T2 confirmation prompt

  --help

  T0/T1 are free: local files only, zero model calls, zero network.
  T2 spends your own quota through your own agent CLI, and says what it cost.
`;

type Args = {
  all: boolean; limit: number; json: boolean; html: boolean; out?: string;
  patch: boolean; t2: boolean; t2Model?: string; yes: boolean; help: boolean;
};

/**
 * A bare agent command still goes through a shell on Windows, which is how a `.cmd` shim
 * gets resolved, so a value reaching argv can still reach a shell. The model name is
 * therefore constrained to what a model id can actually contain.
 */
function safeModel(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v)) {
    process.stderr.write(`\n  Ignoring --t2-model "${v.slice(0, 40)}": not a valid model id.\n`);
    return undefined;
  }
  return v;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { all: false, limit: 400, json: false, html: true, patch: false, t2: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--all') a.all = true;
    else if (v === '--json') a.json = true;
    else if (v === '--no-html') a.html = false;
    else if (v === '--patch') a.patch = true;
    else if (v === '--t2') a.t2 = true;
    else if (v === '--yes' || v === '-y') a.yes = true;
    else if (v === '--help' || v === '-h') a.help = true;
    else if (v === '--limit') a.limit = Math.max(1, Number(argv[++i]) || 400);
    else if (v === '--t2-model') a.t2Model = safeModel(argv[++i]);
    else if (v === '--out') a.out = argv[++i];
  }
  return a;
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
    fs.writeFileSync(out, set.text, 'utf8');
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

  const cwd = process.cwd();

  // Two different things, and conflating them is what let `--all` compare a project's
  // claims against other projects' sessions:
  //   currentProject — which project's harness we are judging. Always the cwd's.
  //   sessionProject — which transcripts to read. Widened by --all.
  const currentProject = findProjectDir(cwd);
  const sessionProject = args.all ? undefined : currentProject;

  if (!args.all && !currentProject) {
    const known = listProjectDirs().length;
    process.stderr.write(
      `\n  No Claude Code transcripts found for this directory.\n` +
        (known
          ? `  ${known} other project${known === 1 ? '' : 's'} on this machine — rerun with --all to scan them.\n\n`
          : `  Looked in ~/.claude/projects. Nothing there yet.\n\n`),
    );
    process.exitCode = 1;
    return;
  }

  const sessions = await scanSessions({ project: sessionProject, limit: args.limit });
  if (sessions.length === 0) {
    process.stderr.write('\n  No sessions with usage data found.\n\n');
    process.exitCode = 1;
    return;
  }

  const prepared = prepare(cwd);
  prepared.evidence = runEvidence({
    claims: prepared.claims,
    sessions,
    bodies: prepared.bodies,
    currentProject: currentProject ?? null,
  });

  let t2: T2Result | undefined;
  if (args.t2) {
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

  if (args.json) {
    // --patch is an explicit request and must not be silently dropped by --json. The
    // patch is written and reported on stderr, so stdout stays a single JSON document.
    if (args.patch) writePatches(cwd, analysis, prepared, true);
    process.stdout.write(
      JSON.stringify(
        { ...analysis, evidence: Object.fromEntries(analysis.evidence) },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  process.stdout.write(renderTerminal(analysis) + '\n');

  if (args.patch) writePatches(cwd, analysis, prepared, false);

  if (args.html) {
    const out = args.out ?? path.join(cwd, '.harnessmeter', 'report.html');
    const dir = path.dirname(out);
    fs.mkdirSync(dir, { recursive: true });

    // The report describes your harness — section headings, skill names, MCP servers.
    // Default output goes in the repo, so make it un-committable by default rather than
    // relying on the user to remember.
    if (!args.out) {
      const ignore = path.join(dir, '.gitignore');
      if (!fs.existsSync(ignore)) {
        fs.writeFileSync(
          ignore,
          '# harnessmeter output describes your harness — keep it out of git.\n*\n',
          'utf8',
        );
      }
    }

    fs.writeFileSync(out, renderHtml(analysis), 'utf8');
    process.stdout.write(`  report  ${path.relative(cwd, out) || out}\n\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`\n  harnessmeter failed: ${err?.message ?? err}\n\n`);
  process.exitCode = 1;
});
