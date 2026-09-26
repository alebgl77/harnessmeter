# Expert and team workflow

This guide covers the **unreleased source branch**, not the published `0.3.0` CLI. Use
Node ≥ 22.18 and a reviewed checkout containing `src/args.ts` and `src/baseline.ts`.
There are no runtime dependencies and these examples make no model calls.

## Start from the project you want to audit

Keep the tool checkout separate from the repository being measured. From that repository's
root, set the source path once. In a POSIX shell:

```sh
HARNESSMETER_CLI="/absolute/path/to/harnessmeter/src/cli.ts"
node "$HARNESSMETER_CLI" --help
node "$HARNESSMETER_CLI" --provider claude --static --project-only
node "$HARNESSMETER_CLI" --provider codex --static --project-only
```

In PowerShell:

```powershell
$harnessmeterCli = 'C:\path\to\harnessmeter\src\cli.ts'
node $harnessmeterCli --help
node $harnessmeterCli --provider claude --static --project-only
node $harnessmeterCli --provider codex --static --project-only
```

Each command audits the current working directory. `--provider` defaults to `claude`; set
it explicitly in shared scripts. Run from the same repository-relative directory on every
machine. In a monorepo, a root audit does not recursively represent every subdirectory's
instruction chain: audit relevant working directories separately and give each its own
baseline.

Open `.harnessmeter/report.html` after each command, or use `--out` with different paths to
keep both reports. The default report is replaced on each run. Search and filter the claim
ledger, inspect the source file/line locations, and check which files are missing from the
supported coverage below before choosing a budget.

`--static` never discovers or reads transcripts. `--project-only` excludes user harness
files and installed user plugins; it also excludes project-local MCP entries held in
personal `~/.claude.json`. Claude imports that escape the repository are excluded in this
mode. This gives a shared footprint for the supported repository-owned surfaces, provided
the checkout contents, working directory and tool revision match.

## Establish one baseline per provider

After reviewing the initial inventory, run:

```sh
node "$HARNESSMETER_CLI" --provider claude --static --project-only --no-html --save-baseline harnessmeter.claude.json
node "$HARNESSMETER_CLI" --provider codex --static --project-only --no-html --save-baseline harnessmeter.codex.json
git diff --no-index /dev/null harnessmeter.claude.json
```

The final `git diff` is a POSIX example and normally exits `1` when it displays differences;
it is a review command, not a failed audit. Review the JSON in your editor on any platform.
Commit both baselines with the team's chosen limits. Store shared baselines outside
`.harnessmeter/`, whose generated `.gitignore` excludes private artifacts.

Snapshots use schema version `1`, a provider, a scope (`project` or `project+user`), the
metric `estimated-resident-tokens`, a total and per-claim entries. Entries contain relative
paths, section/content hashes, estimated resident sizes, loading mode and protection
status. They contain no transcripts or raw instruction text. Relative paths and sizes still
reveal structure; hashes are not encryption or a guarantee of anonymity.

Compare after an instruction change:

```sh
node "$HARNESSMETER_CLI" --provider claude --static --project-only --baseline harnessmeter.claude.json --max-tokens 8000 --max-growth 5
node "$HARNESSMETER_CLI" --provider codex --static --project-only --baseline harnessmeter.codex.json --max-tokens 8000 --max-growth 5
```

`8000` and `5` are illustrative limits. They constrain estimated resident tokens, not the
whole prompt, a model's context-window limit, dollars or task success. Equality passes.
`--max-tokens` requires an integer ≥ 0; `--max-growth` requires a finite percentage ≥ 0 and
`--baseline`. A positive footprint growing from a zero baseline has unbounded growth and
fails any finite growth limit; zero to zero is 0%.

Provider or scope mismatches are errors. Comparison does not modify the input baseline.
To review a replacement, write a different path:

```sh
node "$HARNESSMETER_CLI" --provider claude --static --project-only --no-html --baseline harnessmeter.claude.json --save-baseline harnessmeter.claude.next.json
git diff --no-index harnessmeter.claude.json harnessmeter.claude.next.json
```

After review, replace the committed baseline deliberately. Reading and saving the same
path, including filesystem aliases, is rejected. An explicit `--save-baseline` writes its
snapshot even when a requested budget fails; use a separate candidate path and check the
exit code. A changed heading can appear as removal plus addition because section identity
is hashed. Body changes retain identity when the section identity stays the same.

A baseline does not capture all configuration. MCP declarations have unknown schema sizes
represented by zero resident tokens; changing an existing server's command, permissions or
arguments is not a content comparison. Review configuration and security changes separately.

## Gate changes in CI

Provision Node ≥ 22.18, check out the project, and make the reviewed Harnessmeter source
available on the runner. Until release, use that source checkout rather than adding these
flags to `npx harnessmeter@0.3.0`. Pin the tool revision in your provisioning process so a
tool update and an instruction update can be reviewed separately.

This is a step for an existing GitHub Actions job. It assumes the target project is the
working directory, its two baselines are committed, and the tool checkout is in the sibling
`harnessmeter` directory; adjust `HARNESSMETER_CLI` to your actual checkout location.

```yaml
- name: Check agent context budgets
  shell: bash
  env:
    HARNESSMETER_CLI: ../harnessmeter/src/cli.ts
  run: |
    node "$HARNESSMETER_CLI" --provider claude --static --project-only --no-html --baseline harnessmeter.claude.json --max-tokens 8000 --max-growth 5
    node "$HARNESSMETER_CLI" --provider codex --static --project-only --no-html --baseline harnessmeter.codex.json --max-tokens 8000 --max-growth 5
```

The commands require no sessions, API keys, model calls or install step. A normal CI shell
stops on the first nonzero exit. For independent results, run each provider in a separate
job or matrix entry. Exit `0` means requested budgets passed, `1` means invalid input or an
error, and `2` means a budget was exceeded. The report remains available on budget failure.
Do not regenerate accepted baselines in the gate: that would approve the change being
checked. Protect baseline updates with the same review rules as instruction changes.

## Use JSON without confusing unknown and zero

```sh
node "$HARNESSMETER_CLI" --provider codex --static --project-only --baseline harnessmeter.codex.json --max-growth 5 --json > harnessmeter-audit.json
```

`--json` emits one JSON document to stdout and skips HTML. Diagnostics go to stderr.
Shell redirection creates a file outside the tool's private directory, so review and manage
that file yourself. A budget failure still emits JSON; capture the command's exit status.

The existing analysis fields are retained with these additive CLI fields:

| Field | Contract |
|---|---|
| `schemaVersion` | `1` for this CLI envelope |
| `provider` | `claude` or `codex` |
| `mode` | `static` or `measured`; measured means sessions were read, not that every field is known |
| `baseline.comparison` | `null` or totals, growth, and `added`, `removed`, `changed` entries |
| `baseline.saved` | Whether this run explicitly saved a snapshot |
| `budget` | `passed`, `checks`, and `violations`; no requested limits means empty checks |
| `telemetryCoverage` | `status` (`full`, `partial`, `none`), known/total turns, and prefix/cache session counts |
| `spendKnown`, `cacheEconomicsKnown` | Availability indicators; `false` prohibits interpreting placeholder values as measurements |
| `absenceEvidenceKnown` | Whether the observation channel supports absence inference; this does not establish that any sessions were observed |

`baseline.comparison.growthPercent` and the growth check's `actual` are `null` for unbounded
growth from zero. `harnessEstTokens` is estimated. Legacy numeric fields can contain zero
placeholders and `cacheTtl` can contain a placeholder string when unavailable: consult the
availability and coverage fields before using them. `evidence` is an object keyed by claim
ID. The analysis JSON includes local source paths and labels; it is more revealing than
the portable baseline format.

For absence claims, use `mode`, each evidence entry's `observedIn`, `evidenceFloorSessions`
and `absenceEvidenceKnown` together. A static Claude inventory can have a compatible
absence channel (`true`) but zero observed sessions; that is not evidence of non-use.

## Add observations locally

Remove `--static` to read compatible sessions for the chosen provider. With no matching
sessions, the CLI discloses its fallback and produces a static audit successfully. It does
not infer behavioral success, measured spend or absence-based demotions. `--all` widens
the session corpus, while project claims remain scoped to their own project. `--limit`
caps sessions read, newest first, and requires an integer ≥ 1 (default `400`).

Use representative sessions before deciding what a rule earns. Even a supported zero-hit
bound describes the sessions scanned, not every opportunity where a rule might apply.
Its confidence assumes independent, representative observable opportunities; correlated or
selected sessions do not establish task-quality or causal guarantees.
Prevention claims remain protected from observational demotion. A footprint reduction
should also be assessed against representative task outcomes; this tool does not yet run
controlled quality experiments.

`--t2` and `--patch` are available only for the Claude profile. Explicit `--static` rejects
both; a no-session fallback cannot create absence-based proposals or invoke T2. T2 is an
opt-in model call through a local agent and can spend quota; see [the disclosure](../SECURITY.md).
Patches are proposals only, with separate project and user roots. Review the receipt and
generated skill trigger before applying the printed command; the tool never applies it.

## Coverage and limits

Both profiles use the nearest Git root through the current directory as the conservative
project instruction chain. A worktree `.git` file is recognized. Without a Git marker,
only the current directory is treated as project-owned. Ancestors outside that boundary
are not inferred, and runtime loading is not fully reconstructed. Prose sections shorter
than 40 characters are ignored by the current extractor.

| Surface | Claude profile | Codex profile |
|---|---|---|
| Project instructions | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` along the chain; supported prose `@` imports | First nonempty `AGENTS.override.md`, otherwise `AGENTS.md`, at each directory along the chain |
| User instructions | `CLAUDE_HOME/CLAUDE.md` (`~/.claude` by default) | `CODEX_HOME/AGENTS.override.md` or `AGENTS.md` (`~/.codex` by default) |
| Skills and agents | Current directory's `.claude/skills`, `.claude/agents`, `.claude/commands`; user equivalents and enabled installed plugin surfaces | `.agents/skills` along the project chain and `~/.agents/skills` |
| MCP inventory | Current `.mcp.json`, supported user settings and `~/.claude.json` declarations; unknown schema sizes | Not yet supported |
| Sessions | `CLAUDE_HOME/projects/**/*.jsonl`; matching current project or `--all` | `CODEX_HOME/sessions` and `archived_sessions`; exact canonical current working directory or `--all` |
| Economics | Compatible Claude usage/cache buckets; list-price estimates | Compatible token counters; no dollar prices or cache-write/TTL economics |

Claude's discovery is a conservative model, not a complete copy of its runtime loader.
Conditional rules, managed/admin settings and all runtime context injection are outside
coverage. MCP servers are declarations with unknown token sizes, not inspected live schemas.

Codex telemetry supports `event_msg` / `token_count` records with cumulative
`info.total_token_usage`. Duplicate cumulative updates are ignored. Missing usage stays
unknown; a counter reset makes subsequent usage unknown rather than counting possibly
replayed history. Forked histories (`forked_from_id` or `history_base`) and sessions spanning
multiple working directories are excluded. Records larger than 16 MiB are skipped.
Last-only usage and newer `token_usage_record` formats are unsupported. A session can still
contribute observed tool activity while its usage is unknown.

Codex skill use and tools nested inside code-mode calls are not fully attributable. Their
absence is not reliable evidence: Codex scans do not issue absence confidence or demotion
proposals. Custom TOML instruction filenames, disabled-skill settings, Codex MCP/plugins
and runtime instruction truncation are not modeled. The selected profile is a disclosed
subset of agent behavior, not a certification of the effective prompt.
