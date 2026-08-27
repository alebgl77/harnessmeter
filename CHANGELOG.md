# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- **T3 — natural experiments.** Partly delivered in 0.2.2, and the rest is further away
  than this entry used to claim. Git now serves as the intervention registry: a claim is
  dated by the commit that last touched its own lines. The causal half — staggered
  difference-in-differences — needs many units adopting the same advice on different dates,
  and that means data across many machines. harnessmeter reads only local files and sends
  nothing anywhere, so the design that would identify the effect is one this tool has
  promised never to enable. What remains reachable on one machine is a before-and-after
  comparison with a placebo check on claims that did not change, reported with its interval
  and its sample. That is worth building when there is history to validate it against.
- **T4 — field randomisation.** Vary the harness on runs that were going to happen anyway,
  on dead-classified claims only. A randomised trial at zero incremental cost.
- **Readers for other harnesses.** Codex and Antigravity transcript formats.

## [0.3.0] — 2026-08-27

The action this project has argued for since its first commit, as a diff you can read.

### Added — `--patch`

The README has called demotion the primary action from the start: a section nothing was
observed to need moves out of the memory file and into a skill, where only its frontmatter
description stays resident and the body loads when something asks for it. Until now the
tool described that move in prose and left the editing to you.

`--patch` writes it as a unified diff. One hunk removes the section, one creates
`.claude/skills/<slug>/SKILL.md` holding the body. It is applied by you, with `git apply` or
`patch -p1`, and `git apply -R` puts everything back — a property the tests pin, because a
proposal you cannot undo is not a proposal.

**The description is the part that matters, and the patch says so before it shows a single
line of diff.** After the move it is the only text the model sees, and it is the entire
mechanism by which the skill ever loads again: one that does not say *when* the rule applies
silences the rule with no error anywhere. What is generated is drafted from your own heading
and opening sentence — a starting point for a judgement only the author can make, and the
tool does not pretend otherwise.

### Refusals, which are most of the design

- **A section that changed since the scan is refused.** The scan is a photograph; patching
  text nobody measured is how a memory file gets corrupted quietly.
- **An existing skill is never overwritten**, and two sections that want the same name do
  not collide — the second is reported, not silently merged.
- **A claim outside the directory the patch applies from is skipped**, so a diff never
  reaches out of its own root. Project and `~/.claude` memory files therefore produce
  separate patches, applied from separate directories.
- Every refusal carries its reason. Nothing is skipped silently.

### Correctness

- Lines are split on the newline byte alone, keeping any carriage return, so the diff is
  byte-identical to the file it was generated from. Splitting on `/\r?\n/` would emit a
  patch that cannot apply to a CRLF memory file — the default on Windows.
- Several removals from one file carry a cumulative offset on the `+` side, and ranges
  close enough for their context to overlap become one hunk.
- Demotion only ever deletes a contiguous block and creates a file, so there is no general
  diff algorithm here and no dependency taken for one. The package still has zero.

### Two defects an adversarial review found before release

Four independent reviewers attacked this, and two of the findings were the exact failure
the module comment names as the stake — a rule deleted from the memory file whose
replacement never loads, with no error anywhere.

- **A project section was emitted into the user patch as well.** The two patches were
  distinguished by asking whether the file sits under the root, and a project normally sits
  *inside* the home directory, so every project section passed both tests. Its skill was
  then written to the machine-wide skills directory, putting one project's rule in every
  other project's always-on prefix. Applying both patches left rejected hunks behind.
  Scope — the field the scanner has always set — is what decides now, and containment is
  only a second guard behind it.
- **A backslash in a section broke the frontmatter it produced.** The description was
  written as a double-quoted YAML scalar, which reads backslash escapes, and a memory file
  is full of them: a regex, a Windows path, an escaped pipe in a table. The result either
  failed to parse — so the skill never loaded, while the same patch had already deleted the
  section — or silently reworded the author. Escaping only the double quote made one case
  worse, turning the legal `\\"` into the illegal `\\'`. Single-quoted scalars have no
  escapes at all.

Also from the review: `--json --patch` silently wrote nothing and now writes the patch and
reports it on stderr; a stale patch from an earlier run is deleted rather than left to
apply cleanly against a verdict that has changed; the user root comes from `claudeHome()`
like everything else rather than from `os.homedir()`; a description is no longer drafted
out of a fenced code block; and the printed command is `git -C <root> apply`, which works
outside a repository and in PowerShell, where `patch -p1 < file` does not.

### Added — tests

- 179 → **200**. `test/patch.test.ts` builds real repositories and runs the real `git apply`:
  a patch that applies and moves the section, two demotions in one file, a CRLF file, a
  section edited since the scan, a claim outside the root, an existing skill, a name
  collision, and an applied demotion reversed back to the original. A diff that looks right
  and does not apply is worse than no diff.
- Both review findings are pinned from the failing side: a project claim offered to the
  user patch, four real backslash cases parsed back with a YAML single-quoted-scalar reader
  written for the purpose, and quotes that would end the scalar early. Reverting either fix
  fails tests.
- Also pinned: three removals from one file carrying the right cumulative offset, a section
  whose body is diff syntax, and a file with no trailing newline patched at either end.

## [0.2.2] — 2026-08-27

Dates a claim from the repository instead of the filesystem, where there is one.

### Added — git as the intervention registry

0.2.1 stopped judging a claim on sessions that predated it, using the file's modification
time. That clock is wrong in three ways it documented and could not fix: it moves when
anything in the file changes, so editing the top of a `CLAUDE.md` re-dates every rule in it
and silently narrows the evidence each one is judged against; a clone or a checkout resets
it; and it says nothing about what the text used to be.

- **A claim is now dated by the commit that last touched its own lines.** Editing one
  section no longer re-dates the others, and the date survives a clone.
- **The report says which clock it used**, because a commit that dates the section and a
  file timestamp that moves for any edit are not the same quality of evidence: *"6 sessions
  predating when this section last changed not counted"* against *"...when the file was
  last written"*.
- **It fails closed.** No git, no repository, a timeout, an unreadable file — the claim
  falls back to modification time and says so. A wrong date is worse than a coarse one,
  because it silently changes which sessions a claim is judged against.
- **It costs nothing worth measuring.** One `git blame --line-porcelain` per file returns the
  commit behind every line at once, about 100 ms, against roughly 70 ms per claim for
  `git log -L` — six seconds on an eighty-claim harness, seven times the whole scan. Only
  prose sections are asked about: a skill is a file, so a per-section date and a per-file
  one are the same answer. A directory already known not to be a repository settles every
  directory beneath it without another process, which matters when a harness holds one
  directory per skill. End to end: 0.85 s before, 0.72 s after.

Most harnesses will see no change. `~/.claude` is rarely a repository, and on the machine
this was written against not one claim is datable by git — 8 of 18 project directories have
a `CLAUDE.md` and one of them is versioned. The feature is for the case that matters
commercially: a team `CLAUDE.md` committed alongside the code it governs.

### Added — tests

- 173 → **179**. `test/history.test.ts` builds real repositories with real commits at fixed
  dates: a section dated by its own commit rather than the file's, an uncommitted edit
  dated to now, a file outside any repository, a missing file, a scan that dates a
  versioned claim by git and an unversioned one by modification time, and a `touch` that
  moves the filesystem clock while the commit stays put. Nothing is mocked, because what is
  under test is whether we read git correctly.

## [0.2.1] — 2026-08-26

Closes the findings the 0.2.0 audit raised but did not act on. No change to the cache
arithmetic or the billing fix; this is about what a verdict is allowed to rest on.

### Changed — a claim is judged on work its own text could have shaped

- **Sessions that finished before a claim's file was last written are no longer counted
  against it.** A rule rewritten yesterday was not in force last month, so last month's
  sessions were never chances for it to fire — counting them turned an edit into evidence
  of uselessness. On the corpus this was measured against, 28 of 86 claims had older
  sessions set aside.
- The verdict says so: *"never observed across 6 sessions — rules out a rate above 39%;
  30 older sessions not counted"*. A claim whose file postdates every session read reports
  `unproven` and names the file, rather than reporting a confident nothing.
- Modification time is a coarse clock — it moves for a change anywhere in the file, and a
  fresh clone resets it. It is used because it errs the safe way: it can only shrink the
  evidence a claim is judged on, never invent any. A session with no timestamp is never
  excluded, because an unknown date is not evidence of an old one.

### Changed — the resolution notice quotes the sample it was computed over

Under `--all` the floor is computed over the sessions that judge *project* claims, which is
a smaller number than the scan read. The reports printed the larger one beside it, which
advertised a precision most of the ledger does not have. They now print both: *"4 of 32
sessions judge this project"*.

### Added

- **An enabled plugin's MCP servers are claims.** A plugin can contribute a server and
  nothing else — the `github` plugin does exactly that — and its tool schemas are resident
  on every turn. Deliberately not qualified by plugin name: a transcript records
  `mcp__github__*` and cannot say whether the server came from a plugin or from the
  project's own `.mcp.json`, so two claims would mean two ids and one of them permanently
  unmatchable.
- The rare-fire threshold that separates `load-bearing` from `unproven` is named,
  explained and pinned from both sides. It was reachable but untested, and could have
  drifted by a factor of twenty-five without a single test noticing.

### Added — tests

- 166 → **173**: claim age from four directions (older sessions excluded, a file newer than
  every session, an undated session, an unknown edit time), the rare-fire threshold either
  side of its boundary, the scoped resolution line, and a plugin whose only contribution is
  an MCP server.

## [0.2.0] — 2026-08-26

An audit of the measurement itself, and it found the instrument out of true. **Every number
harnessmeter has ever printed was affected**, so re-run any earlier analysis before acting
on it, and discount any figure quoted from 0.1.x entirely.

### Fixed — one API response was being billed several times

- **A single assistant response is written to the transcript as several JSONL entries** —
  one per content block: thinking, then text, then one per tool call — and every one of
  them carries a **copy** of the same `message.usage`. The reader counted each entry as a turn,
  so the same bill was added two to five times over.
- On this machine's corpus that is 19,663 entries for 9,064 responses. Measured before and
  after the fix: turn counts were **2.2× too high**, and `api-equivalent` was **2.4× too
  high** — $7,515 became $3,205 across the same 32 sessions. Median turns per session went
  from 362 to 154.
- The tool's whole claim is that it reads billed counts instead of estimating them. It was
  reading them correctly and then adding them up wrong, which is worse than estimating,
  because the result looked exact. This shipped in every version from 0.1.0.
- Responses are now folded by `message.id`, falling back to `requestId`. The usage is taken
  once; the tool calls, which genuinely are spread across the entries, are merged into the
  single turn so no T1 evidence is lost.

### Fixed — the default invocation could not find its own project

- **`npx harnessmeter` reported "no transcripts found" in projects that had them.** Claude
  Code names a project directory by replacing every non-alphanumeric character with a dash
  and keeping the runs, so a drive letter and a separator each contribute one: the two
  characters after `C` become two dashes. The encoder collapsed those runs,
  so it matched **none** of the directories on a Windows machine, and none containing a dot
  segment on any platform. Only `--all` worked. Checked against every project directory on
  a real machine: 0 of 18 matched before, 18 of 18 after.
- **The test could not have caught it.** It built its fixture directory by calling the
  encoder, so the code and its test shared the assumption and agreed with each other; a
  second test asserted the wrong constant as the specification. Both now use directory
  names transcribed from `~/.claude/projects`.
- **A run from a subdirectory resolves to the project that owns it**, by walking parents.
  The old suffix-matching fallback is gone: it could silently return a different project's
  sessions, which is worse than returning none.

### Changed — the cache model is measured, not assumed

- **Prefix writes are counted per session.** The write-once-then-read model is wrong: a
  cache entry expires with its TTL, and compaction or any edit to a harness file
  invalidates it. The median session in the corpus this was tested against writes its
  prefix **six times**, not once.
- **A turn is judged cold by comparing it against itself**, not against the first turn's
  prompt size. That size is an upper bound on the resident prefix — it also contains the
  opening user message — so counting against it made the result swing with the bound's
  error rather than with the cache: scaling it by half moved the corpus median from seven
  writes to one. On a warm turn the prompt is read back out of cache and only the new tail
  is written; on a cold turn there is nothing to read and the whole prompt is written.
  That inequality needs no yardstick.
- **The TTL is read off the session** instead of defaulting to 5 minutes. On that same
  corpus **99.7%** of cache-write tokens use the 1-hour TTL, which bills at `2×`, not
  `1.25×`, and all 32 sessions classify as 1-hour.
- Together these were understating a resident block by **1.1× to 2.5×** across the 27
  sessions long enough to measure. It is not a constant, which is why the report prints the
  write count and the TTL it used rather than applying a fixed correction factor: at the
  corpus median of 154 turns and 6 writes at the 1-hour rate, a resident token costs 26.8×
  its own size, against the 16.6× the write-once model gives.

### Changed — silence is weighed before it becomes a verdict

- **`ballast` now requires a sample that can support it.** A claim that never fired used to
  be called dead on any sample, including one session — which is consistent with a rule
  that fires 95% of the time. The threshold is the rule of three: a zero-observation result
  reports `unproven` until the 95% upper bound on its firing rate drops below 50%, which
  takes five sessions in scope.
- **Every zero-observation verdict states its bound** — "rules out a rate above 9%" —
  and proposal confidence is derived from that bound instead of a round session count.
- **The report says when a scan is too thin to conclude anything.** A quiet corpus and a
  clean harness both produce 0% dead share; only one of them means your harness is fine.

### Added — the rest of the harness

- **Plugin skills, subagents and commands are scanned — the installed ones only.** Every
  installed plugin skill puts its description in the always-on listing, and none of them
  were being attributed to a file. The plugin directory also holds `marketplaces/`, a
  catalogue of everything on offer: on the machine this was written against, pricing that
  tree would have added 112 claims and 5,005 tokens of context the model never sees, which
  is precisely the error this tool exists to correct. `installed_plugins.json` is the only
  source of truth, a plugin switched off in settings costs nothing, and no manifest yields
  no claims rather than a guess.
- **Slash commands** are claims, priced like skills: the frontmatter description is
  resident, the body is not. They report `unproven` rather than a verdict, because an
  invocation lives in the user's message and harnessmeter reads counts, never content.
- **`CLAUDE.local.md` and `@`-imported files are scanned.** An imported file is resident
  exactly like the text around the import line. Cycles terminate; a bare `@mention` that
  resolves to no file is not an import.
- **The checkable tool vocabulary is derived from the transcripts**, so a rule naming an MCP
  or plugin tool is now testable at T1. The hardcoded list could never contain
  `mcp__server__tool`, which made every MCP rule silently unverifiable.

### Fixed

- **A `#` inside a fenced code block is no longer read as a heading.** Any CLAUDE.md
  documenting a shell workflow was being shredded into sections named after comments, which
  were then priced, classified and proposed for demotion.
- **Claim ids no longer embed a line number**, so editing one part of a file does not turn
  every claim below it into a new claim. Longitudinal tracking depends on this.
- **Local `<synthetic>` turns are priced at zero instead of counted as an unpriced model.**
  They carry all-zero usage, and listing them stamped an "estimated" caveat on a figure
  that was exact.
- **Two claims can no longer share an id.** A file imported by both `CLAUDE.md` and
  `CLAUDE.local.md` was scanned twice, which double-counted its tokens while the evidence
  map — keyed by id — kept only one verdict. Imports are now tracked across every root, and
  the id invariant is enforced rather than assumed.
- **A degenerate first turn no longer inflates the write count.** The first turn is the
  yardstick for the resident prefix; if it errored or was truncated, nearly every later
  turn looked like a re-write. Below a real prefix the count is left at one, which is the
  conservative answer rather than an invented one.
- `hook` and `output-style` claim kinds were declared but never produced. A hook is a shell
  command rather than a block of context, so it is not a lease; the type now describes what
  the scanner actually emits.

### Fixed — verdicts that rested on the wrong evidence

- **A rule naming a specific skill is no longer confirmed by the generic `Skill` tool.**
  "Use the graphify skill" names `Skill`, and so does every other skill invocation in the
  corpus, so the rule came back load-bearing whenever the user had invoked any skill at
  all. `Task` and `Agent` had the same problem for subagents. Which skill actually ran is
  answerable from the attribution fields — which the skill and subagent claim kinds already
  use — and not from the tool name, so these three names are no longer admitted as evidence.
- **An ambiguous bare skill name is credited to nobody.** A plugin skill is labelled
  `plugin:name` and attribution may record either form, so the bare name is a useful
  fallback — but only while one skill answers to it. When a personal skill and a plugin
  skill share it, either one's use was being credited to the other.
- **Slash commands left the dead-share denominator.** They can never be ruled against —
  an invocation lives in the user's message, which harnessmeter does not read — so counting
  them as attributable context quietly shrank the dead share by however many commands were
  installed.
- **The resolution figure follows the weakest population, not the largest.** Under `--all`
  a project claim is judged only against its own project's sessions, and the report was
  quoting the whole corpus.
- **The thin-sample notice says which tier it is about.** With `--t2` a report could print
  a dead share and "too thin to condemn anything" side by side; T2 reads the trajectory
  rather than counting silences, so its verdicts stand on their own.
- **A ratio below 1 is no longer printed as "cheaper".** Enough writes relative to turns and
  caching stops being a discount; "0.9× cheaper" is a wrong word, not a small number.

### Fixed — what the scanner reads

- **An import is followed only to a prose file, and only up to half a megabyte.** A claim
  body is what `--t2` sends to a model, and its byte length becomes a token figure —
  following whatever path a memory file happens to name is how a private key ends up in
  both. Claude Code follows these imports too; the difference is what harnessmeter then
  does with the content.
- **A file imported by two memory files is resident once.** It was being read and priced
  twice, because the guard only stopped re-entry, not re-extraction.
- **Slash commands filed into subdirectories are found**, and namespaced by folder the way
  Claude Code names them: `commands/git/sync.md` is `git:sync`.
- **An enabled plugin's MCP server appears in the ledger.** Its schemas are the most
  expensive kind of always-on context there is; only the project and user configs were
  being read.
- **Project matching is bounded and case-honest.** The parent walk stops at the home
  directory, so a project registered for a high ancestor no longer answers for every
  unrelated repository beneath it; case folding is a fallback rather than the key, because
  on a case-sensitive filesystem two differently-cased paths are two directories; and a
  directory name long enough for Claude Code to shorten is matched on the part we can
  reproduce, accepted only when exactly one candidate starts with it.

### Performance — the scan is 3.5× faster

Measured on this machine's corpus, 32 transcripts and 397 MB: **2.96 s end to end before,
0.85 s after**, with the reader's output verified turn for turn identical across 31 sessions
and 8,640 turns. The scan was 95% of the run, so this is very nearly all of it.

- **The reader works in bytes and decodes only what matters.** UTF-8 decoding 397 MB to find
  the 36 MB of assistant entries inside it was most of what a scan spent its time on. Line
  boundaries are found by scanning for the newline byte — which cannot occur inside a
  multi-byte character — and a line is decoded only once its markers have been found in the
  raw bytes.
- **A long line is searched by its head, not end to end.** Searching every byte for the two
  markers cost more than reading the files off disk: 675 ms against 193 ms. An assistant
  entry declares itself in its own preamble — across the whole corpus `"assistant"` never
  appears later than byte 170 of such a line — so a kilobyte gives six times the margin
  needed, and what lies past it is payload that cannot change what the line is. Lines up to
  8 KB are still searched whole, which covers a small standalone marker record and costs
  nothing: short lines are most of the count and a rounding error of the bytes.
- **The pre-filter no longer waits for the working directory.** It only applied once both
  `cwd` and `gitBranch` were known, so a session in a directory that is not a git
  repository — where `gitBranch` never arrives — parsed every line of every payload for the
  length of the file. Both fields are present on assistant entries, so the filter applies
  from the first line.

### Known limits

- **The denominator is sessions read, not opportunities.** A claim that never fired is
  measured against every session in scope, including ones that predate it and ones where
  the subject never came up. The bound is therefore an upper bound on its load rate *among
  the sessions scanned*, which is what the report says — but it is not the same as the rate
  among sessions where it could have applied. Distinguishing the two is what T3 is for.

### Documentation

- The README and the cache-math diagram described the write-once model as the correct
  arithmetic. Both now show three figures — tokens × turns, written once, and measured —
  and the tests pin all three.
- The README claimed MCP tool schemas dominate the unattributed remainder. The tool has
  refused to make that claim since 0.1.3, on the grounds that no breakdown has been
  measured; the README now agrees with it.
- The README promised a receipt carrying a confidence interval and an estimated risk of
  removal. Neither existed. The receipt now carries the 95% bound, and the risk estimate —
  which is not implemented — is no longer advertised.
- `pricing.ts`'s own header still taught the write-once model that the file no longer
  implements, and quoted the retired 7× figure.

### Added — tests

- 82 → **164**. New coverage for project-directory matching against real directory names,
  measured prefix writes and TTL, the rule-of-three threshold and the bounds it reports,
  fenced-code headings, id stability, imports and cycles, plugin surfaces, the derived tool
  vocabulary, the manifest-driven plugin scan and the catalogue it refuses to price, the
  resolution notice in both reports, response folding, generic dispatchers, ambiguous skill
  names, import type and size limits, and namespaced commands.
- The project-matching tests used a Windows path on every platform, so two of them would
  have failed on the Linux and macOS legs of CI. They now build a path that is absolute on
  the platform running them, with its encoding still written out by hand on both sides.
- `test/analyze.test.ts` is new. Nothing imported `analyze` before, so every aggregate this
  release exists to produce — the measured write count, the TTL, the resolution floor, and
  the write-aware saving on every proposal — could have been reverted to its pre-0.2.0 form
  with a green suite.
- Several existing tests were verifying the wrong thing and are rewritten: the claim-id
  test put both fixtures' headings on the same line, so it passed under exactly the
  line-numbered id scheme it exists to forbid; the basename-collision test handed
  `extractProseClaims` its own shared map instead of driving `scanHarness`, so the wiring was
  invisible; and `test/cli.test.ts` still named its fixture directory by calling `encodeCwd` —
  the same shared-assumption pattern that let the encoder bug ship. Writing that test's
  copy of the rule out separately exposed an import chain that was stopping one level short
  of its documented depth.
- `test/report.test.ts` contained a literal NUL byte, so git classified it as binary and its
  assertions could not be read in a diff. The control characters are built from char codes.
- The reader's byte-level decisions are pinned from both sides: a two-megabyte assistant
  entry is still read, a short attribution record is read wherever its field sits, a payload
  that merely mentions the markers contributes nothing, a line straddling two stream chunks
  is rejoined before it is decoded, and multi-byte characters survive the split.

## [0.1.5] — 2026-08-23

**Never released on its own.** This work reached npm inside 0.2.0, so there is no `v0.1.5`
tag and no 0.1.5 on the registry. The entry is kept because the changes are real and 0.2.0's
own performance section builds directly on them.

Scan performance. No change to what the tool measures or reports: the buffered and
streaming readers were verified turn-for-turn identical on frozen transcript data
before shipping.

### Changed

- **A full `--all` scan is about twice as fast.** Measured on a real corpus of
  779 transcripts / 631 MB: 4.1 s before, 2.2 s after, sessions and turns identical.
  Three independent changes, each measured before it was kept:
  - **Transcripts up to 8 MB are read in one call and split**, replacing readline's
    per-line event machinery on the path that handles the median (197 KB) and the
    p95 (1.4 MB) file alike. Larger files stay streamed so memory remains bounded.
  - **The streaming path splits chunks manually** instead of going through readline —
    same bounded memory (one 1 MB chunk plus the longest pending line), a fraction of
    the per-line overhead. A 126 MB transcript drops from 0.91 s to 0.81 s.
  - **Independent transcripts are read through a bounded pool** (8 in flight) instead
    of strictly one after another. Order stays newest-first: results land by index.
- **Lines that cannot contribute are skipped before `JSON.parse`.** Once `cwd` and
  `gitBranch` are known, only assistant turns and attribution markers can still matter,
  and both necessarily contain a literal substring the filter checks. Over-approximation
  only — a prose mention of "assistant" costs one wasted parse, never a lost turn.

## [0.1.4] — 2026-07-28

Release-pipeline hardening. No change to what the tool measures or reports.

### Security

- **No GitHub expression is interpolated into a shell block.** `${{ }}` is substituted
  textually before the shell parses the line, so a dispatch input — or a tag name, which may
  legally contain shell metacharacters — became executable text. Every such value now
  crosses into the shell through `env:` and is read as a quoted variable.
- **A dispatch version is validated on the whole string, not line by line.** `grep` matches
  per line, so `0.1.3` followed by a newline and arbitrary text passes a semver grep on its
  first line and writes a second line into `GITHUB_OUTPUT`. A character-class guard runs
  first and sees the value whole.
- **The published tarball is checked against a digest recorded at verification time**, so
  "the artifact that was tested is the artifact that shipped" is verified rather than
  assumed.
- **The checked-out commit must be the tag**, not merely a commit on which the tag exists.

### Added

- `test/release-workflow.test.ts` — reads the shipped YAML and asserts its invariants:
  no expression inside any `run:` body, the version guard's accept and reject sets
  (including the multi-line case), tag-only publishing, digest-before-publish ordering,
  every action pinned to a full commit SHA, and no environment on the publish job. It
  exercises the guard the workflow actually contains rather than a copy of it. 82 tests.
- CI fails if `package-lock.json` is out of sync with `package.json`.

### Fixed

- A comment in `src/cli.ts` still described the agent CLI as always spawning through a
  shell on Windows, which stopped being true in 0.1.3.

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

[Unreleased]: https://github.com/alebgl77/harnessmeter/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/alebgl77/harnessmeter/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/alebgl77/harnessmeter/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/alebgl77/harnessmeter/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/alebgl77/harnessmeter/compare/v0.1.4...v0.2.0
[0.1.5]: https://github.com/alebgl77/harnessmeter/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/alebgl77/harnessmeter/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/alebgl77/harnessmeter/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/alebgl77/harnessmeter/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/alebgl77/harnessmeter/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alebgl77/harnessmeter/releases/tag/v0.1.0
