# Security policy

## Scope of this policy

The provider, static-audit and baseline behavior described here applies to the unreleased
source branch. The published `0.3.0` package has a narrower Claude-only workflow. See the
[coverage limits](docs/expert-workflow.md#coverage-and-limits) for supported input formats.

## What harnessmeter reads

The selected provider controls discovery; the tool does not merge both providers' files.

- **Claude sessions:** JSONL files under `CLAUDE_HOME/projects` (`~/.claude/projects` by
  default). The reader derives usage, tool activity, limited command information and
  attribution from those files. Transcript message bodies are not included in reports.
- **Claude harness:** supported `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`
  files along the Git-root-to-working-directory chain, supported prose imports, skills,
  subagents and commands. Without `--project-only`, user harness files and enabled installed
  plugin surfaces are included. Supported MCP declarations are read from the current
  `.mcp.json`, user settings and `~/.claude.json`; runtime tool schemas are not fetched.
- **Codex sessions:** JSONL files under `CODEX_HOME/sessions` and `archived_sessions`
  (`~/.codex` by default). The reader extracts compatible counters and selected tool metadata.
  Custom/freeform tool payloads are not retained as command evidence.
- **Codex harness:** the supported `AGENTS.override.md`/`AGENTS.md` chain and
  `.agents/skills`; user instruction files under `CODEX_HOME` and `~/.agents/skills` when
  user scope is enabled. Codex TOML configuration, plugins and MCP are not audited.
- **History and baselines:** local Git metadata for claim dating, file metadata, and an
  explicitly selected baseline file when `--baseline` is supplied.

`--static` never discovers or reads transcripts and makes no model calls. `--project-only`
excludes personal harness/configuration and installed user plugins, including project-local
MCP declarations stored in personal `~/.claude.json`. In that mode, imports and symlinks
cannot bring out-of-repository content into the supported harness inventory. It does not
remove sensitive material already committed inside the repository.

## What harnessmeter writes

- The default HTML report is `.harnessmeter/report.html`. `--no-html` skips it; `--json`
  emits analysis to stdout instead of writing HTML.
- `.harnessmeter/.gitignore` is created or updated to end with a wildcard excluding private
  artifacts whenever an artifact is written in that directory. This reduces accidental Git
  inclusion; it is not access control and does not prevent forced additions or sharing.
- `--patch` explicitly requests `.harnessmeter/demote.patch` and/or `demote-user.patch`.
  They include source text needed for review and are never applied automatically. A stale
  generated patch is removed when no proposal remains for that scope.
- `--out <path>` explicitly chooses another HTML output path. `--save-baseline <path>`
  explicitly writes a portable snapshot, even if a requested budget fails. Parent
  directories are created as needed. An existing selected output may be replaced.

Baseline comparison never overwrites the input baseline. Reading and saving the same
baseline target is rejected. Artifact paths are checked for symlinks and collisions with
scanned harness sources, baseline inputs and other outputs; writes use a temporary file
and rename. These checks do not make an untrusted writable directory a secure sandbox.
Outputs outside `.harnessmeter/`, including files created by shell redirection of JSON,
are not protected by the generated `.gitignore`.

## What leaves the machine

**T0/T1: nothing.** No network calls, model calls or telemetry. Local static and session
analysis work offline. Installing a package, cloning a repository or running your CI
provider involves those tools' own network behavior, separate from an audit.

**T2: explicit opt-in through your local agent.** `--t2` asks the detected agent CLI to
judge eligible claims and uses that agent's model provider and quota. The CLI displays a
disclosure and asks for confirmation; `--yes` explicitly bypasses confirmation. Without a
TTY or `--yes`, it does not proceed. T2 is currently available only for measured Claude
profile analysis; the Codex profile and explicit `--static` reject it.

The constructed T2 prompt contains **claim text** and a shape-only digest of sampled
sessions (turn counts and tool-call tallies). It does not include transcript message text,
full source files or session paths as separate context. Claim text is derived from harness
files and can itself contain sensitive text or paths. The receiving agent can also load its
own instructions, tools and environment; harnessmeter does not isolate that agent or
control its provider's retention. Review the claims and your agent configuration before
opting in. Harnessmeter does not hold an API key.

T2 attempts, usage and cost are reported when available. Missing agent usage/cost and
underlying network-call counts remain unknown rather than being reported as zero.

## Sharing artifacts

HTML and analysis JSON contain harness structure, labels, source paths/line locations,
evidence summaries and derived counts. They do not export transcript message bodies or
full instruction bodies, but headings and paths can still be sensitive. Patches **do**
contain instruction text and must be treated accordingly.

Portable baselines omit raw instruction text, transcripts and absolute machine paths.
They retain relative paths, hashes, estimated sizes, provider/scope and protection metadata.
Hashes are not encryption: known or guessable content may be identifiable. Review all
artifacts before committing or posting them publicly; `--project-only` is a scope control,
not an anonymizer.

A baseline is not a complete configuration or security audit. In particular, MCP schema
sizes are unknown zero placeholders and existing MCP configuration contents are not
compared. A passing budget says nothing about permissions, secrets or task quality.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting:

**[Report a vulnerability](https://github.com/alebgl77/harnessmeter/security/advisories/new)**

Do not open a public issue for anything that could expose someone else's data. Include a
minimal synthetic reproduction when possible. Expect acknowledgement within a week and
an assessment with a fix or explanation; this is a small project, not an SLA.

## In scope

- Data leaving the machine without the documented T2 opt-in
- Unrequested writes, source overwrites or artifact path protections being bypassed
- Reading outside the documented provider/scope boundaries
- Unintended disclosure beyond each artifact's documented contents
- Command injection through claim text, filenames or transcript content reaching an agent

## Out of scope

- Vulnerabilities in Claude Code, Codex or other agent CLIs; report those upstream
- Your model provider's privacy posture after an explicitly authorized T2 call
- Measurement inaccuracies without a security impact; report those as
  [issues](https://github.com/alebgl77/harnessmeter/issues)

## Supported versions

Pre-1.0: only the latest release is supported. Source-branch functionality is under review
and does not represent an additional published release.
