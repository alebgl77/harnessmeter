import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (relative: string) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('benchmark command and typecheck wiring are explicit', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
  const tsconfig = JSON.parse(read('tsconfig.json')) as { include?: string[] };

  assert.equal(pkg.scripts?.['bench:ci'], 'node bench/run.ts');
  assert.ok(tsconfig.include?.includes('bench/**/*.ts'));
  assert.ok(fs.existsSync(`${root}bench/run.ts`));
});

test('CI benchmark is isolated, pinned, and uploads its receipt on failure', () => {
  const yaml = read('.github/workflows/ci.yml');
  const start = yaml.indexOf('  bench-regression:');
  const job = yaml.slice(start, yaml.indexOf('\n  package:', start));

  assert.ok(start >= 0 && job.length > 0, 'bench-regression job is missing');
  assert.match(job, /runs-on: ubuntu-latest/);
  assert.match(job, /node-version: '24'/);
  assert.match(job, /run: npm run bench:ci/);
  assert.match(job, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(job, /if: always\(\)/);
  assert.match(job, /retention-days: 7/);
  assert.doesNotMatch(job, /^\s{4}strategy:/m);
  assert.doesNotMatch(job, /npm (?:ci|install)/);
});
