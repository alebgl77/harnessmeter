# Where harnessmeter fits

Comparison reviewed on **27 September 2026**, using the primary project documentation
linked below. These are documented capabilities, not independently benchmarked accuracy,
speed, adoption or outcome claims. Tools and supported formats change; check their current
documentation before choosing a workflow.

## Direct comparators

| Tool | Documented focus | Relationship to harnessmeter |
|---|---|---|
| [ctxlint](https://github.com/tqakdev/ctxlint) | Agent context linting, per-tool load profiling, stale references, content-hashed CI baselines and compliance review | Closely overlaps context review. Harnessmeter's budgets and local baselines are not unique; its focus includes session-derived evidence, Claude cache accounting and prevention-protected demotions. |
| [agnix](https://github.com/agent-sh/agnix) | Instruction, skill, hook and MCP validation; language-server/editor integrations and fix previews | Useful for configuration validity and editor feedback. Harnessmeter does not replace a configuration linter or provide an LSP. |
| [agenteval](https://github.com/lukasmetzler/agenteval) | Instruction linting, benchmark tasks and comparison of instruction variants | Addresses task-outcome evaluation. Harnessmeter currently inspects files and existing sessions; it does not establish causal improvements through benchmark runs. |

## Adjacent tools

| Tool | Documented focus | Relationship to harnessmeter |
|---|---|---|
| [ccusage](https://ccusage.com/guide/) | Local coding-agent usage, time/session views, cost estimates and JSON | A usage reporting companion. Harnessmeter's claim inventory and footprint gate answer a different question; its provider coverage is narrower. |
| [Promptfoo](https://www.promptfoo.dev/docs/integrations/ci-cd/) | Evaluation suites, quality thresholds, exports and CI integration | Can test task quality after an instruction change. A Harnessmeter token budget alone cannot replace an evaluation gate. |
| [Langfuse](https://langfuse.com/docs/evaluation/overview) | Evaluating live traces and fixed datasets, scores and experiments | Useful for instrumented applications and quality experiments. Harnessmeter's current T0/T1 workflow reads local coding-agent files without a tracing service. |

## The product decision

Harnessmeter aims to make an instruction change reviewable through four linked artifacts:
a scoped inventory, a portable footprint comparison, an explicit account of the evidence
available, and a reversible proposal when the evidence permits one. T0/T1 remain local and
dependency-free; T2 is separately disclosed and uses the user's agent quota. Prevention
rules are protected from observational demotion.

This combination is a positioning hypothesis. It does not establish that Harnessmeter
is better for every team or that smaller instructions improve agent performance. Today its
limits include partial provider loading models, incomplete Codex attribution, no SARIF or
editor integration, and no controlled task-quality experiment. See the
[coverage table](expert-workflow.md#coverage-and-limits) before interpreting a result.

The next useful evidence is repeatable: can a team identify a relevant instruction change,
understand the uncertainty, review a proposal, and preserve task quality? Improvements to
parser coverage and a consented, reproducible evaluation corpus should precede broader
claims. Baselines and budgets make that review practical; they do not prove the outcome.
