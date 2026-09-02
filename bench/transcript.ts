import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MiB = 1024 * 1024;
const CHILD = fileURLToPath(new URL('./transcript-child.ts', import.meta.url));

type ChildResult = {
  turns: number;
  tokens: number;
  checksum: string;
  durationMs: number;
  maxRssBeforeKiB: number;
  maxRssAfterKiB: number;
  maxRssDeltaKiB: number;
  error?: string;
};

type ScenarioResult = ChildResult & {
  fileBytes: number;
  fileChecksum: string;
  expectedTurns: number;
  expectedTokens: number;
  maxRssLimitKiB: number;
};

export type TranscriptBenchmarkResult = {
  scale: number;
  noncandidate: ScenarioResult;
  candidate: ScenarioResult;
  gates: Array<{ name: string; pass: boolean; actual: number | boolean | string; limit: number | string }>;
};

type FixtureWriter = {
  handle: fs.promises.FileHandle;
  hash: ReturnType<typeof createHash>;
  bytes: number;
};

async function writePart(writer: FixtureWriter, data: Buffer): Promise<void> {
  await writer.handle.write(data);
  writer.hash.update(data);
  writer.bytes += data.length;
}

async function writeFill(writer: FixtureWriter, bytes: number): Promise<void> {
  const chunk = Buffer.alloc(Math.min(MiB, Math.max(1, bytes)), 0x78);
  let remaining = bytes;
  while (remaining > 0) {
    const length = Math.min(remaining, chunk.length);
    await writePart(writer, length === chunk.length ? chunk : chunk.subarray(0, length));
    remaining -= length;
  }
}

async function writePaddedLine(
  writer: FixtureWriter,
  prefix: string,
  suffix: string,
  bodyBytes: number,
): Promise<void> {
  const head = Buffer.from(prefix);
  const tail = Buffer.from(suffix);
  const fill = bodyBytes - head.length - tail.length;
  if (fill < 0) throw new Error(`fixture target ${bodyBytes} is smaller than its JSON envelope`);
  await writePart(writer, head);
  await writeFill(writer, fill);
  await writePart(writer, tail);
  await writePart(writer, Buffer.from('\n'));
}

function assistant(id: string, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model: 'benchmark',
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      content: [{ type: 'text', text: 'ok' }],
    },
  });
}

async function withWriter(
  file: string,
  write: (writer: FixtureWriter) => Promise<void>,
): Promise<{ bytes: number; checksum: string }> {
  const handle = await fs.promises.open(file, 'w');
  const writer: FixtureWriter = { handle, hash: createHash('sha256'), bytes: 0 };
  try {
    await write(writer);
  } finally {
    await handle.close();
  }
  return { bytes: writer.bytes, checksum: writer.hash.digest('hex') };
}

function runChild(file: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', CHILD, file, 'benchmark-project'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      try {
        const result = JSON.parse(stdout) as ChildResult;
        if (code !== 0 || result.error) {
          reject(new Error(result.error ?? (stderr || `transcript child exited ${code}`)));
          return;
        }
        resolve(result);
      } catch (error) {
        reject(new Error(`invalid transcript child output: ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
}

function validScale(): number {
  const raw = process.env.HARNESSMETER_BENCH_SCALE;
  if (raw === undefined || raw === '') return 1;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new Error('HARNESSMETER_BENCH_SCALE must be greater than 0 and at most 1');
  }
  return scale;
}

export async function runTranscriptBenchmark(): Promise<TranscriptBenchmarkResult> {
  const scale = validScale();
  // Reduced local runs stay above the buffered-reader boundary, so they still exercise
  // the bounded streaming path. CI leaves scale unset and uses the full specification.
  const noncandidateBytes = Math.max(9 * MiB, Math.round(128 * MiB * scale));
  const candidateBytes = Math.max(9 * MiB, Math.round(15 * MiB * scale));
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'harnessmeter-bench-'));
  const noncandidateFile = path.join(temp, 'noncandidate.jsonl');
  const candidateFile = path.join(temp, 'candidate.jsonl');

  try {
    const noncandidateFixture = await withWriter(noncandidateFile, async (writer) => {
      await writePaddedLine(writer, '{"type":"tool_result","payload":"', '"}', noncandidateBytes);
      await writePart(writer, Buffer.from(`${assistant('valid-1', 11, 5)}\n`));
    });
    const candidateFixture = await withWriter(candidateFile, async (writer) => {
      const prefix = '{"type":"assistant","message":{"id":"candidate-1","model":"benchmark","usage":{"input_tokens":13,"output_tokens":7},"content":[{"type":"text","text":"';
      const suffix = '"}]}}';
      await writePaddedLine(writer, prefix, suffix, candidateBytes);
      await writePart(writer, Buffer.from(`${assistant('candidate-2', 17, 9)}\n`));
    });

    const noncandidateChild = await runChild(noncandidateFile);
    const candidateChild = await runChild(candidateFile);
    const noncandidate: ScenarioResult = {
      ...noncandidateChild,
      fileBytes: noncandidateFixture.bytes,
      fileChecksum: noncandidateFixture.checksum,
      expectedTurns: 1,
      expectedTokens: 16,
      maxRssLimitKiB: 64 * 1024,
    };
    const candidate: ScenarioResult = {
      ...candidateChild,
      fileBytes: candidateFixture.bytes,
      fileChecksum: candidateFixture.checksum,
      expectedTurns: 2,
      expectedTokens: 46,
      maxRssLimitKiB: 128 * 1024,
    };
    const hashPresent = (value: string) => /^[0-9a-f]{64}$/.test(value);

    return {
      scale,
      noncandidate,
      candidate,
      gates: [
        { name: 'transcript-noncandidate-turns', pass: noncandidate.turns === 1, actual: noncandidate.turns, limit: 1 },
        { name: 'transcript-noncandidate-tokens', pass: noncandidate.tokens === 16, actual: noncandidate.tokens, limit: 16 },
        { name: 'transcript-noncandidate-rss', pass: noncandidate.maxRssDeltaKiB <= 64 * 1024, actual: noncandidate.maxRssDeltaKiB, limit: 64 * 1024 },
        { name: 'transcript-noncandidate-checksums', pass: hashPresent(noncandidate.checksum) && hashPresent(noncandidate.fileChecksum), actual: hashPresent(noncandidate.checksum) && hashPresent(noncandidate.fileChecksum), limit: 'true' },
        { name: 'transcript-candidate-turns', pass: candidate.turns === 2, actual: candidate.turns, limit: 2 },
        { name: 'transcript-candidate-tokens', pass: candidate.tokens === 46, actual: candidate.tokens, limit: 46 },
        { name: 'transcript-candidate-rss', pass: candidate.maxRssDeltaKiB <= 128 * 1024, actual: candidate.maxRssDeltaKiB, limit: 128 * 1024 },
        { name: 'transcript-candidate-checksums', pass: hashPresent(candidate.checksum) && hashPresent(candidate.fileChecksum), actual: hashPresent(candidate.checksum) && hashPresent(candidate.fileChecksum), limit: 'true' },
      ],
    };
  } finally {
    // `temp` is the exact path returned by mkdtemp, never a computed parent or wildcard.
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
}
