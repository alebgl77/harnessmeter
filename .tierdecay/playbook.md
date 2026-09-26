# Repository playbook

Only the main orchestrator updates this file. Patterns capture reviewed decisions, not implementation patches.

## PATTERNS

### PB-1 · add-provider-transcripts
provenance: T3 2026-09 · hits: 0
WHEN: Adding an agent transcript format or changing evidence populations.
DO: Normalize cumulative counters once; cached/reasoning tokens remain subsets of their parent counts.
DO: Keep unknown readings distinct from zero and separate token, prefix, pricing, cache and absence availability.
DO: Namespace evidence by provider/project/date; cap advertised resolution by actual observedIn, including missing evidence.
DO: Never infer absence from incomplete attribution or transplant another provider's cache economics.
VERIFY: Synthetic duplicate/reset/malformed/mixed-provider/date fixtures; core suite and bounded-stream benchmarks; independent contract review.

### PB-2 · add-baseline-governance
provenance: T3 2026-09 · hits: 0
WHEN: Adding snapshots, budgets or another CLI artifact writer.
DO: Validate version, scope, identities, bounded sizes and numeric totals before analysis or model calls.
DO: Store portable identities and content hashes rather than absolute paths or instruction text.
DO: Preflight every active output, implicit privacy file and stale-artifact deletion against inputs, sources and other outputs.
DO: Reject equivalent targets, hardlinks and file/parent collisions before any mutation; retain atomic writes and symlink checks.
VERIFY: Relocated checkout equality, budget boundaries, malformed snapshots and no-mutation collision regressions; isolated package smoke.

## QUARANTINE

None.
