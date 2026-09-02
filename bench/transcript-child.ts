import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readSession } from '../src/transcript.ts';

type GcGlobal = typeof globalThis & { gc?: () => void };

function collect(): void {
  const gc = (globalThis as GcGlobal).gc;
  if (!gc) throw new Error('benchmark child must be launched with --expose-gc');
  gc();
}

async function main(): Promise<void> {
  const file = process.argv[2];
  const project = process.argv[3] ?? 'benchmark-project';
  if (!file) throw new Error('missing transcript path');

  collect();
  const beforeKiB = process.resourceUsage().maxRSS;
  const started = performance.now();
  const session = await readSession(file, project);
  const durationMs = performance.now() - started;
  collect();
  const afterKiB = process.resourceUsage().maxRSS;
  if (!session) throw new Error('fixture produced no readable session');

  const tokens = session.turns.reduce(
    (sum, turn) =>
      sum +
      turn.usage.inputTokens +
      turn.usage.cacheReadTokens +
      turn.usage.cacheWrite5m +
      turn.usage.cacheWrite1h +
      turn.usage.outputTokens,
    0,
  );
  const normalized = session.turns.map((turn) => ({
    model: turn.model,
    usage: turn.usage,
    usageKnown: turn.usageKnown,
    tools: turn.tools,
    commands: turn.commands,
  }));
  const checksum = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');

  process.stdout.write(JSON.stringify({
    turns: session.turns.length,
    tokens,
    checksum,
    durationMs,
    maxRssBeforeKiB: beforeKiB,
    maxRssAfterKiB: afterKiB,
    maxRssDeltaKiB: Math.max(0, afterKiB - beforeKiB),
  }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stdout.write(JSON.stringify({ error: message }));
  process.exitCode = 1;
});
