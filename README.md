<p align="center">
  <img src="assets/banner.svg" alt="harnessmeter" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/harnessmeter"><img src="https://img.shields.io/npm/v/harnessmeter?style=flat-square&color=E0A93B&label=npm" alt="npm"></a>
  <a href="https://github.com/alebgl77/harnessmeter/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/alebgl77/harnessmeter/ci.yml?branch=main&style=flat-square&label=ci" alt="ci"></a>
  <img src="https://img.shields.io/badge/status-early-B8873B?style=flat-square" alt="status: early">
  <img src="https://img.shields.io/node/v/harnessmeter?style=flat-square&color=4E9A6B&label=node" alt="node">
  <img src="https://img.shields.io/badge/license-MIT-4E9A6B?style=flat-square" alt="license: MIT">
  <img src="https://img.shields.io/badge/dependencies-0-4E9A6B?style=flat-square" alt="zero dependencies">
  <img src="https://img.shields.io/badge/api_keys-zero-4E9A6B?style=flat-square" alt="zero api keys">
  <img src="https://img.shields.io/badge/network-none-4E9A6B?style=flat-square" alt="no network">
</p>

---

You have 4,000 lines of `CLAUDE.md`, twelve subagents, eight MCP servers, and **zero tests**.
Someone edits one line and the behaviour of your whole team shifts, silently.

We have profilers for CPU, memory, SQL, and JS bundles. We have **none for context** — the
scarcest resource in agentic engineering. Every token of your harness is loaded on *every
turn*, of *every session*, of *every developer*. Nobody can tell you which lines pay for
themselves.

`harnessmeter` prices them.

## The frame

**Your context window is a commons with no rent.** Every instruction occupies space for
free, forever, regardless of what it produces. Two things follow, and you've felt both:

- `CLAUDE.md` only ever grows.
- At 4,000 lines, nobody dares delete anything, because nobody can prove what's load-bearing.

So we give every block a **lease**: a measured price, a measured yield, and a renewal that
has to be earned.

## Run it

```sh
npx harnessmeter          # this project
npx harnessmeter --all    # every project on this machine
npx harnessmeter --patch  # write the demotions as a diff you can read
npx harnessmeter --t2     # escalate the unproven claims (see below)
```

Requires Node ≥ 20 and has **no runtime dependencies at all**. It reads
`~/.claude/projects/**/*.jsonl` and your harness files, writes `.harnessmeter/report.html`,
and touches nothing else.

<sub>The published package ships compiled JavaScript, because Node refuses to strip types
under <code>node_modules</code>. A source checkout has no build step — Node runs the
TypeScript directly — which needs Node ≥ 22.18.</sub>

## What it shows

<p align="center">
  <img src="assets/report.svg" alt="Example harnessmeter report" width="100%">
</p>

<p align="center"><sub>Illustrative output. Not a real measurement.</sub></p>

## The arithmetic everyone gets wrong

Every "your CLAUDE.md costs you $X" post multiplies tokens by turns. That ignores prompt
caching, and it overstates an always-on block by roughly **5×**.

<p align="center">
  <img src="assets/cache-math.svg" alt="Naive vs cache-weighted token accounting" width="100%">
</p>

A cached prefix is billed as a write at `1.25×` (5-minute TTL) or `2×` (1-hour TTL), and
as reads at `0.1×` in between. Getting this right is the whole point: an instrument that
inflates its own findings is not an instrument.

The tempting next step is to assume one write per session. That is also wrong, and
harnessmeter does not assume it — it **counts** the writes. A cache entry expires with its
TTL, and compaction or any edit to a harness file invalidates it, so a long session pays
the write multiplier again and again. On the corpus this was measured against, the median
session writes its prefix **six times**, at the 1-hour rate. Pricing it as one write at the
5-minute rate understates a resident block by 1.1× to 2.5×, depending on how long your
sessions run and how often they go cold — so harnessmeter prints the write count and the
TTL it measured rather than applying a fixed correction factor.

It also moves the headline metric off dollars. The dominant cost of a bloated harness is
**attention dilution and window consumed**, not the invoice. So harnessmeter reports
**context share** and **dead share** first, and money second.

And it surfaces results you would not have guessed:

- A 200-token always-on rule can cost more than a 3,000-token skill that loads 2% of the
  time. Residency beats size.
- A skill's real always-on tax is its **frontmatter description**, not its body — the body
  only loads on use. Pricing the whole file overstates it by an order of magnitude.
- On the setups measured so far, `CLAUDE.md` is a **minority** of the always-on prefix —
  the skill descriptions sitting beside it outweigh it roughly two to one. The file
  everyone argues about is rarely the expensive one.
- Most of the prefix is still **unattributed**, and harnessmeter reports it as exactly that.
  Claude Code's own system prompt and your MCP tool schemas are in there, but their sizes
  are only knowable at runtime, so no breakdown is printed. Naming a culprit we have not
  measured would be the same mistake as the tokens-×-turns figure above.

## How it measures

"Is this line load-bearing?" is not directly observable. So evidence is **tiered**, and the
tier reached is always printed next to the claim. Measurement budget is spent only where
the decision is actually uncertain.

```mermaid
flowchart LR
    T0["<b>T0 · Presence</b><br/>is it even loaded?<br/><i>free · shipped</i>"]
    T1["<b>T1 · Consequence</b><br/>mechanical footprint<br/>in the trajectory<br/><i>free · shipped</i>"]
    T2["<b>T2 · Judgement</b><br/>trajectory review by<br/>your local agent<br/><i>your own quota · shipped</i>"]
    T3["<b>T3 · Natural experiment</b><br/>staggered adoption in<br/>harness git history<br/><i>free · planned</i>"]
    T4["<b>T4 · Field randomisation</b><br/>vary the harness on runs<br/>that were happening anyway<br/><i>zero incremental · planned</i>"]

    T0 -->|"uncertain"| T1 -->|"uncertain"| T2 -->|"uncertain"| T3 -->|"uncertain"| T4
```

### T2, and what it costs

T0 and T1 are free but blunt: they can only rule on claims with a mechanically observable
footprint. Everything else comes back `unproven` — honest, but not useful. `--t2` escalates
exactly those, and only those.

It shells out to the agent CLI you already have (`claude`, `codex`) and spends **your own
quota** — harnessmeter never holds an API key. It sends the claim text plus a **shape-only
digest** of sampled sessions: turn counts and tool-call tallies. No message content, no file
contents, no paths. You are asked to confirm before anything is sent.

That bound is deliberate, and it bounds what T2 may claim: a rule about tone or wording
cannot be judged from a tool trajectory, so it returns **`unjudgeable`** rather than a
guess. A wrong "complied" is worse than an honest "I can't tell".

Calls are batched hard — one call judging twelve claims, never twelve calls. On a loaded
setup a single headless invocation costs about **$0.11 before it does anything**, because it
pays the full always-on prefix. That measurement is itself an argument for the tool.

T2 distinguishes two failures that look alike and are not: a rule **nothing needed** wants
demoting; a rule **the agent ignored** wants rewriting. The report never conflates them.

The balance line reports what the run cost and how long it takes to pay for itself, so the
"net-negative by construction" claim can be audited rather than believed.

Two more design notes worth stating plainly:

**History is the control arm.** Classical ablation pays for both arms. But the "with the
rule" arm already exists — it's in your session transcripts. We only pay for the
counterfactual. Half the cost, and perfect pairing, because it is literally the same task.

**Your `git log` is an experiment log.** A claim is dated by the commit that last touched
its own lines, so a rule rewritten yesterday is not judged on last month's sessions. That
much ships today. Turning it into a *causal* estimate needs many repositories adopting the
same advice on different dates — see the roadmap for why this tool will not be the thing
that collects them.

## What it proposes

The primary action is **not deletion — it's demotion.** A section nothing was observed to
need moves out of your memory file and into a skill, where only its frontmatter description
stays resident and the body loads when something asks for it.

`--patch` writes that move as a unified diff and applies nothing:

```sh
npx harnessmeter --patch
#   patch   .harnessmeter/demote.patch  1 demotion from this project — ~4,820 eff tok/session
#           review it, then: git -C "/path/to/project" apply ".../demote.patch"
```

```diff
 # Testing
 Always run npm test before committing, and never skip the suite.

-# Legacy migration notes
-The old v1 API used snake_case for every field name, and the migration
-script in tools/migrate.py rewrote them on read. That script was removed
-in 2024 and nothing depends on it any more.
+++ b/.claude/skills/legacy-migration-notes/SKILL.md
+---
+name: legacy-migration-notes
+description: "Use when working on legacy migration notes. The old v1 API used snake_case…"
+---
```

**Read the description before applying.** After the move it is the only part the model
sees, and it is the entire mechanism by which the skill loads again — a description that
does not say *when* the rule matters will silence the rule with no error anywhere. What the
tool drafts comes from your own heading and opening sentence: a starting point, not a
decision. The patch says so at the top, above the diff.

`git apply -R` puts everything back — the tests pin that, because a proposal you cannot
undo is not a proposal. Your project's memory file and your user one produce **separate
patches**, applied from separate directories: a project rule demoted into the machine-wide
skills directory would sit in the always-on prefix of every other project, which is the
opposite of what this tool measures.

Deletion is the rare case.

Every proposal ships with a **receipt**: cost, measured yield, evidence tier, the sessions
that justify it, and — for a claim that never fired — the 95% upper bound on how often it
really could have. A market you can't audit will never survive code review.

## Prevention rules are protected

**A prevention rule has inverted yield: it looks useless precisely because it works.**
"Never commit a secret" will show a near-zero firing rate. A tool that proposes evicting it
deserves to be torn apart.

So claims carry a class. `prevention` claims are **protected by default**, excluded from
eviction on observational yield, and testable only by explicit adversarial probing. This is
a structural guarantee, not a promise.

## Principles

| | |
|---|---|
| **Net-negative by construction** | A cost profiler that costs money to run is incoherent. It prints its own balance. |
| **Zero API keys** | harnessmeter never authenticates to a model provider. Judgement work is delegated to the agent CLI you already have. |
| **Stack-agnostic by consequence** | Because it only ever talks to your local agent, Claude Code / Codex / Antigravity are the same code path. |
| **Local by default** | Reads transcripts and config on disk. No network. Contributing aggregates is opt-in and numeric only — never prompt text, filenames, or repo identifiers. |
| **Never applies on its own** | It measures and emits a diff. A human merges. |

## Status

**Early, and honest about it.** The tool runs and produces a real report from real
transcripts. What ships today is:

- exact billed-token accounting, including the 5m/1h cache-write split
- measured always-on prefix, decomposed into harness files vs. residual
- claim extraction from `CLAUDE.md`, skills, subagents, MCP servers
- evidence tiers **T0** (presence), **T1** (consequence) and **T2** (judgement via your own agent)
- lease ledger, dead share, demotion proposals with receipts, terminal + HTML report
- `--patch`: the demotion as a reviewable, reversible diff — nothing is ever applied
- a balance line that reports what the run cost and when it pays for itself

Not yet: **T4** field randomisation, and the causal half of **T3**. Git history now dates
each claim by the commit that last touched its own lines, which is the intervention
registry a natural experiment needs — but identifying an *effect* by staggered
difference-in-differences takes many machines adopting the same advice on different dates,
and this tool reads only local files and sends nothing anywhere. That design is one the
project has promised never to enable, and the roadmap says so rather than implying
otherwise.

Per-claim token counts are calibrated estimates at ~3.8 chars/token and are labelled as
estimates everywhere they appear; session-level figures are exact.

The measurement protocol for the higher tiers will be **pre-registered and published before
any results are**.

Issues and design critique very welcome — especially on the evidence model and on the
class inference, which is the part most likely to be wrong on someone else's harness.

## Project

| | |
|---|---|
| [CONTRIBUTING](CONTRIBUTING.md) | What is most wanted, house rules, how to run the tests |
| [Measurement dispute](https://github.com/alebgl77/harnessmeter/issues/new?template=measurement_dispute.yml) | The tool gave a verdict you believe is wrong — the most useful issue you can file |
| [SECURITY](SECURITY.md) | Exactly what it reads, writes and sends; how to report privately |
| [CHANGELOG](CHANGELOG.md) | What shipped, and the design decisions behind it |
| [Discussions](https://github.com/alebgl77/harnessmeter/discussions) | Arguments about how yield *should* be measured |

Development:

```sh
node bin/harnessmeter.js --all   # runs the TypeScript directly, no build
node --test "test/*.test.ts"     # no test framework — node:test
npm run typecheck                # tsc --noEmit
npm run build                    # only needed to produce the publishable package
```

CI runs the suite on Node 22.18 and 24 across Linux, macOS and Windows **with no install
step** — if that job ever needs `npm install` to run the tests, the zero-dependency claim
has broken and the build says so. A separate job packs the tarball, installs it into a
clean project and runs it, because a package that works from a checkout and fails from
`node_modules` is the failure mode that matters.

## License

MIT
