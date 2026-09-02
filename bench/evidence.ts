import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { runEvidence } from '../src/evidence.ts';
import type { Claim, ClaimEvidence, Session, Turn } from '../src/types.ts';

const SESSION_COUNT = 200;
const CLAIM_COUNT = 1_000;
const SMALL_TURNS = 4;
const LARGE_TURNS = 128;
const WARMUPS = 2;
const MEASUREMENTS = 7;
const CHILD = fileURLToPath(new URL('./evidence-child.ts', import.meta.url));

type Reads = { tools: number; commands: number };

type Fixture = {
  sessions: Session[];
  reads: Reads;
  turnsPerSession: number;
};

export type EvidenceBenchmarkResult = {
  config: {
    sessions: number;
    claims: number;
    turns: [number, number];
    warmups: number;
    measurements: number;
  };
  smallMedianMs: number;
  largeMedianMs: number;
  ratio: number;
  checksums: { small: string; large: string; match: boolean };
  corpusReads: {
    expectedPerRun: { small: number; large: number };
    small: Reads[];
    large: Reads[];
    oneClaimProbe: Reads;
    thousandClaimProbe: Reads;
    claimIndependent: boolean;
  };
  gates: Array<{ name: string; pass: boolean; actual: number | boolean | string; limit: number | string }>;
};

const usage = {
  inputTokens: 1,
  cacheReadTokens: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  outputTokens: 1,
};

function fixture(turnsPerSession: number): Fixture {
  const reads: Reads = { tools: 0, commands: 0 };
  const sessions: Session[] = [];
  for (let s = 0; s < SESSION_COUNT; s++) {
    const turns: Turn[] = [];
    for (let t = 0; t < turnsPerSession; t++) {
      const tools = t === 0 ? ['Bash'] : [];
      const commands = t === 0 ? ['npm test'] : [];
      turns.push({
        model: 'benchmark',
        usage,
        usageKnown: true,
        get tools() {
          reads.tools++;
          return tools;
        },
        get commands() {
          reads.commands++;
          return commands;
        },
        timestamp: '2026-01-01T00:00:00.000Z',
      });
    }
    sessions.push({
      id: `session-${s}`,
      project: 'benchmark-project',
      turns,
      skillsUsed: new Set(),
      mcpServersUsed: new Set(),
      subagentsUsed: new Set(),
      firstTurnPromptTokens: 1,
      prefixWrites: 1,
      cacheTtl: '5m',
    });
  }
  return { sessions, reads, turnsPerSession };
}

function claims(): { claims: Claim[]; bodies: Map<string, string> } {
  const claims: Claim[] = [];
  const bodies = new Map<string, string>();
  for (let i = 0; i < CLAIM_COUNT; i++) {
    const id = `claim-${i}`;
    claims.push({
      id,
      label: 'Run npm test with Bash',
      kind: 'prose-section',
      scope: 'project',
      class: 'workflow',
      classInferred: false,
      loading: 'always-on',
      source: {
        file: 'CLAUDE.md',
        startLine: i + 1,
        endLine: i + 1,
        modifiedMs: 0,
        datedBy: 'mtime',
      },
      chars: 22,
      estTokens: 6,
      alwaysOnTokens: 6,
      protected: false,
    });
    bodies.set(id, 'Run npm test with Bash');
  }
  return { claims, bodies };
}

function checksum(evidence: Map<string, ClaimEvidence>): string {
  return createHash('sha256').update(JSON.stringify([...evidence.entries()])).digest('hex');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function runEvidenceBenchmark(): EvidenceBenchmarkResult {
  // Fixture construction is intentionally outside every timed region.
  const small = fixture(SMALL_TURNS);
  const large = fixture(LARGE_TURNS);
  const corpus = claims();
  const bodies = corpus.bodies;
  const access = { small: [] as Reads[], large: [] as Reads[] };

  const run = (f: Fixture, selectedClaims = corpus.claims): { durationMs: number; digest: string; reads: Reads } => {
    const before = { ...f.reads };
    const started = performance.now();
    const evidence = runEvidence({
      claims: selectedClaims,
      sessions: f.sessions,
      bodies,
      currentProject: 'benchmark-project',
    });
    const durationMs = performance.now() - started;
    return {
      durationMs,
      digest: checksum(evidence),
      reads: {
        tools: f.reads.tools - before.tools,
        commands: f.reads.commands - before.commands,
      },
    };
  };

  const oneClaimProbe = run(small, corpus.claims.slice(0, 1)).reads;
  const thousandClaimProbe = run(small).reads;

  for (let i = 0; i < WARMUPS; i++) {
    run(small);
    run(large);
  }

  const smallMs: number[] = [];
  const largeMs: number[] = [];
  let smallDigest = '';
  let largeDigest = '';
  for (let i = 0; i < MEASUREMENTS; i++) {
    // Alternate order to keep thermal/JIT drift from consistently favouring one corpus.
    const first = i % 2 === 0 ? small : large;
    const second = i % 2 === 0 ? large : small;
    for (const f of [first, second]) {
      const measured = run(f);
      const key = f === small ? 'small' : 'large';
      access[key].push(measured.reads);
      if (f === small) {
        smallMs.push(measured.durationMs);
        smallDigest = measured.digest;
      } else {
        largeMs.push(measured.durationMs);
        largeDigest = measured.digest;
      }
    }
  }

  const smallMedianMs = median(smallMs);
  const largeMedianMs = median(largeMs);
  const ratio = largeMedianMs / Math.max(smallMedianMs, Number.EPSILON);
  const expectedSmall = SESSION_COUNT * SMALL_TURNS;
  const expectedLarge = SESSION_COUNT * LARGE_TURNS;
  const exact = (samples: Reads[], expected: number) =>
    samples.every((sample) => sample.tools === expected && sample.commands === expected);
  const claimIndependent =
    oneClaimProbe.tools === thousandClaimProbe.tools &&
    oneClaimProbe.commands === thousandClaimProbe.commands &&
    oneClaimProbe.tools === expectedSmall &&
    oneClaimProbe.commands === expectedSmall;

  return {
    config: {
      sessions: SESSION_COUNT,
      claims: CLAIM_COUNT,
      turns: [SMALL_TURNS, LARGE_TURNS],
      warmups: WARMUPS,
      measurements: MEASUREMENTS,
    },
    smallMedianMs,
    largeMedianMs,
    ratio,
    checksums: { small: smallDigest, large: largeDigest, match: smallDigest === largeDigest },
    corpusReads: {
      expectedPerRun: { small: expectedSmall, large: expectedLarge },
      small: access.small,
      large: access.large,
      oneClaimProbe,
      thousandClaimProbe,
      claimIndependent,
    },
    gates: [
      { name: 'evidence-checksum-match', pass: smallDigest === largeDigest, actual: smallDigest === largeDigest, limit: 'true' },
      { name: 'evidence-corpus-reads-small', pass: exact(access.small, expectedSmall), actual: exact(access.small, expectedSmall), limit: 'true' },
      { name: 'evidence-corpus-reads-large', pass: exact(access.large, expectedLarge), actual: exact(access.large, expectedLarge), limit: 'true' },
      { name: 'evidence-reads-independent-of-claims', pass: claimIndependent, actual: claimIndependent, limit: 'true' },
      { name: 'evidence-large-small-ratio', pass: ratio <= 5, actual: ratio, limit: 5 },
    ],
  };
}

/** Run the timed evidence work in a fresh process so earlier CI jobs cannot skew its heap. */
export function runEvidenceIsolated(): Promise<EvidenceBenchmarkResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      try {
        const result = JSON.parse(stdout) as EvidenceBenchmarkResult & { error?: string };
        if (code !== 0 || result.error) {
          reject(new Error(result.error ?? (stderr || `evidence child exited ${code}`)));
          return;
        }
        resolve(result);
      } catch (error) {
        reject(new Error(`invalid evidence child output: ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
}
