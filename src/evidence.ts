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

/** Tokens a rule can be checked against: tool names it names, commands it prescribes. */
const TOOL_VOCAB = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task', 'WebFetch', 'WebSearch',
  'NotebookEdit', 'TaskCreate', 'TaskUpdate', 'PowerShell', 'ToolSearch',
];

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
function checkableSignals(claim: Claim, body: string): { tools: string[]; commands: RegExp[] } {
  const tools = TOOL_VOCAB.filter((t) => new RegExp(`\\b${t}\\b`).test(body));
  const commands = COMMAND_PATTERNS.filter((c) => c.re.test(body)).map((c) => c.probe);
  return { tools, commands };
}

export type EvidenceInput = {
  claims: Claim[];
  sessions: Session[];
  /** Full text per claim id, so T1 can look for checkable signals. */
  bodies: Map<string, string>;
};

export function runEvidence({ claims, sessions, bodies }: EvidenceInput): Map<string, ClaimEvidence> {
  const out = new Map<string, ClaimEvidence>();
  const total = sessions.length;

  // Pre-index what actually happened, once.
  const skillHits = new Map<string, number>();
  const mcpHits = new Map<string, number>();
  const agentHits = new Map<string, number>();
  const toolHits = new Map<string, number>();
  const bashLines: string[] = [];

  for (const s of sessions) {
    for (const k of s.skillsUsed) skillHits.set(k, (skillHits.get(k) ?? 0) + 1);
    for (const k of s.mcpServersUsed) mcpHits.set(k, (mcpHits.get(k) ?? 0) + 1);
    for (const k of s.subagentsUsed) agentHits.set(k, (agentHits.get(k) ?? 0) + 1);
    const seen = new Set<string>();
    for (const t of s.turns) for (const name of t.tools) seen.add(name);
    for (const name of seen) toolHits.set(name, (toolHits.get(name) ?? 0) + 1);
  }

  for (const claim of claims) {
    const body = bodies.get(claim.id) ?? readClaimBody(claim);
    let ev: ClaimEvidence;

    switch (claim.kind) {
      case 'skill': {
        const name = claim.label.replace(/^skill\//, '');
        const fired = skillHits.get(name) ?? 0;
        ev = t0(claim, fired, total, fired > 0
          ? `attributed in ${fired} of ${total} sessions`
          : `never attributed across ${total} sessions`);
        break;
      }
      case 'subagent': {
        const name = claim.label.replace(/^agent\//, '');
        const fired = agentHits.get(name) ?? 0;
        ev = t0(claim, fired, total, fired > 0
          ? `dispatched in ${fired} of ${total} sessions`
          : `never dispatched across ${total} sessions`);
        break;
      }
      case 'mcp-server': {
        const name = claim.label.replace(/^mcp\//, '');
        const fired = mcpHits.get(name) ?? matchLoose(mcpHits, name);
        ev = t0(claim, fired, total, fired > 0
          ? `used in ${fired} of ${total} sessions`
          : `never used across ${total} sessions — schemas still loaded every turn`);
        break;
      }
      default: {
        // Prose. T1: does it prescribe something we can look for?
        const { tools, commands } = checkableSignals(claim, body);
        if (tools.length === 0 && commands.length === 0) {
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
        for (const s of sessions) {
          let hit = false;
          for (const t of s.turns) {
            if (tools.some((tool) => t.tools.includes(tool))) { hit = true; break; }
          }
          if (hit) fired++;
        }
        ev = {
          claimId: claim.id,
          tier: 'T1',
          verdict: verdictFor(claim, fired, total),
          firedIn: fired,
          observedIn: total,
          note: fired > 0
            ? `prescribed behaviour observed in ${fired} of ${total} sessions`
            : `prescribed behaviour never observed across ${total} sessions`,
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

function t0(claim: Claim, fired: number, total: number, note: string): ClaimEvidence {
  return {
    claimId: claim.id,
    tier: 'T0',
    verdict: verdictFor(claim, fired, total),
    firedIn: fired,
    observedIn: total,
    note,
  };
}

function verdictFor(claim: Claim, fired: number, total: number): Verdict {
  if (claim.protected) return 'protected';
  if (total === 0) return 'unproven';
  if (fired === 0) return 'ballast';
  if (fired / total < 0.02) return 'unproven';
  return 'load-bearing';
}
