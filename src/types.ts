/** Core types. Deliberately small — everything derives from what the transcripts actually contain. */

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
  /** Tool names invoked in this turn, e.g. "Edit", "mcp__chrome-devtools__navigate_page" */
  tools: string[];
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
   * This is the always-on prefix — base system prompt + harness + tool schemas — measured,
   * not estimated.
   */
  firstTurnPromptTokens: number;
};

export type ClaimKind =
  | 'prose-section'
  | 'skill'
  | 'subagent'
  | 'mcp-server'
  | 'hook'
  | 'output-style';

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
  class: ClaimClass;
  /** True when the class was inferred rather than declared. Never applied silently. */
  classInferred: boolean;
  loading: Loading;
  source: { file: string; startLine: number; endLine: number };
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
  };
};

export type Analysis = {
  scannedAt: string;
  projects: string[];
  sessionCount: number;
  turnCount: number;
  /** Exact, from transcripts. */
  spendUsd: number;
  billedTokens: {
    input: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
  };
  /** Median measured always-on prefix across sessions. Exact. */
  medianPrefixTokens: number;
  /** Sum of estimated harness claim sizes. Estimated. */
  harnessEstTokens: number;
  /** medianPrefix - harnessEst: base system prompt + MCP tool schemas. */
  residualTokens: number;
  medianTurnsPerSession: number;
  models: Record<string, number>;
  claims: Claim[];
  evidence: Map<string, ClaimEvidence>;
  proposals: Proposal[];
  deadSharePct: number;
  /**
   * What this analysis cost. T0/T1 are free; T2 spends the user's own quota via their own
   * agent CLI. Reported so the net-negative claim can be audited rather than asserted.
   */
  cost: {
    tokens: number;
    usd: number;
    calls: number;
    tier: 'T0/T1' | 'T0/T1/T2';
    model?: string;
    judged?: number;
  };
};
