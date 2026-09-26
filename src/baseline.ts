import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { claudeHome } from './transcript.ts';
import { codexHome } from './transcript-codex.ts';
import { growthPercent } from './budget.ts';
import type { Claim, ClaimKind, Loading, Provider } from './types.ts';

export type BaselineScope = 'project' | 'project+user';
export type BaselineClaim = {
  id: string; provider: Provider; scope: 'project' | 'user'; path: string;
  kind: ClaimKind; section: string; bodyHash: string; tokens: number; loading: Loading; protected: boolean;
};
export type Baseline = {
  schemaVersion: 1; provider: Provider; scope: BaselineScope;
  metric: 'estimated-resident-tokens'; totalTokens: number; claims: BaselineClaim[];
};
export const MAX_BASELINE_BYTES = 8 * 1024 * 1024;
const MAX_CLAIMS = 20000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const idFor = (claim: Omit<BaselineClaim, 'id'>) =>
  `${claim.provider}:${claim.scope}:${claim.path}:${claim.kind}:${claim.section}`;

function projectRoot(cwd: string): string {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

function relative(file: string, root: string): string | undefined {
  const rel = path.relative(root, path.resolve(file));
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

function portablePath(claim: Claim, root: string, provider: Provider): string {
  const known = claim.scope === 'project'
    ? relative(claim.source.file, root)
    : relative(claim.source.file, provider === 'claude' ? claudeHome() : codexHome());
  if (known) return known;
  if (claim.scope === 'user') {
    const skills = relative(claim.source.file, path.join(os.homedir(), '.agents'));
    if (skills) return `agents/${skills}`;
  }
  // Out-of-root imports and plugin installations have no portable absolute address.
  // Retain a deterministic opaque basename identity without disclosing home directories.
  return `external/${hash(path.basename(claim.source.file))}`;
}

/** No clock, machine path, original claim id, label, or source text enters a snapshot. */
export function createBaseline(options: {
  cwd: string; provider: Provider; includeUser: boolean; claims: Claim[]; bodies: Map<string, string>;
}): Baseline {
  const root = projectRoot(options.cwd);
  const rows = options.claims.map((claim) => {
    if ((claim.provider ?? 'claude') !== options.provider) throw new Error('Baseline provider does not match claim provider');
    if (!options.includeUser && claim.scope === 'user') throw new Error('User claim in project-only baseline');
    const body = (options.bodies.get(claim.id) ?? '').replace(/\r\n/g, '\n').trim();
    const heading = claim.kind === 'prose-section'
      ? claim.label.slice(claim.label.indexOf(' § ') + 3)
      : claim.label;
    const entry: Omit<BaselineClaim, 'id'> = {
      provider: options.provider, scope: claim.scope, path: portablePath(claim, root, options.provider),
      kind: claim.kind, section: hash(heading), bodyHash: hash(body), tokens: claim.alwaysOnTokens,
      loading: claim.loading, protected: claim.protected,
    };
    return { entry, line: claim.source.startLine };
  });
  // Sorting precedes duplicate ordinals: discovery iteration order never affects identity.
  rows.sort((a, b) => compare(idFor(a.entry), idFor(b.entry)) || a.line - b.line || compare(a.entry.bodyHash, b.entry.bodyHash));
  const occurrences = new Map<string, number>();
  const claims = rows.map(({ entry }) => {
    const base = idFor(entry);
    const ordinal = occurrences.get(base) ?? 0;
    occurrences.set(base, ordinal + 1);
    if (ordinal) entry.section += `~${ordinal}`;
    return { id: idFor(entry), ...entry };
  }).sort((a, b) => compare(a.id, b.id));
  return validateBaseline({
    schemaVersion: 1, provider: options.provider, scope: options.includeUser ? 'project+user' : 'project',
    metric: 'estimated-resident-tokens', totalTokens: claims.reduce((n, claim) => n + claim.tokens, 0), claims,
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const kinds = new Set(['prose-section', 'skill', 'subagent', 'command', 'mcp-server']);

/** Reject incompatible and forged totals before any budget can use them. */
export function validateBaseline(value: unknown, expected?: { provider: Provider; scope: BaselineScope }): Baseline {
  const invalid = (why: string): never => { throw new Error(`Invalid baseline: ${why}`); };
  if (!object(value)) return invalid('expected an object');
  if (value.schemaVersion !== 1) return invalid('unsupported schemaVersion (expected 1)');
  if (!exactKeys(value, ['schemaVersion', 'provider', 'scope', 'metric', 'totalTokens', 'claims'])) return invalid('unexpected or missing fields');
  if (value.provider !== 'claude' && value.provider !== 'codex') return invalid('unknown provider');
  if (value.scope !== 'project' && value.scope !== 'project+user') return invalid('unknown scope');
  if (value.metric !== 'estimated-resident-tokens' || !nonnegative(value.totalTokens)) return invalid('invalid token metric or total');
  if (expected && (value.provider !== expected.provider || value.scope !== expected.scope)) return invalid('provider or scope does not match this audit');
  if (!Array.isArray(value.claims) || value.claims.length > MAX_CLAIMS) return invalid('claims must be a bounded array');
  const seen = new Set<string>();
  let total = 0;
  for (const claim of value.claims) {
    if (!object(claim) || !exactKeys(claim, ['id', 'provider', 'scope', 'path', 'kind', 'section', 'bodyHash', 'tokens', 'loading', 'protected'])) return invalid('invalid claim fields');
    if (claim.provider !== value.provider || (claim.scope !== 'project' && claim.scope !== 'user') ||
        (value.scope === 'project' && claim.scope !== 'project')) return invalid('claim provider or scope mismatch');
    if (typeof claim.path !== 'string' || claim.path.length > 2048 || !claim.path ||
        /[\\:\x00-\x1f\x7f]/.test(claim.path) || claim.path.startsWith('/') ||
        claim.path.split('/').some((part) => !part || part === '.' || part === '..')) return invalid('claim path must be portable and relative');
    if (typeof claim.kind !== 'string' || !kinds.has(claim.kind) ||
        typeof claim.section !== 'string' || !/^[0-9a-f]{64}(?:~[1-9][0-9]*)?$/.test(claim.section) ||
        !digest(claim.bodyHash) || !nonnegative(claim.tokens) ||
        (claim.loading !== 'always-on' && claim.loading !== 'on-demand') || typeof claim.protected !== 'boolean') return invalid('invalid claim metadata');
    const typed = claim as unknown as BaselineClaim;
    if (claim.id !== idFor(typed) || seen.has(typed.id)) return invalid('invalid or duplicate claim id');
    seen.add(typed.id);
    total += typed.tokens;
  }
  if (!Number.isSafeInteger(total) || total !== value.totalTokens) return invalid('totalTokens does not equal the sum of claims');
  return value as unknown as Baseline;
}

/** Reject symlinks at every existing component, including the final file. */
export function assertSafePath(file: string): void {
  const absolute = path.resolve(file);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symlink path: ${current}`);
      if (current !== absolute && !stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
      if (current === absolute && !stat.isDirectory() && !stat.isFile()) throw new Error(`Not a regular file: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

export function sameTarget(left: string, right: string): boolean {
  const canonical = (file: string) => {
    let result = path.resolve(file);
    try { result = fs.realpathSync.native(result); } catch { /* may not exist yet */ }
    return process.platform === 'win32' ? result.toLowerCase() : result;
  };
  if (canonical(left) === canonical(right)) return true;
  try {
    const a = fs.statSync(left); const b = fs.statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

export function readBaseline(file: string, expected: { provider: Provider; scope: BaselineScope }): Baseline {
  assertSafePath(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BASELINE_BYTES) throw new Error('Baseline is not a bounded regular file');
    const bytes = Buffer.alloc(MAX_BASELINE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_BASELINE_BYTES) throw new Error('Baseline exceeds size limit');
    return validateBaseline(JSON.parse(bytes.subarray(0, length).toString('utf8')), expected);
  } finally { fs.closeSync(fd); }
}

/** Same-directory rename publishes complete bytes, never a partially written snapshot. */
export function atomicWrite(file: string, text: string): void {
  const target = path.resolve(file);
  assertSafePath(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  assertSafePath(target);
  const temp = path.join(path.dirname(target), `.harnessmeter-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    assertSafePath(target);
    fs.renameSync(temp, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function writeBaseline(file: string, baseline: Baseline): void {
  validateBaseline(baseline);
  const text = JSON.stringify(baseline, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_BASELINE_BYTES) throw new Error('Baseline exceeds size limit');
  atomicWrite(file, text);
}

export function compareBaselines(current: Baseline, baseline: Baseline) {
  validateBaseline(current);
  validateBaseline(baseline, { provider: current.provider, scope: current.scope });
  const before = new Map(baseline.claims.map((claim) => [claim.id, claim]));
  const after = new Map(current.claims.map((claim) => [claim.id, claim]));
  const added = current.claims.filter((claim) => !before.has(claim.id));
  const removed = baseline.claims.filter((claim) => !after.has(claim.id));
  const changed = current.claims.filter((claim) => {
    const previous = before.get(claim.id);
    return previous && (claim.bodyHash !== previous.bodyHash || claim.tokens !== previous.tokens ||
      claim.loading !== previous.loading || claim.protected !== previous.protected);
  }).map((claim) => ({ id: claim.id, before: before.get(claim.id)!, after: claim, deltaTokens: claim.tokens - before.get(claim.id)!.tokens }));
  return {
    beforeTokens: baseline.totalTokens, currentTokens: current.totalTokens,
    deltaTokens: current.totalTokens - baseline.totalTokens,
    growthPercent: growthPercent(current.totalTokens, baseline.totalTokens),
    added, removed, changed,
  };
}
