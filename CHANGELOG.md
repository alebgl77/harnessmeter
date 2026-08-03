# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- **T3 — natural experiments.** Read `.claude/**` git history as an intervention registry.
  Different repos adopt the same advice on different dates, which is the setting where
  staggered difference-in-differences identifies an effect. Free: it is history, not runs.
- **T4 — field randomisation.** Vary the harness on runs that were going to happen anyway,
  on dead-classified claims only. A randomised trial at zero incremental cost.
- **Patch generator.** Emit the demotion as a reviewable diff rather than a description.
- **Readers for other harnesses.** Codex and Antigravity transcript formats.

## [0.1.3] — 2026-07-28

Completes the `--all` scoping work and stops the report describing a remainder it has not
measured.

### Changed — verdict accuracy

- **`--all` no longer mixes session populations.** The project being analysed and the set of
  transcripts to read are now separate values: widening the scan no longer widens the
  population a project's claims are judged against. 0.1.2 fixed this only for runs without
  `--all`, which is the one mode where it could not occur.
- **The unattributed remainder is named for what it is.** Both reports previously described
  it as "base system prompt + MCP tool schemas". It also contains the opening user message
  and anything else injected into that turn, and no breakdown of it has been measured, so
  none is reported.

### Fixed

- **An agent binary whose path contains a space could not be launched on Windows.** A bare
  command still resolves through the shell so `.cmd` shims work; an explicit path no longer
  does, which also narrows the injection surface.
- Identifiers reaching the T2 prompt — tool names, skill names, claim ids — are reduced to
  `[A-Za-z0-9_.:/-]`, and the session digest is serialised as JSON rather than free-form
  text, so a hostile name lands inside a string literal instead of becoming prompt structure.

### Added

- End-to-end tests through the CLI entry point, including the `--all` scoping paths. They
  target `src/` rather than `bin/`, because the bin entry prefers a built `dist/` and a
  stale one would make every assertion pass while testing nothing.
- Coverage for shell-command extraction and truncation, unpriced models, the first-turn
  upper bound, the unattributed remainder, T2 identifier sanitisation, T2 consent, agent
  process failures and timeouts, and HTML escaping. 68 tests.

### Release process

- `package-lock.json` is committed and CI installs with `npm ci`.
- GitHub Actions are pinned by commit SHA; npm is pinned to an exact version.
- One tarball is built, verified and published — the publish job no longer rebuilds it.
- Publishing is restricted to `refs/tags/v*`. A manual run must name an existing tag whose
  version matches `package.json`; it cannot publish a branch.

## [0.1.2] — 2026-07-28

Accuracy release. Several verdicts could be wrong in ways that mattered, so **re-run any
analysis produced by an earlier version** before acting on it.

Published by GitHub Actions through OIDC trusted publishing. No npm token exists in this
repository, and the package carries a SLSA provenance attestation linking it to the commit
and workflow run that built it.

### Changed — verdict accuracy

- **Rules that prescribe a shell command are now measured.** Every shell call is named
  `Bash`, so a rule such as "always run `npm test`" leaves no trace in tool names. Command
  lines are read from the transcripts and matched, which is the only way such a rule can be
  confirmed or refuted.
- **Claims are judged only where they were loaded.** `~/.claude` claims are evaluated
  against every session; a project's claims only against that project's. Under `--all` this
  keeps other projects' work out of the denominators.
- **`not-applicable` no longer counts against a claim.** At T2, "the subject never came up"
  is the absence of an occasion to test a rule, not evidence it is useless — reading it
  otherwise penalises every rule that guards a rare situation. It reports `unproven`.
- **A claim with no sessions in scope reports `unproven`.** Silence is not evidence.
- **Unpriced models are named, and the dollar figure is labelled an estimate** whenever any
  appear, instead of being valued silently at a fallback rate.
- **The first-turn prompt is labelled an upper bound** on the resident prefix, since it also
  contains the opening user message and the billed totals do not separate the two.
- Tool names taken from transcripts are sanitised before entering the T2 prompt.

### Added

- `test/evidence.test.ts` — regression coverage for every verdict path above. 40 tests
  total, still with no test-framework dependency.

## [0.1.1] — 2026-07-27

First version published to npm.

### Changed

- The published package ships compiled JavaScript. Node does not strip TypeScript types for
  files under `node_modules`, so a package cannot ship `.ts` sources and expect them to run.
  A source checkout still runs the TypeScript directly with no build step.
- Runtime requirement is **Node ≥ 20** for the published package, **≥ 22.18** from a
  checkout. The entry point detects which it is and reports the right minimum.
- Still **zero runtime dependencies**. TypeScript is a dev dependency used only to build the
  published artifact.

### Added

- CI packs the tarball, installs it into a clean project and runs it on Node 20 and 24, and
  rejects any build whose artifact contains TypeScript sources.

## [0.1.0] — 2026-07-27

Initial implementation.

### Added

- **Exact billed-token accounting.** Reads `usage` from Claude Code transcripts, including
  the 5-minute / 1-hour cache-write split, so each write is priced at its own multiplier.
- **Cache-weighted pricing.** Reads at `0.1×`, 5m writes at `1.25×`, 1h writes at `2×`.
  Naive tokens-×-turns overstates a stable prefix by ~7× at 34 turns and ~10× at 300.
- **Measured prefix**, decomposed into harness files versus residual (base system prompt
  plus MCP tool schemas, whose size is only knowable at runtime).
- **Claim extraction** from `CLAUDE.md` sections, skills, subagents and MCP servers. A
  skill's always-on cost is its frontmatter description, not its body.
- **Evidence tiers T0 (presence) and T1 (consequence)** — free, local, no model calls.
- **Evidence tier T2 (judgement)** via the local agent CLI, opt-in behind `--t2`. Batched
  twelve claims per call; sends claim text plus shape-only digests; returns `unjudgeable`
  rather than guessing on rules a tool trajectory cannot settle.
- **Lease ledger, dead share, and proposals with receipts** — every proposal carries its
  evidence tier, sample size, class and confidence.
- **Balance line** reporting what the run cost and when it pays for itself.
- **Terminal and self-contained HTML reports**, both theme-aware.
- Test suite on `node:test`, with no test-framework dependency.

### Design decisions

- **Prevention claims are protected by default.** A prevention rule has inverted yield: it
  looks useless precisely because it works. Observational evidence can never condemn one.
- **Prevention detection is deliberately narrow**, requiring a strong prohibition or a
  secret-family noun inside a line that reads as a rule. Capability definitions are never
  prevention. Protection that fires too easily covers the whole harness and reports nothing.
- **The dollar figure is labelled `api-equivalent`, not spend.** On a subscription plan
  nobody paid it.
- **The primary action is demotion, not deletion.** Moving an always-on block to on-demand
  is a large win at near-zero risk. Deletion is the rare case.

[Unreleased]: https://github.com/alebgl77/harnessmeter/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/alebgl77/harnessmeter/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/alebgl77/harnessmeter/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/alebgl77/harnessmeter/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alebgl77/harnessmeter/releases/tag/v0.1.0
