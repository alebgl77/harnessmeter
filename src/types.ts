/** Core types. Deliberately small — everything derives from what the transcripts actually contain. */

import type { DateSource } from './history.ts';

export type { DateSource };

/** What a model charged us for a single assistant turn. Read, never estimated. */
export type TurnUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  /** 5-minute TTL cache writes, billed at 1.25x */
  cacheWrite5m: number;
  /** 1-hour TTL cache writes, billed at 2x */
  cacheWrite1h: number;
  outputTokens: number;
};

export type Turn = {
  model: string;
  usage: TurnUsage;
  /**
   * Whether `usage` came from a transcript schema we understand. Omitted means known for
   * backward compatibility with turns built before this flag existed; only explicit false
   * excludes a turn from billing aggregates.
   */
  usageKnown?: boolean;
  /** Tool names invoked in this turn, e.g. "Edit", "mcp__chrome-devtools__navigate_page" */
  tools: string[];
  /**
   * Shell commands run this turn, truncated. A rule that prescribes `npm test` leaves no
   * trace in tool *names* — every shell call is just "Bash" — so the command line itself
   * is the only place such a rule can be confirmed or refuted.
   */
  commands: string[];
  timestamp?: string;
};

export type Session = {
  id: string;
  project: string;
  cwd?: string;
  gitBranch?: string;
  turns: Turn[];
  /** Skills Claude Code attributed activity to during this session. */
  skillsUsed: Set<string>;
  /** MCP servers Claude Code attributed activity to during this session. */
  mcpServersUsed: Set<string>;
  /** Subagent types dispatched via the Task tool. */
  subagentsUsed: Set<string>;
  /**
   * Total prompt size on the first assistant turn: input + cache reads + cache writes.
   *
   * This is an UPPER BOUND on the resident prefix, not the prefix itself: it also contains
   * the opening user message, which we cannot separate out from the billed totals. Reported
   * as a bound everywhere it surfaces.
   */
  firstTurnPromptTokens: number;
  /**
   * How many times the resident prefix was WRITTEN to the cache during this session.
   *
   * Measured, not assumed. The obvious model — written once on turn one, read at 0.1x
   * forever after — is wrong: a cache entry expires with its TTL, and compaction or any
   * edit to a harness file invalidates it. Each of those forces a full re-write at the
   * write multiplier. A turn qualifies when its cache read falls below the prefix while it
   * writes more than half of one. Never below 1: the first turn always writes.
   */
  prefixWrites: number;
  /**
   * Which TTL this session's cache writes actually used, by token share. It decides
   * whether a write costs 1.25x or 2x, and assuming the cheaper one understates the bill.
   */
  cacheTtl: '5m' | '1h';
};

/**
 * What kind of block holds the lease. These are the kinds the scanner actually produces —
 * hooks are deliberately absent: a hook is a shell command, not a block of context, and it
 * only occupies the window on the turns where it fires. Pricing one as always-on would
 * invent a cost.
 */
export type ClaimKind =
  | 'prose-section'
  | 'skill'
  | 'subagent'
  | 'command'
  | 'mcp-server';

/**
 * Semantic class of a claim. `prevention` is load-bearing to the whole design:
 * a prevention rule has inverted yield — it looks useless precisely because it works —
 * so it is never evicted on observational evidence.
 */
export type ClaimClass =
  | 'prevention'
  | 'workflow'
  | 'style'
  | 'architecture'
  | 'knowledge'
  | 'unknown';

export type Loading = 'always-on' | 'on-demand';

/** Which tier of evidence we actually reached for this claim. Always shown to the human. */
export type EvidenceTier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'none';

export type Verdict = 'load-bearing' | 'unproven' | 'ballast' | 'protected';

export type Claim = {
  id: string;
  label: string;
  kind: ClaimKind;
  /**
   * Where the claim lives, which decides which sessions can testify about it.
   * A `~/.claude` claim is loaded in every project; a project claim only in its own.
   * Judging a project claim against another project's sessions manufactures ballast.
   */
  scope: 'project' | 'user';
  class: ClaimClass;
  /** True when the class was inferred rather than declared. Never applied silently. */
  classInferred: boolean;
  loading: Loading;
  source: {
    file: string;
    startLine: number;
    endLine: number;
    /**
     * When the file this claim lives in was last written, as epoch milliseconds, or 0 if
     * that could not be read.
     *
     * A session that ran before this was judging different text. Counting it as a chance
     * the claim had to fire is how a rule written yesterday gets condemned on evidence
     * from last month.
     */
    modifiedMs: number;
    /**
     * Which clock produced that date.
     *
     * `git` is the commit behind the lines this claim spans — precise to the section, and it
     * survives a clone. `mtime` is the file's modification time, which moves for a change
     * anywhere in the file and is reset by a checkout. They are not equally trustworthy, so
     * the report says which one it used rather than presenting both as a date.
     */
    datedBy: DateSource;
  };
  chars: number;
  /** Calibrated estimate of the whole block. Session-level costs are exact; these are not. */
  estTokens: number;
  /**
   * The portion that sits in context on every turn regardless of use.
   * For a skill this is its frontmatter description — the part the model must see to know
   * the skill exists. Ignoring this distinction overstates skill cost by an order of
   * magnitude, which is exactly the kind of error this tool exists to stop making.
   */
  alwaysOnTokens: number;
  protected: boolean;
};

export type ClaimEvidence = {
  claimId: string;
  tier: EvidenceTier;
  verdict: Verdict;
  /** Number of sessions in which this claim had an observable consequence. */
  firedIn: number;
  observedIn: number;
  /** Confidence assigned to this evidence when it did not come from a zero-hit bound. */
  confidence?: 'high' | 'medium' | 'low';
  /** Whether confidence came from corpus statistics or the T2 judge. */
  confidenceSource?: 'zero-hit-bound' | 't2-judge';
  note: string;
};

export type Proposal = {
  claimId: string;
  label: string;
  action: 'demote' | 'evict' | 'investigate';
  savingPerSession: number;
  receipt: {
    tier: EvidenceTier;
    sessions: number;
    firedIn: number;
    class: ClaimClass;
    protected: boolean;
    confidence: 'high' | 'medium' | 'low';
    /** The calculation or judge that supplied `confidence`. */
    confidenceSource: 'zero-hit-bound' | 't2-judge';
    /**
     * For a claim that never fired: the 95% upper bound on how often it really could,
     * given the sessions in scope. The receipt has to carry the strength of its own
     * evidence, or "confidence: medium" is just a word.
     */
    boundPct: number;
  };
};

export type Analysis = {
  scannedAt: string;
  projects: string[];
  sessionCount: number;
  turnCount: number;
  /** Which reported telemetry is measured rather than a zero placeholder. */
  telemetryCoverage: {
    knownTurns: number;
    totalTurns: number;
    /** Complete sessions used for the first-turn prompt median. */
    prefixSessions: number;
    /** Complete sessions used for turns, cache-write and TTL medians. */
    cacheSessions: number;
    status: 'full' | 'partial' | 'none';
  };
  /** Exact, from transcripts. */
  spendUsd: number;
  billedTokens: {
    input: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
  };
  /** Median first-turn prompt across sessions — an upper bound on the resident prefix. */
  medianPrefixTokens: number;
  /**
   * Models seen in the transcripts whose rate we do not know. Their turns are priced at a
   * fallback rate, so any dollar figure is an estimate rather than a reading whenever this
   * is non-empty.
   */
  unknownModels: string[];
  /** Sum of estimated harness claim sizes. Estimated. */
  harnessEstTokens: number;
  /**
   * medianPrefixTokens - harnessEstTokens: everything in the first-turn prompt we cannot
   * attribute to a harness file.
   *
   * Its composition is NOT known. It contains the base system prompt and MCP tool schemas,
   * but also the opening user message, any attachment or system reminder injected into that
   * turn, and whatever else the harness we can read does not account for. Describing it as
   * "base prompt + MCP schemas" states a decomposition we have not measured.
   */
  residualTokens: number;
  medianTurnsPerSession: number;
  /**
   * Median number of times per session the resident prefix was written to the cache.
   * Every always-on figure in this report is priced against this, not against an assumed
   * single write. See Session.prefixWrites.
   */
  medianPrefixWrites: number;
  /** The TTL this machine's sessions actually write at, by token share. */
  cacheTtl: '5m' | '1h';
  models: Record<string, number>;
  claims: Claim[];
  evidence: Map<string, ClaimEvidence>;
  proposals: Proposal[];
  deadSharePct: number;
  /**
   * The resolution of this scan: the tightest firing rate a claim that never fired can be
   * shown to be under, at 95% confidence, given how many sessions were read.
   *
   * It is what stops a quiet week from reading as a clean harness. Four sessions cannot
   * demonstrate anything and the report has to say so rather than print a reassuring zero.
   */
  evidenceFloorPct: number;
  /**
   * How many sessions that floor was computed over.
   *
   * Under `--all` this is smaller than `sessionCount`: a project's claims are only judged
   * against that project's sessions, so quoting the whole corpus would advertise a
   * resolution the scan does not have for most of what it reports.
   */
  evidenceFloorSessions: number;
  /**
   * What this analysis cost. T0/T1 are free; T2 spends the user's own quota via their own
   * agent CLI. Reported so the net-negative claim can be audited rather than asserted.
   */
  cost: {
    tokens: number | null;
    usd: number | null;
    attempts: number;
    calls: number;
    modelCalls: number | null;
    networkCalls: 0 | null;
    measuredTokens: number;
    measuredCostUsd: number;
    tokenResponses: number;
    costResponses: number;
    tier: 'T0/T1' | 'T0/T1/T2';
    model?: string;
    judged?: number;
  };
};
