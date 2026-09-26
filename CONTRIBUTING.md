# Contributing

Thanks for looking. This project makes claims about numbers, so the most valuable
contribution is usually **showing that a number is wrong**.

## What is most wanted

**1. Disputed measurements.** If harnessmeter says a claim is ballast and you know it is
load-bearing — or the reverse — that is a bug in the evidence model, not a matter of
opinion. Open a *Measurement dispute* issue. You do not need to share your harness; the
shape of the claim and the verdict is enough to start.

**2. The class inference.** `inferClass()` in [`src/harness.ts`](src/harness.ts) decides
whether a claim is `prevention`, and prevention claims are protected from eviction. It has
to be narrow enough not to cover the whole harness and wide enough to catch a real
prohibition, which makes it the part most likely to misjudge someone else's writing style.
Tests live in [`test/harness.test.ts`](test/harness.test.ts).

**3. The cache arithmetic.** [`src/pricing.ts`](src/pricing.ts) is the project's central
claim. If a multiplier, a TTL rule or a model rate is wrong, everything downstream is
wrong. Pinned in [`test/pricing.test.ts`](test/pricing.test.ts).

**4. Provider coverage.** The source branch parses Claude Code and a documented subset of
Codex sessions. Synthetic fixtures for incomplete usage, duplicated counters, forks and
working-directory boundaries are particularly useful. Read the
[coverage limits](docs/expert-workflow.md#coverage-and-limits) before adding a format;
unsupported fields must remain unknown rather than inheriting another provider's semantics.

**5. Team review.** Baseline portability, budget failures and meaningful instruction-change
comparisons need examples from different repository layouts. Report the tool revision,
provider, working directory relative to the Git root and relevant flags; use a minimal
synthetic reproduction instead of posting private sessions or personal configuration.

## Running it

```sh
node src/cli.ts --static --project-only # needs Node >= 22.18; no transcripts
node --test "test/*.test.ts"
npm ci                                # development tools and compiled build
npm run typecheck
npm run build
```

There is no build step for source execution and **no runtime dependencies**. Node runs the
TypeScript directly. Use `src/cli.ts` when developing: `bin/harnessmeter.js` prefers a
possibly stale `dist/` if one exists. New provider/baseline flags are unreleased source work;
do not assume the published `0.3.0` package implements them. A package release requires
compiled-build and clean-install checks in addition to source tests.
If a change makes `npm install` necessary to *run* the tool, it is the wrong change — please
open an issue first so we can talk about it.

## House rules for the code

- **Measured, estimated and unknown never blur.** Only compatible, validated usage records
  supply measured counts. Incomplete coverage produces a subtotal or unknown value, not a
  measured zero. Character-count sizes and list-price dollars are estimates. If you add a
  number, state its source, scope and availability in both JSON and human-readable output.
- **Never claim a stronger tier than you reached.** Every verdict carries the evidence tier
  that produced it. `unproven` is an acceptable answer; a confident wrong answer is not.
- **Prevention claims stay protected.** A prevention rule looks useless precisely because
  it works, so observational evidence can never condemn it. Do not add a path that evicts
  one.
- **Nothing is applied automatically.** The tool measures and proposes. A human merges.
- **Nothing leaves the machine without being asked.** T0/T1 make no network and no model
  calls at all. T2 spends the user's own quota through their own agent CLI, sends only
  claim text and shape-only digests, and confirms first unless `--yes` is explicit. Claim
  text and the receiving CLI's own context can still be sensitive; preserve the disclosure.
- **A baseline is a footprint contract.** Keep provider/scope checks, relative identities,
  body hashes and totals consistent. Do not imply it captures configuration contents or
  proves behavioral quality. Never regenerate a failing baseline silently.
- **An absent event needs an observable channel.** Static inventory and Codex's incomplete
  skill/code-mode attribution cannot justify absence-based demotions. Positive observations
  do not establish complete telemetry.

## Commits and PRs

Explain *why*, not *what* — the diff already says what. If you fixed a wrong number, say
what it was wrong by. Add or update a test for anything that changes a measurement.

By contributing you agree your work is licensed under the MIT License.
