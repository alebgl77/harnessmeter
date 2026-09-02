import { runEvidenceBenchmark } from './evidence.ts';

try {
  process.stdout.write(JSON.stringify(runEvidenceBenchmark()));
} catch (error: unknown) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stdout.write(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
