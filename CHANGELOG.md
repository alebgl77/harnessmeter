# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-07-27

First version published to npm. `0.1.0` was tagged but never published, because it could
not have worked.

### Fixed

- **The package could not run once installed.** Node refuses to strip TypeScript types for
  files under `node_modules`, so shipping `src/*.ts` meant `npx harnessmeter` failed with
  `Stripping types is currently unsupported for files under node_modules`. The published
  package now ships compiled JavaScript (`dist/`), built by `prepack`.
- Caught by installing the tarball into a clean project before publishing, rather than by
  a user afterwards. CI now packs, installs and runs the tarball on Node 20 and 24, and
  fails if any `.ts` file reaches the published artifact.

### Changed

- Runtime requirement drops to **Node ≥ 20** for the published package. A source checkout
  still runs the TypeScript directly with no build step, which needs Node ≥ 22.18. The
  entry point detects which it is and reports the right minimum.
- Still **zero runtime dependencies**. TypeScript is a dev dependency used only to produce
  the published artifact.

## [Unreleased]

### Planned

- **T3 — natural experiments.** Read `.claude/**` git history as an intervention registry.
  Different repos adopt the same advice on different dates, which is the setting where
  staggered difference-in-differences identifies an effect. Free: it is history, not runs.
- **T4 — field randomisation.** Vary the harness on runs that were going to happen anyway,
  on dead-classified claims only. A randomised trial at zero incremental cost.
- **Patch generator.** Emit the demotion as a reviewable diff rather than a description.
- **Readers for other harnesses.** Codex and Antigravity transcript formats.

## [0.1.0] — 2026-07-27

First release. Reads real transcripts and produces a real report.

### Added

- **Exact billed-token accounting.** Reads `usage` from Claude Code transcripts, including
  the 5-minute / 1-hour cache-write split, so each write is priced at its own multiplier.
- **Cache-weighted pricing.** Reads at `0.1×`, 5m writes at `1.25×`, 1h writes at `2×`.
  Naive tokens-×-turns overstates a stable prefix by ~7× at 34 turns and ~10× at 300.
- **Measured always-on prefix**, decomposed into harness files versus residual (base system
  prompt plus MCP tool schemas, whose size is only knowable at runtime).
- **Claim extraction** from `CLAUDE.md` sections, skills, subagents and MCP servers. A
  skill's always-on tax is its frontmatter description, not its body.
- **Evidence tiers T0 (presence) and T1 (consequence)** — free, local, no model calls.
- **Evidence tier T2 (judgement)** via the local agent CLI, opt-in behind `--t2`. Batched
  twelve claims per call; sends claim text plus shape-only digests; returns `unjudgeable`
  rather than guessing on rules a tool trajectory cannot settle.
- **Lease ledger, dead share, and proposals with receipts** — every proposal carries its
  evidence tier, sample size, class and confidence.
- **Balance line** reporting what the run cost and when it pays for itself.
- **Terminal and self-contained HTML reports**, both theme-aware.
- **Node version guard** — the zero-build approach needs native type stripping (22.18+);
  older versions get an explanation instead of a syntax error.
- Test suite on `node:test`, no test framework dependency.

### Design decisions worth recording

- **Prevention claims are protected by default.** A prevention rule has inverted yield: it
  looks useless precisely because it works. Observational evidence can never condemn one.
- **Prevention detection is deliberately narrow.** An early version matched `avoid`,
  `security` and `don't`, which protected almost every claim and drove dead share to a
  meaningless 1%. It now requires a strong prohibition or a secret-family noun inside a line
  that reads as a rule, and capability definitions are never prevention.
- **The dollar figure is labelled `api-equivalent`, not spend.** On a subscription plan
  nobody paid it.
- **The primary action is demotion, not deletion.** Moving an always-on block to on-demand
  is a large win at near-zero risk. Deletion is the rare case.

[Unreleased]: https://github.com/alebgl77/harnessmeter/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/alebgl77/harnessmeter/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alebgl77/harnessmeter/releases/tag/v0.1.0
