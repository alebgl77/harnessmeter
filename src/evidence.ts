/**
 * Evidence tiers T0 and T1 — the free ones.
 *
 *   T0 Presence     was the claim ever loaded at all?
 *   T1 Consequence  did it leave a mechanical footprint in the trajectory?
 *
 * Higher tiers (T2 judgement, T3 natural experiments, T4 field randomisation) are not in
 * this release. Every claim reports the tier actually reached, so nothing is ever
 * presented as stronger evidence than it is.
 *
 * Escalation rule: measurement effort is spent only where the decision is uncertain.
 * A claim that is obviously live or obviously dead stops at T0.
 */

import type { Claim, ClaimEvidence, Session, Verdict } from './types.ts';

/**
 * Tool names a rule can be checked against.
 *
 * This seed exists only so a rule naming a tool the user has never invoked is still
 * checkable. The working vocabulary is built from the tool names the transcripts actually
 * contain, so it covers MCP tools, plugin tools and whatever ships next without anyone
 * editing this list — a hardcoded list goes stale the week after it is written, and a
 * stale list silently downgrades checkable rules to "no consequence to look for".
 */
const TOOL_VOCAB_SEED = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'NotebookEdit', 'PowerShell', 'ToolSearch',
];

/**
 * Dispatchers that say nothing about WHICH thing was dispatched.
 *
 * A rule like "always use the graphify skill" names `Skill`, and every skill invocation in
 * the corpus is also `Skill` — so the rule comes back load-bearing whenever the user
 * invoked any skill at all. The same goes for `Task`/`Agent` and subagents. Whether that
 * particular skill ran is answerable from the attribution fields, which is what the skill
 * and subagent claim kinds already use; it is not answerable from the tool name, so these
 * names are not admitted as evidence.
 */
const GENERIC_DISPATCH = new Set(['Task', 'Agent', 'Skill']);

type ToolWord = { name: string; re: RegExp };

type SessionFact = {
  session: Session;
  project: string;
  endedMs: number;
  tools: ReadonlySet<string>;
  commandMask: number;
  skills: ReadonlySet<string>;
  mcpServers: ReadonlySet<string>;
  subagents: ReadonlySet<string>;
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m);
}

/** Every tool name seen in the corpus, plus the seed, compiled once per run. */
function buildVocab(facts: SessionFact[]): ToolWord[] {
  const names = new Set<string>(TOOL_VOCAB_SEED);
  for (const fact of facts) for (const name of fact.tools) names.add(name);
  return [...names]
    .filter((n) => n.length >= 3 && n.length <= 120 && !GENERIC_DISPATCH.has(n))
    .map((name) => ({
      name,
      // `_` is a word character, so \b would not separate mcp__x__y from mcp__x__yz.
      re: new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(name)}([^A-Za-z0-9_]|$)`),
    }));
}

/** Commands a rule may prescribe, and the probe that looks for them in a shell trace. */
const COMMAND_PATTERNS: { re: RegExp; probe: RegExp }[] = [
  { re: /\bpytest\b/i, probe: /\bpytest\b/i },
  { re: /\bnpm (run )?test\b/i, probe: /\bnpm (run )?test\b/i },
  { re: /\bnpm run build\b/i, probe: /\bnpm run build\b/i },
  { re: /\btsc\b/i, probe: /\btsc\b/i },
  { re: /\beslint\b/i, probe: /\beslint\b/i },
  { re: /\bprettier\b/i, probe: /\bprettier\b/i },
  { re: /\bruff\b/i, probe: /\bruff\b/i },
  { re: /\bgit commit\b/i, probe: /\bgit commit\b/i },
  { re: /\bcargo (test|build)\b/i, probe: /\bcargo (test|build)\b/i },
  { re: /\bgo test\b/i, probe: /\bgo test\b/i },
];

function readClaimBody(claim: Claim): string {
  return `${claim.label}`;
}

/**
 * Does this claim have any mechanically checkable consequence at all?
 * If not, T1 cannot rule on it and the verdict is `unproven`, never `ballast`.
 */
function checkableSignals(
  body: string,
  vocab: ToolWord[],
): { tools: string[]; commandMask: number; commandCount: number } {
  const tools = vocab.filter((t) => t.re.test(body)).map((t) => t.name);
  let commandMask = 0;
  let commandCount = 0;
  for (let i = 0; i < COMMAND_PATTERNS.length; i++) {
    if (!COMMAND_PATTERNS[i].re.test(body)) continue;
    commandMask |= 1 << i;
    commandCount++;
  }
  return { tools, commandMask, commandCount };
}

export type EvidenceInput = {
  claims: Claim[];
  sessions: Session[];
  /** Full text per claim id, so T1 can look for checkable signals. */
  bodies: Map<string, string>;
  /**
   * Transcript directory of the project being analysed. Project-scope claims are only
   * judged against its sessions; without this, `--all` measures a project's CLAUDE.md
   * against other projects' work and manufactures ballast out of irrelevance.
   */
  currentProject?: string | null;
};

type Index = {
  sessions: SessionFact[];
  /** How many sessions were in scope before the claim's age narrowed it. */
  pool: number;
  skillHits: Map<string, number>;
  mcpHits: Map<string, number>;
  agentHits: Map<string, number>;
};

/**
 * When a session last produced a turn, as epoch milliseconds, or 0 if no turn carried a
 * timestamp. Zero is never excluded: an unknown date is not evidence of an old one.
 */
function sessionEndedMs(s: Session): number {
  return endedMsFromTurns(s.turns);
}

function endedMsFromTurns(turns: Session['turns']): number {
  const timestamp = turns.at(-1)?.timestamp;
  if (!timestamp) return 0;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Materialise every transcript-dependent signal once. Everything below this boundary works
 * on these facts, so adding claims or scope/age populations cannot re-read turn payloads.
 */
function buildSessionFact(session: Session): SessionFact {
  const turns = session.turns;
  const tools = new Set<string>();
  let commandMask = 0;
  for (const turn of turns) {
    for (const tool of turn.tools) tools.add(tool);
    for (const command of turn.commands) {
      for (let i = 0; i < COMMAND_PATTERNS.length; i++) {
        if (COMMAND_PATTERNS[i].probe.test(command)) commandMask |= 1 << i;
      }
    }
  }
  return {
    session,
    project: session.project,
    endedMs: endedMsFromTurns(turns),
    tools,
    commandMask,
    skills: new Set(session.skillsUsed),
    mcpServers: new Set(session.mcpServersUsed),
    subagents: new Set(session.subagentsUsed),
  };
}

export type EligibleSessions = { sessions: Session[]; pool: number };

export function eligibleSessionsForClaim(
  claim: Claim,
  sessions: Session[],
  currentProject?: string | null,
): EligibleSessions {
  const pool =
    claim.scope === 'user' || currentProject === undefined
      ? sessions
      : currentProject === null
        ? []
        : sessions.filter((s) => s.project === currentProject);
  const since = claim.source.modifiedMs;
  return {
    sessions:
      since > 0
        ? pool.filter((s) => {
            const ended = sessionEndedMs(s);
            return ended === 0 || ended >= since;
          })
        : pool,
    pool: pool.length,
  };
}

function buildIndex(sessions: SessionFact[]): Index {
  const skillHits = new Map<string, number>();
  const mcpHits = new Map<string, number>();
  const agentHits = new Map<string, number>();
  for (const fact of sessions) {
    for (const k of fact.skills) skillHits.set(k, (skillHits.get(k) ?? 0) + 1);
    for (const k of fact.mcpServers) mcpHits.set(k, (mcpHits.get(k) ?? 0) + 1);
    for (const k of fact.subagents) agentHits.set(k, (agentHits.get(k) ?? 0) + 1);
  }
  return { sessions, pool: sessions.length, skillHits, mcpHits, agentHits };
}

export function runEvidence({
  claims,
  sessions,
  bodies,
  currentProject,
}: EvidenceInput): Map<string, ClaimEvidence> {
  const out = new Map<string, ClaimEvidence>();
  const factBySession = new WeakMap<Session, SessionFact>();
  const facts = sessions.map((session) => {
    let fact = factBySession.get(session);
    if (!fact) {
      fact = buildSessionFact(session);
      factBySession.set(session, fact);
    }
    return fact;
  });

  // A ~/.claude claim is loaded in every session; a project claim only in its own.
  // Judging each against the wrong population is how false ballast is made.
  const vocab = buildVocab(facts);

  // A plugin skill is labelled plugin:name and attribution may record either form, so the
  // bare name is a useful fallback — but only while it belongs to one skill. When a
  // personal skill and a plugin skill share it, crediting either one's use to the other
  // manufactures a load-bearing verdict out of somebody else's work.
  const bareCount = new Map<string, number>();
  for (const c of claims) {
    if (c.kind !== 'skill') continue;
    const n = c.label.replace(/^skill\//, '');
    const bare = n.slice(n.lastIndexOf(':') + 1);
    bareCount.set(bare, (bareCount.get(bare) ?? 0) + 1);
  }
  /**
   * The sessions that could actually have exercised THIS text.
   *
   * A rule rewritten yesterday was not in force last month, so last month's sessions were
   * never chances for it to fire — counting them turns an edit into evidence of
   * uselessness. Modification time is a coarse clock: it moves for a change anywhere in
   * the file, and a fresh clone resets it. It errs the safe way, though — it can only
   * shrink the evidence a claim is judged on, never invent any.
   *
   * One index per (scope, age); claims from one file share both.
   */
  const cache = new Map<string, Index>();
  const indexFor = (claim: Claim): Index => {
    const since = claim.source.modifiedMs;
    const key = `${claim.scope}:${since}`;
    let idx = cache.get(key);
    if (!idx) {
      const pool =
        claim.scope === 'user' || currentProject === undefined
          ? facts
          : currentProject === null
            ? []
            : facts.filter((fact) => fact.project === currentProject);
      const eligible =
        since > 0
          ? pool.filter((fact) => fact.endedMs === 0 || fact.endedMs >= since)
          : pool;
      idx = buildIndex(eligible);
      idx.pool = pool.length;
      cache.set(key, idx);
    }
    return idx;
  };

  for (const claim of claims) {
    const body = bodies.get(claim.id) ?? readClaimBody(claim);
    const idx = indexFor(claim);
    const { skillHits, mcpHits, agentHits } = idx;
    const total = idx.sessions.length;

    // Nothing to testify. Silence is not evidence of uselessness.
    if (total === 0) {
      const named = claim.source.file.split(/[\\\\/]/).pop();
      out.set(claim.id, {
        claimId: claim.id,
        tier: 'none',
        verdict: claim.protected ? 'protected' : 'unproven',
        firedIn: 0,
        observedIn: 0,
        note: idx.pool
          ? `every session in scope predates when ${claim.source.datedBy === 'git' ? 'this section last changed in' : 'the file was last written'} ${named} — nothing observed of this text`
          : 'no sessions in scope for this claim — nothing observed either way',
      });
      continue;
    }

    let ev: ClaimEvidence;

    switch (claim.kind) {
      case 'skill': {
        const name = claim.label.replace(/^skill\//, '');
        const bare = name.slice(name.lastIndexOf(':') + 1);
        const fired =
          skillHits.get(name) ?? ((bareCount.get(bare) ?? 0) === 1 ? skillHits.get(bare) ?? 0 : 0);
        ev = t0(claim, idx, fired, total, fired > 0
          ? `attributed in ${fired} of ${total} sessions`
          : `never attributed across ${total} sessions`);
        break;
      }
      case 'subagent': {
        const name = claim.label.replace(/^agent\//, '');
        const fired = agentHits.get(name) ?? 0;
        ev = t0(claim, idx, fired, total, fired > 0
          ? `dispatched in ${fired} of ${total} sessions`
          : `never dispatched across ${total} sessions`);
        break;
      }
      case 'mcp-server': {
        const name = claim.label.replace(/^mcp\//, '');
        const fired = mcpHits.get(name) ?? matchLoose(mcpHits, name);
        ev = t0(claim, idx, fired, total, fired > 0
          ? `used in ${fired} of ${total} sessions`
          : `never used across ${total} sessions — schemas still loaded every turn`);
        break;
      }
      case 'command': {
        // A slash-command invocation lives in the user's message, and we read counts and
        // tool names, never message content. There is no observation to make here, and
        // manufacturing one would condemn every command a user has ever installed.
        ev = {
          claimId: claim.id,
          tier: 'none',
          verdict: claim.protected ? 'protected' : 'unproven',
          firedIn: 0,
          observedIn: total,
          note: 'slash-command invocations are not visible in what we read — needs T2',
        };
        break;
      }
      default: {
        // Prose. T1: does it prescribe something we can look for?
        const { tools, commandMask, commandCount } = checkableSignals(body, vocab);
        if (tools.length === 0 && commandCount === 0) {
          ev = {
            claimId: claim.id,
            tier: 'none',
            verdict: claim.protected ? 'protected' : 'unproven',
            firedIn: 0,
            observedIn: total,
            note: 'no mechanically checkable consequence — needs T2 judgement',
          };
          break;
        }
        let fired = 0;
        for (const fact of idx.sessions) {
          const toolHit = tools.length > 0 && tools.some((tool) => fact.tools.has(tool));
          const commandHit = commandMask !== 0 && (fact.commandMask & commandMask) !== 0;
          if (toolHit || commandHit) fired++;
        }
        const checked = [
          tools.length ? `${tools.length} tool name${tools.length === 1 ? '' : 's'}` : '',
          commandCount ? `${commandCount} command${commandCount === 1 ? '' : 's'}` : '',
        ]
          .filter(Boolean)
          .join(' + ');
        ev = {
          claimId: claim.id,
          tier: 'T1',
          verdict: verdictFor(claim, fired, total),
          firedIn: fired,
          observedIn: total,
          note: withStale(
            withBound(
              fired > 0
                ? `prescribed behaviour (${checked}) observed in ${fired} of ${total} sessions`
                : `prescribed behaviour (${checked}) never observed across ${total} sessions`,
              fired,
              total,
            ),
            idx,
            claim,
          ),
        };
      }
    }
    out.set(claim.id, ev);
  }

  return out;
}

function matchLoose(map: Map<string, number>, name: string): number {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [k, v] of map) {
    if (k.toLowerCase().replace(/[^a-z0-9]/g, '') === n) return v;
  }
  return 0;
}

function t0(claim: Claim, idx: Index, fired: number, total: number, note: string): ClaimEvidence {
  return {
    claimId: claim.id,
    tier: 'T0',
    verdict: verdictFor(claim, fired, total),
    firedIn: fired,
    observedIn: total,
    note: withStale(withBound(note, fired, total), idx, claim),
  };
}

/**
 * Sessions set aside because they finished before this claim's text existed — and which
 * clock said so, because a commit that dates the section and a file timestamp that moves
 * for any edit anywhere are not the same quality of evidence.
 */
function withStale(note: string, idx: Index, claim: Claim): string {
  const stale = idx.pool - idx.sessions.length;
  if (stale <= 0) return note;
  const since = claim.source.datedBy === 'git' ? 'this section last changed' : 'the file was last written';
  return `${note}; ${stale} session${stale === 1 ? '' : 's'} predating when ${since} not counted`;
}

/**
 * One-sided 95% upper bound on the true firing rate of a claim that never fired in `n`
 * sessions — the rule of three, exactly. If the real rate were any higher, we would have
 * seen it fire at least once with 95% probability.
 *
 * This is the honest answer to "how dead is dead". Never firing in three sessions is
 * consistent with a rule that fires 63% of the time; calling that ballast is not a
 * measurement, it is a guess wearing a verdict's clothes.
 */
export function zeroHitUpperBound(n: number): number {
  if (n <= 0) return 1;
  return 1 - Math.pow(0.05, 1 / n);
}

/**
 * Above this bound, "never observed" carries no information and the claim reports
 * `unproven` instead of `ballast`. It corresponds to five sessions in scope.
 */
const BALLAST_MAX_BOUND = 0.5;

/**
 * A firing rate at or below this is treated as noise rather than evidence of use.
 *
 * It is a judgement, not a derivation: two percent is roughly "once in fifty sessions",
 * which is where a hit stops looking like a habit. It matters that it is pinned — the
 * verdict flips on it, and an untested threshold can drift by a factor of twenty-five
 * without a single test noticing.
 */
const RARE_FIRE_RATE = 0.02;

/** Strength of a zero-observation result, from the bound rather than a round number. */
export function confidenceFor(observedIn: number): 'high' | 'medium' | 'low' {
  const bound = zeroHitUpperBound(observedIn);
  if (bound <= 0.1) return 'high';
  if (bound <= 0.25) return 'medium';
  return 'low';
}

/** A silence is only as strong as the sample it was measured over. Say how strong. */
function withBound(note: string, fired: number, total: number): string {
  if (fired > 0 || total <= 0) return note;
  const pct = zeroHitUpperBound(total) * 100;
  return `${note} — rules out a rate above ${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}% (95%)`;
}

function verdictFor(claim: Claim, fired: number, total: number): Verdict {
  if (claim.protected) return 'protected';
  if (total === 0) return 'unproven';
  // Never fired. Whether that means dead depends entirely on how many chances it had.
  if (fired === 0) {
    return zeroHitUpperBound(total) <= BALLAST_MAX_BOUND ? 'ballast' : 'unproven';
  }
  // Firing somewhere is not the same as being load-bearing. One hit in three hundred
  // sessions is indistinguishable from a coincidence, and calling it live would protect
  // every rule that was ever accidentally satisfied. Below this rate the honest answer is
  // that we cannot tell, which is what T2 is for.
  if (fired / total < RARE_FIRE_RATE) return 'unproven';
  return 'load-bearing';
}
