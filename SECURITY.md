# Security policy

## What harnessmeter touches

It is worth being precise, because this tool reads files that contain your work.

**Reads:**

- `~/.claude/projects/**/*.jsonl` — your Claude Code session transcripts
- your harness files: `CLAUDE.md`, `.claude/skills/**`, `.claude/agents/**`, `settings.json`,
  MCP configuration

**Writes:**

- `.harnessmeter/report.html` in the current project, and nothing else

**Sends:**

- **T0 and T1: nothing.** No network calls, no model calls, no telemetry. Verify it the
  blunt way — run it with networking disabled; it behaves identically.
- **T2 (`--t2`, opt-in, confirmed interactively): claim text plus shape-only session
  digests** — turn counts and tool-call tallies — to *your own* agent CLI, which sends them
  to *your own* model provider. No message content, no file contents, no file paths.
  harnessmeter never holds an API key.

**The generated report contains your harness structure** — section headings, skill names,
MCP server names — and the counts derived from them. It is written under `.harnessmeter/`,
which the shipped `.gitignore` excludes. Treat it as you would treat your `CLAUDE.md`, and
check before pasting one into a public issue.

## Reporting a vulnerability

Please report privately through GitHub's private vulnerability reporting:

**[Report a vulnerability](https://github.com/alebgl77/harnessmeter/security/advisories/new)**

Do not open a public issue for anything that could expose someone else's data.

What to expect: acknowledgement within a week, an assessment and a fix or a clear
explanation of why it is not one. This is a small project maintained in the open — that is
a realistic commitment rather than an SLA.

## In scope

- Any path where data leaves the machine without an explicit opt-in
- Any write outside `.harnessmeter/`
- Reading files outside the documented set
- Anything in the report that exposes file *contents* rather than structure and counts
- Command injection through claim text, file names, or transcript content reaching the
  agent CLI

## Out of scope

- Vulnerabilities in Claude Code, Codex, or other agent CLIs — report those upstream
- The privacy posture of your own model provider once T2 hands them a prompt
- Accuracy of measurements. A wrong number is a bug, and an important one, but it is an
  [issue](https://github.com/alebgl77/harnessmeter/issues), not a security report.

## Supported versions

Pre-1.0: only the latest release is supported.
