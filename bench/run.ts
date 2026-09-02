import fs from 'node:fs';
import path from 'node:path';

type Gate = { name: string; pass: boolean; actual: number | boolean | string; limit: number | string };

const output = path.resolve('bench-results.json');
const receipt: {
  schemaVersion: number;
  generatedAt: string;
  runtime: { node: string; platform: string; arch: string };
  status: 'pass' | 'fail';
  evidence?: unknown;
  transcript?: unknown;
  gates: Gate[];
  errors: string[];
} = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  status: 'fail',
  gates: [],
  errors: [],
};

function message(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function run(): Promise<void> {
  try {
    try {
      const { runEvidenceIsolated } = await import('./evidence.ts');
      const evidence = await runEvidenceIsolated();
      receipt.evidence = evidence;
      receipt.gates.push(...evidence.gates);
    } catch (error) {
      receipt.errors.push(`evidence: ${message(error)}`);
    }

    try {
      const { runTranscriptBenchmark } = await import('./transcript.ts');
      const transcript = await runTranscriptBenchmark();
      receipt.transcript = transcript;
      receipt.gates.push(...transcript.gates);
    } catch (error) {
      receipt.errors.push(`transcript: ${message(error)}`);
    }

    receipt.status =
      receipt.errors.length === 0 && receipt.gates.length > 0 && receipt.gates.every((gate) => gate.pass)
        ? 'pass'
        : 'fail';
  } catch (error) {
    receipt.errors.push(message(error));
  } finally {
    try {
      fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`could not write ${output}: ${message(error)}\n`);
      process.exitCode = 1;
      return;
    }
    if (receipt.status !== 'pass') process.exitCode = 1;
  }
}

await run();
