#!/usr/bin/env node
/**
 * harnessmeter — a profiler for your agentic harness.
 *
 * Reads only local files. Makes no network calls and no model calls.
 * Writes nothing outside .harnessmeter/ in the current project.
 */

import fs from 'node:fs';
import path from 'node:path';
import { analyze } from './analyze.ts';
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
  --help

  Reads ~/.claude/projects/**/*.jsonl and your harness files.
  Zero model calls. Zero network. Nothing leaves this machine.
`;

type Args = {
  all: boolean; limit: number; json: boolean; html: boolean; out?: string; help: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { all: false, limit: 400, json: false, html: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--all') a.all = true;
    else if (v === '--json') a.json = true;
    else if (v === '--no-html') a.html = false;
    else if (v === '--help' || v === '-h') a.help = true;
    else if (v === '--limit') a.limit = Math.max(1, Number(argv[++i]) || 400);
    else if (v === '--out') a.out = argv[++i];
  }
  return a;
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

  const analysis = analyze(cwd, sessions);

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
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, renderHtml(analysis), 'utf8');
    process.stdout.write(`  report  ${path.relative(cwd, out) || out}\n\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`\n  harnessmeter failed: ${err?.message ?? err}\n\n`);
  process.exitCode = 1;
});
