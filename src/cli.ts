#!/usr/bin/env node
/**
 * harnessmeter — a profiler for your agentic harness.
 *
 * Reads only local files. Makes no network calls and no model calls.
 * Writes nothing outside .harnessmeter/ in the current project.
 */

import fs from 'node:fs';
import path from 'node:path';
import { analyze, prepare } from './analyze.ts';
import { runEvidence } from './evidence.ts';
import { mergeT2, runT2, t2Candidates, type T2Result } from './evidence-t2.ts';
import { detectAgent } from './agent.ts';
import { renderTerminal } from './report-term.ts';
import { renderHtml } from './report-html.ts';
import { findProjectDir, listProjectDirs, scanSessions } from './transcript.ts';

const HELP = `
harnessmeter 0.1.0 — price the leases your context window is carrying

  usage: npx harnessmeter [options]

  --all              scan every project, not just this directory
  --limit <n>        cap sessions read, newest first (default 400)
  --json             print machine-readable analysis to stdout
  --no-html          skip writing the HTML report
  --out <path>       HTML output path (default .harnessmeter/report.html)

  --t2               escalate unproven claims to your local agent for judgement
  --t2-model <m>     model for T2 (default: sonnet)
  --yes              skip the T2 confirmation prompt

  --help

  T0/T1 are free: local files only, zero model calls, zero network.
  T2 spends your own quota through your own agent CLI, and says what it cost.
`;

type Args = {
  all: boolean; limit: number; json: boolean; html: boolean; out?: string;
  t2: boolean; t2Model?: string; yes: boolean; help: boolean;
};

/**
 * The agent CLI is spawned with `shell: true` on Windows, which is how a `.cmd` shim gets
 * resolved. That makes any value reaching argv a potential injection point, so the model
 * name is constrained to what a model id can actually contain.
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
  const a: Args = { all: false, limit: 400, json: false, html: true, t2: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--all') a.all = true;
    else if (v === '--json') a.json = true;
    else if (v === '--no-html') a.html = false;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const cwd = process.cwd();
  const projectDir = args.all ? undefined : findProjectDir(cwd);

  if (!args.all && !projectDir) {
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

  const sessions = await scanSessions({ project: projectDir, limit: args.limit });
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
            onProgress: () => process.stderr.write('.'),
          });
          process.stderr.write(' done\n');
          mergeT2(prepared.evidence, t2, prepared.claims);
        }
      }
    }
  }

  const analysis = analyze(cwd, sessions, prepared, t2);

  if (args.json) {
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
