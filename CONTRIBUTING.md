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

**4. Other harnesses.** Support for Codex and Antigravity is structural — harnessmeter
only ever talks to a local agent CLI — but only Claude Code transcripts are parsed today.
A reader for another format is a well-scoped contribution.

## Running it

```sh
node bin/harnessmeter.js --all      # needs Node >= 22.18
node --test "test/*.test.ts"
npx tsc --noEmit                    # after: npm i --no-save typescript @types/node
```

There is no build step and **no runtime dependencies**. Node runs the TypeScript directly.
If a change makes `npm install` necessary to *run* the tool, it is the wrong change — please
open an issue first so we can talk about it.

## House rules for the code

- **Exact and estimated never blur.** Anything read from a transcript is exact. Anything
  derived from character counts is an estimate and must be labelled as one everywhere it
  surfaces. If you add a number, say which it is.
- **Never claim a stronger tier than you reached.** Every verdict carries the evidence tier
  that produced it. `unproven` is an acceptable answer; a confident wrong answer is not.
- **Prevention claims stay protected.** A prevention rule looks useless precisely because
  it works, so observational evidence can never condemn it. Do not add a path that evicts
  one.
- **Nothing is applied automatically.** The tool measures and proposes. A human merges.
- **Nothing leaves the machine without being asked.** T0/T1 make no network and no model
  calls at all. T2 spends the user's own quota through their own agent CLI, sends only
  claim text and shape-only digests, and confirms first.

## Commits and PRs

Explain *why*, not *what* — the diff already says what. If you fixed a wrong number, say
what it was wrong by. Add or update a test for anything that changes a measurement.

By contributing you agree your work is licensed under the MIT License.
