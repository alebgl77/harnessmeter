/**
 * Harness discovery and claim extraction.
 *
 * A "claim" is an addressable block of the harness that holds a lease on context:
 * a CLAUDE.md section (including the files it imports), a skill, a subagent, a slash
 * command, an MCP server — whether it came from your own directories or from a plugin.
 *
 * Per-claim token figures here are CALIBRATED ESTIMATES derived from character counts.
 * Session-level costs (pricing.ts / transcript.ts) are exact. The report keeps the two
 * apart, always.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Claim, ClaimClass, ClaimKind, Loading } from './types.ts';
import { claudeHome } from './transcript.ts';
import { sectionChangedMs, type DateSource } from './history.ts';

/** Rough but honest. Claude's tokenizer is not public; tiktoken is a different tokenizer. */
export const CHARS_PER_TOKEN = 3.8;

/** One immutable view of a harness file, captured during a scan. */
export type HarnessFileSnapshot = {
  /** Absolute lexical path. Symlinks are deliberately not resolved. */
  path: string;
  text: string;
  byteLength: number;
  sha256: string;
  mtimeMs: number;
};

export type HarnessSnapshot = Map<string, HarnessFileSnapshot>;

export type HarnessScanOptions = {
  /** Test seam and embedders' filesystem seam. Must return the file's raw bytes. */
  readFile?: (file: string) => Buffer;
};

type ScanContext = {
  snapshot: HarnessSnapshot;
  missing: Set<string>;
  readFile: (file: string) => Buffer;
};

function scanContext(options: HarnessScanOptions = {}): ScanContext {
  return {
    snapshot: new Map(),
    missing: new Set(),
    readFile: options.readFile ?? ((file) => fs.readFileSync(file)),
  };
}

function snapshotFile(file: string, context: ScanContext): HarnessFileSnapshot | undefined {
  const absolute = path.resolve(file);
  const cached = context.snapshot.get(absolute);
  if (cached) return cached;
  if (context.missing.has(absolute)) return undefined;

  try {
    const bytes = context.readFile(absolute);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(absolute).mtimeMs;
    } catch {
      /* content remains usable even when metadata is unavailable */
    }
    const entry: HarnessFileSnapshot = {
      path: absolute,
      text: bytes.toString('utf8'),
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mtimeMs,
    };
    context.snapshot.set(absolute, entry);
    return entry;
  } catch {
    // Cache failures too: one unreadable path must not be retried by every extractor.
    context.missing.add(absolute);
    return undefined;
  }
}

function readText(file: string, context?: ScanContext): string | undefined {
  if (context) return snapshotFile(file, context)?.text;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function estTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

/**
 * When a harness file was last written. Cached, because one file holds many claims and a
 * stat per claim is a stat per section of every CLAUDE.md on the machine.
 *
 * Modification time is a coarse instrument — it moves for an edit anywhere in the file,
 * and a fresh clone resets it — but it is available without git and it errs in the safe
 * direction: it can only shrink the evidence a claim is judged on, never inflate it.
 */
const mtimeCache = new Map<string, number>();

/**
 * When this claim's text last changed, and how we know.
 *
 * The repository is asked first: it can date the section rather than the whole file, and a
 * clone does not reset it. Modification time answers for everything outside a repository,
 * which on a typical machine is most of the harness — `~/.claude` is rarely versioned.
 */
function datedSource(
  file: string,
  startLine: number,
  endLine: number,
  kind: ClaimKind,
  context?: ScanContext,
): { modifiedMs: number; datedBy: DateSource } {
  // Only prose sections. They are the claims whose age narrows a verdict, and they are the
  // only ones where a per-section date says anything a per-file one does not: a skill is a
  // file, so the two answers are the same, and paying a process per skill to learn that
  // costs more than the whole transcript scan.
  const worthAsking = kind === 'prose-section' && startLine > 0;
  const fromGit = worthAsking ? sectionChangedMs(file, startLine, endLine) : undefined;
  if (fromGit) return { modifiedMs: fromGit, datedBy: 'git' };
  const fromFs = context ? (snapshotFile(file, context)?.mtimeMs ?? 0) : modifiedMs(file);
  return fromFs > 0 ? { modifiedMs: fromFs, datedBy: 'mtime' } : { modifiedMs: 0, datedBy: 'unknown' };
}

export function modifiedMs(file: string): number {
  const hit = mtimeCache.get(file);
  if (hit !== undefined) return hit;
  let ms = 0;
  try {
    ms = fs.statSync(file).mtimeMs;
  } catch {
    /* unreadable — treated as unknown, which excludes nothing */
  }
  mtimeCache.set(file, ms);
  return ms;
}

/**
 * Prevention detection is surgical by design.
 *
 * A prevention rule is protected from eviction because its yield is inverted — it looks
 * useless precisely because it works. Protection that fires too easily covers the whole
 * harness and the tool reports nothing, so weak markers ("avoid", "security", "don't"),
 * which appear in almost any technical prose, are deliberately excluded.
 *
 * A claim is prevention only when a STRONG prohibition or a secret-family noun appears
 * inside something that actually reads as a rule — a bullet, a numbered item, or a short
 * imperative line. Capability definitions (skills, subagents, MCP servers) are never
 * prevention: they describe what the agent *can* do, not what it must not.
 */
const STRONG_PROHIBITION =
  /\b(never|must not|shall not|do not|refuse to|under no circumstances|ne jamais|il est interdit)\b/i;

const SECRET_NOUNS =
  /\b(secret|credential|password|api key|access token|private key|\.env|exfiltrat)\w*/i;

const WORKFLOW_MARKERS = ['always run', 'before commit', 'before pushing', 'workflow', 'pipeline', 'ci ', 'test suite'];
const STYLE_MARKERS = ['naming', 'convention', 'lint', 'prettier', 'indent', 'formatting', 'tone of voice'];
const ARCH_MARKERS = ['architecture', 'module boundary', 'layering', 'dependency rule', 'directory structure'];

/** Lines that read like a rule rather than prose: bullets, numbered items, short imperatives. */
function ruleLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^([-*+]|\d+[.)]|>)\s+/.test(l) || (l.length > 0 && l.length <= 200));
}

export function inferClass(text: string, kind: ClaimKind): { cls: ClaimClass; inferred: boolean } {
  // Capabilities are not rules. Classifying a design skill as "prevention" would protect
  // it from measurement for no reason.
  if (kind === 'skill' || kind === 'subagent' || kind === 'command' || kind === 'mcp-server') {
    return { cls: 'knowledge', inferred: true };
  }

  const lines = ruleLines(text);
  const isPrevention = lines.some((l) => STRONG_PROHIBITION.test(l) || SECRET_NOUNS.test(l));
  if (isPrevention) return { cls: 'prevention', inferred: true };

  const t = text.toLowerCase();
  const hit = (list: string[]) => list.some((m) => t.includes(m));
  if (hit(WORKFLOW_MARKERS)) return { cls: 'workflow', inferred: true };
  if (hit(ARCH_MARKERS)) return { cls: 'architecture', inferred: true };
  if (hit(STYLE_MARKERS)) return { cls: 'style', inferred: true };
  return { cls: 'unknown', inferred: true };
}

function mkClaim(
  id: string,
  label: string,
  kind: ClaimKind,
  scope: 'project' | 'user',
  loading: Loading,
  file: string,
  startLine: number,
  endLine: number,
  body: string,
  alwaysOnChars?: number,
  context?: ScanContext,
): Claim {
  const { cls, inferred } = inferClass(body, kind);
  return {
    id,
    label,
    kind,
    scope,
    class: cls,
    classInferred: inferred,
    loading,
    source: { file, startLine, endLine, ...datedSource(file, startLine, endLine, kind, context) },
    chars: body.length,
    estTokens: estTokens(body.length),
    alwaysOnTokens:
      loading === 'always-on'
        ? estTokens(alwaysOnChars ?? body.length)
        : estTokens(alwaysOnChars ?? 0),
    protected: cls === 'prevention',
  };
}

/**
 * A skill's frontmatter `name` + `description` is the always-on part: it must be in
 * context for the model to know the skill exists. The body only loads on use.
 */
function skillDescriptionChars(body: string): number {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!fm) return Math.min(body.length, 200);
  const desc = /^description:\s*([\s\S]*?)(?=\r?\n[a-zA-Z_-]+:|$)/m.exec(fm[1]);
  const name = /^name:\s*(.*)$/m.exec(fm[1]);
  return (desc?.[1]?.trim().length ?? 0) + (name?.[1]?.trim().length ?? 0) + 16;
}

/**
 * Split a memory file into claims, one per markdown heading block.
 *
 * Headings are only recognised outside fenced code. A CLAUDE.md that documents a shell
 * workflow is full of lines like `# build the image`, and treating those as headings
 * shreds the real sections into fragments titled after comments — then prices, classifies
 * and proposes demotions for blocks that were never sections at all.
 */
export function extractProseClaims(
  file: string,
  scope: 'project' | 'user',
  displayName?: string,
  /**
   * Shared across every file in one scan. An id is built from the file's name and the
   * section's title, which is what makes it survive an edit — but two files can share a
   * basename, and a collision would silently drop one claim. The counter disambiguates
   * instead.
   */
  used = new Map<string, number>(),
  context?: ScanContext,
): Claim[] {
  if (!fs.existsSync(file)) return [];
  const text = readText(file, context);
  if (text === undefined) return [];
  const name = displayName ?? `${scope === 'user' ? '~/' : ''}${path.basename(file)}`;
  const lines = text.split(/\r?\n/);
  const claims: Claim[] = [];
  let title = '(preamble)';
  let start = 0;
  let buf: string[] = [];

  const flush = (endLine: number) => {
    const body = buf.join('\n').trim();
    if (body.length < 40) return; // ignore trivia
    // The id must survive an edit somewhere else in the file, so it is built from what
    // the section IS, not from where it happens to sit. A line number in the id makes
    // every claim a new claim the moment anything above it grows.
    const base = `${scope}:md:${slug(path.basename(file))}:${slug(title)}`;
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    claims.push(
      mkClaim(n === 0 ? base : `${base}~${n}`, `${name} § ${title}`, 'prose-section', scope, 'always-on', file, start + 1, endLine, body, undefined, context),
    );
  };

  let fence: string | undefined;
  lines.forEach((line, i) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      // An opening fence is closed only by one of the same character, at least as long.
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = undefined;
      buf.push(line);
      return;
    }
    const m = fence ? null : /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush(i);
      title = m[2];
      start = i;
      buf = [line];
    } else {
      buf.push(line);
    }
  });
  flush(lines.length);
  return claims;
}

/** How deep an `@import` chain is followed. Two levels covers every layout seen in the wild. */
const MAX_IMPORT_DEPTH = 2;

/**
 * Files pulled into a memory file with `@path`. Their content is resident exactly like the
 * text around the import line, so leaving them out understates the harness by however much
 * a user has factored out into separate files.
 *
 * A line qualifies only when it resolves to a file that exists, which is a far better guard
 * than any regex: `@mention` in prose resolves to nothing and is skipped.
 */
export function extractImportClaims(
  file: string,
  scope: 'project' | 'user',
  seen = new Set<string>(),
  depth = 0,
  used = new Map<string, number>(),
  context?: ScanContext,
): Claim[] {
  if (depth >= MAX_IMPORT_DEPTH || !fs.existsSync(file)) return [];
  // `seen` holds files whose prose has been claimed. The root goes in so a chain that
  // imports its way back to it stops; every target goes in below, before it is read, which
  // is what keeps a file resident once however many memory files name it.
  if (depth === 0) seen.add(path.resolve(file).toLowerCase());

  const text = readText(file, context);
  if (text === undefined) return [];

  const claims: Claim[] = [];
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const m = /^\s*@(\S+)\s*$/.exec(line);
    if (!m) continue;
    const target = resolveImport(m[1], file);
    if (!target) continue;
    // Resident once, however many memory files name it. The guard below only stops
    // re-entry, so the target is claimed here before anything reads it twice.
    const targetKey = path.resolve(target).toLowerCase();
    if (seen.has(targetKey)) continue;
    seen.add(targetKey);
    const shown = `${path.basename(file)} @${path.basename(target)}`;
    claims.push(...extractProseClaims(target, scope, shown, used, context));
    claims.push(...extractImportClaims(target, scope, seen, depth + 1, used, context));
  }
  return claims;
}

/** Extensions an import may have. A memory file imports prose, not binaries. */
const IMPORTABLE = new Set(['.md', '.markdown', '.txt', '.mdx']);

/** No memory file is a megabyte. Past this it is not prose and we do not price it. */
const MAX_IMPORT_BYTES = 512 * 1024;

/**
 * Resolve an `@path` to a file worth reading.
 *
 * The checks are not paranoia about the user's own memory file — Claude Code follows these
 * imports too. They are about what harnessmeter then does with the content: a claim body
 * is what T2 sends to a model. Reading whatever a path happens to point at, and pricing its
 * byte length as context, is how a private key ends up in a prompt and in a token figure.
 */
function resolveImport(spec: string, from: string): string | undefined {
  const home = path.dirname(claudeHome());
  const raw = spec.startsWith('~') ? path.join(home, spec.slice(1)) : spec;
  const candidate = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(from), raw);
  if (!IMPORTABLE.has(path.extname(candidate).toLowerCase())) return undefined;
  try {
    const st = fs.statSync(candidate);
    return st.isFile() && st.size <= MAX_IMPORT_BYTES ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'section';
}

/** One claim per skill. Skills are on-demand: only the description sits in context by default. */
export function extractSkillClaims(dir: string, scope: 'project' | 'user', plugin?: string, context?: ScanContext): Claim[] {
  if (!fs.existsSync(dir)) return [];
  const claims: Claim[] = [];
  for (const entry of safeReaddir(dir)) {
    const skillFile = path.join(dir, entry, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const body = readText(skillFile, context);
    if (body === undefined) continue;
    const name = qualify(plugin, entry);
    claims.push(
      mkClaim(
        `${scope}:skill:${name}`,
        `skill/${name}`,
        'skill',
        scope,
        'on-demand',
        skillFile,
        1,
        body.split(/\r?\n/).length,
        body,
        skillDescriptionChars(body),
        context,
      ),
    );
  }
  return claims;
}

/** One claim per subagent definition. */
export function extractAgentClaims(dir: string, scope: 'project' | 'user', plugin?: string, context?: ScanContext): Claim[] {
  if (!fs.existsSync(dir)) return [];
  const claims: Claim[] = [];
  for (const f of safeReaddirFiles(dir)) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(dir, f);
    const body = readText(full, context);
    if (body === undefined) continue;
    const name = qualify(plugin, f.replace(/\.md$/, ''));
    claims.push(
      mkClaim(`${scope}:agent:${name}`, `agent/${name}`, 'subagent', scope, 'on-demand', full, 1, body.split(/\r?\n/).length, body, undefined, context),
    );
  }
  return claims;
}

/**
 * One claim per slash command. Like a skill, a command's frontmatter description is what
 * sits in context so the model knows the command exists; the body loads on invocation.
 */
export function extractCommandClaims(
  dir: string,
  scope: 'project' | 'user',
  plugin?: string,
  /** Namespace built from the subdirectories walked so far: `commands/git/sync.md` is `git:sync`. */
  namespace = '',
  depth = 0,
  context?: ScanContext,
): Claim[] {
  if (!fs.existsSync(dir)) return [];
  const claims: Claim[] = [];
  // Commands can be filed into subdirectories, and Claude Code namespaces them by folder.
  // Reading only the top level silently skips every command a tidy user has organised.
  if (depth < 3) {
    for (const sub of safeReaddir(dir)) {
      claims.push(...extractCommandClaims(path.join(dir, sub), scope, plugin, `${namespace}${sub}:`, depth + 1, context));
    }
  }
  for (const f of safeReaddirFiles(dir)) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(dir, f);
    const body = readText(full, context);
    if (body === undefined) continue;
    const name = qualify(plugin, namespace + f.replace(/\.md$/, ''));
    claims.push(
      mkClaim(`${scope}:command:${name}`, `command/${name}`, 'command', scope, 'on-demand', full, 1, body.split(/\r?\n/).length, body, skillDescriptionChars(body), context),
    );
  }
  return claims;
}

function qualify(plugin: string | undefined, name: string): string {
  return plugin ? `${plugin}:${name}` : name;
}

/**
 * Skills, subagents and commands contributed by plugins that are actually loaded.
 *
 * The plugin directory holds two very different things. `marketplaces/` is a CATALOGUE of
 * everything on offer, and `cache/` is where installs land; only the entries named in
 * `installed_plugins.json`, and not switched off in settings, are ever put in front of the
 * model. Walking the tree and counting what it finds prices the catalogue: on the machine
 * this was written against that is 112 claims and 5,005 tokens the model never sees.
 *
 * Inventing cost is the exact error this tool exists to correct, so the manifest is the
 * only source of truth here. No manifest means no claims — never a guess.
 */
export function extractPluginClaims(home: string, cwd?: string, context?: ScanContext): Claim[] {
  const manifest = readJson(path.join(home, 'plugins', 'installed_plugins.json'), context)?.plugins;
  if (!manifest || typeof manifest !== 'object') return [];

  // A plugin can be switched off without being uninstalled, and a disabled plugin costs
  // nothing. Absent settings mean "installed is loaded", which is the usual case.
  const enabled: Record<string, unknown> = {};
  for (const file of [
    path.join(home, 'settings.json'),
    path.join(home, 'settings.local.json'),
    ...(cwd ? [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')] : []),
  ]) {
    const cfg = readJson(file, context)?.enabledPlugins;
    if (cfg && typeof cfg === 'object') Object.assign(enabled, cfg);
  }

  const claims: Claim[] = [];
  const seen = new Set<string>();
  for (const [key, installs] of Object.entries(manifest)) {
    if (enabled[key] === false) continue;
    const plugin = String(key).split('@')[0] || String(key);
    for (const install of Array.isArray(installs) ? installs : [installs]) {
      const root = (install as { installPath?: unknown })?.installPath;
      if (typeof root !== 'string' || !fs.existsSync(root)) continue;
      const norm = path.resolve(root).toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      claims.push(...extractSkillClaims(path.join(root, 'skills'), 'user', plugin, context));
      claims.push(...extractAgentClaims(path.join(root, 'agents'), 'user', plugin, context));
      claims.push(...extractCommandClaims(path.join(root, 'commands'), 'user', plugin, '', 0, context));
      // A plugin can ship an MCP server, whose tool schemas are the most expensive kind of
      // always-on context there is. Its size is only knowable at runtime, like any other
      // server's, but the server itself has to appear in the ledger.
      const servers = readJson(path.join(root, '.mcp.json'), context)?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const server of Object.keys(servers)) {
          claims.push(mcpClaim(server, path.join(root, '.mcp.json')));
        }
      }
    }
  }
  return claims;
}

/**
 * MCP servers. Their tool schemas are always-on and are typically the single largest
 * block of context — but their size is only knowable at runtime, so we do not fabricate
 * a token figure. We record the server and let the evidence layer report usage.
 */
export function extractMcpClaims(cwd: string, context?: ScanContext): Claim[] {
  const servers = new Set<string>();
  const push = (obj: unknown) => {
    if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) servers.add(k);
  };

  push(readJson(path.join(cwd, '.mcp.json'), context)?.mcpServers);
  push(readJson(path.join(claudeHome(), 'settings.json'), context)?.mcpServers);

  const globalCfg = readJson(path.join(path.dirname(claudeHome()), '.claude.json'), context);
  push(globalCfg?.mcpServers);
  const projEntry = globalCfg?.projects?.[cwd] ?? globalCfg?.projects?.[path.resolve(cwd)];
  push(projEntry?.mcpServers);

  return [...servers].map((name) => mcpClaim(name));
}

/** One MCP server, from wherever it was declared. Size is runtime-only, so it is not faked. */
function mcpClaim(name: string, file = '.mcp.json'): Claim {
  return {
    id: `mcp:${name}`,
    label: `mcp/${name}`,
    kind: 'mcp-server' as ClaimKind,
    scope: 'project' as const,
    class: 'knowledge' as ClaimClass,
    classInferred: true,
    loading: 'always-on' as Loading,
    source: { file, startLine: 0, endLine: 0, modifiedMs: 0, datedBy: 'unknown' },
    chars: 0,
    estTokens: 0, // unknowable statically — reported as part of the residual
    alwaysOnTokens: 0,
    protected: false,
  };
}

export type HarnessScan = {
  claims: Claim[];
  files: string[];
  /** Files read while discovering the harness, keyed by absolute lexical path. */
  snapshot: HarnessSnapshot;
  /** Claim text sliced from the same immutable file snapshot as claim extraction. */
  bodies: Map<string, string>;
};

export function scanHarness(cwd: string, options: HarnessScanOptions = {}): HarnessScan {
  const context = scanContext(options);
  const home = claudeHome();
  const projectMd = path.join(cwd, 'CLAUDE.md');
  const projectLocalMd = path.join(cwd, 'CLAUDE.local.md');
  const userMd = path.join(home, 'CLAUDE.md');

  // One seen-set across every root: a file imported by both CLAUDE.md and CLAUDE.local.md
  // is resident once, and counting it twice would inflate the harness estimate.
  const imported = new Set<string>();
  const ids = new Map<string, number>();

  const claims: Claim[] = [
    ...extractProseClaims(projectMd, 'project', undefined, ids, context),
    ...extractImportClaims(projectMd, 'project', imported, 0, ids, context),
    ...extractProseClaims(projectLocalMd, 'project', undefined, ids, context),
    ...extractImportClaims(projectLocalMd, 'project', imported, 0, ids, context),
    ...extractProseClaims(userMd, 'user', undefined, ids, context),
    ...extractImportClaims(userMd, 'user', imported, 0, ids, context),
    ...extractSkillClaims(path.join(cwd, '.claude', 'skills'), 'project', undefined, context),
    ...extractSkillClaims(path.join(home, 'skills'), 'user', undefined, context),
    ...extractAgentClaims(path.join(cwd, '.claude', 'agents'), 'project', undefined, context),
    ...extractAgentClaims(path.join(home, 'agents'), 'user', undefined, context),
    ...extractCommandClaims(path.join(cwd, '.claude', 'commands'), 'project', undefined, '', 0, context),
    ...extractCommandClaims(path.join(home, 'commands'), 'user', undefined, '', 0, context),
    ...extractPluginClaims(home, cwd, context),
    ...extractMcpClaims(cwd, context),
  ];
  // Ids address a claim across runs, and everything downstream keys evidence by id. Two
  // claims sharing one is silent double-counting on one side and a lost verdict on the
  // other, so the invariant is enforced here rather than assumed.
  const byId = new Map<string, Claim>();
  for (const c of claims) if (!byId.has(c.id)) byId.set(c.id, c);
  const unique = [...byId.values()];

  const files = [...new Set(unique.map((c) => c.source.file))];
  const bodies = new Map<string, string>();
  for (const claim of unique) {
    if (claim.source.startLine < 1) continue;
    const entry = context.snapshot.get(path.resolve(claim.source.file));
    if (!entry) continue;
    const lines = entry.text.split(/\r?\n/);
    bodies.set(
      claim.id,
      lines.slice(claim.source.startLine - 1, claim.source.endLine).join('\n'),
    );
  }
  return { claims: unique, files, snapshot: context.snapshot, bodies };
}

function readJson(file: string, context?: ScanContext): any {
  try {
    if (!fs.existsSync(file)) return undefined;
    const text = readText(file, context);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

function safeReaddirFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
  } catch {
    return [];
  }
}
