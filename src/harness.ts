/**
 * Harness discovery and claim extraction.
 *
 * A "claim" is an addressable block of the harness that holds a lease on context:
 * a CLAUDE.md section, a skill, a subagent, an MCP server, a hook.
 *
 * Per-claim token figures here are CALIBRATED ESTIMATES derived from character counts.
 * Session-level costs (pricing.ts / transcript.ts) are exact. The report keeps the two
 * apart, always.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Claim, ClaimClass, ClaimKind, Loading } from './types.ts';
import { claudeHome } from './transcript.ts';

/** Rough but honest. Claude's tokenizer is not public; tiktoken is a different tokenizer. */
export const CHARS_PER_TOKEN = 3.8;

export function estTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

/**
 * Prevention detection has to be surgical.
 *
 * A prevention rule is protected from eviction because its yield is inverted — it looks
 * useless precisely because it works. But protection that fires too easily swallows the
 * whole harness and the tool reports nothing. Weak markers ("avoid", "security", "don't")
 * appear in almost any technical prose, so they are deliberately not here.
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
  if (kind === 'skill' || kind === 'subagent' || kind === 'mcp-server') {
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
  loading: Loading,
  file: string,
  startLine: number,
  endLine: number,
  body: string,
  alwaysOnChars?: number,
): Claim {
  const { cls, inferred } = inferClass(body, kind);
  return {
    id,
    label,
    kind,
    class: cls,
    classInferred: inferred,
    loading,
    source: { file, startLine, endLine },
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

/** Split a CLAUDE.md into claims, one per markdown heading block. */
export function extractProseClaims(file: string, scope: 'project' | 'user'): Claim[] {
  if (!fs.existsSync(file)) return [];
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const claims: Claim[] = [];
  let title = '(preamble)';
  let start = 0;
  let buf: string[] = [];

  const flush = (endLine: number) => {
    const body = buf.join('\n').trim();
    if (body.length < 40) return; // ignore trivia
    const id = `${scope}:claude-md:${slug(title)}:${start}`;
    claims.push(
      mkClaim(id, `${scope === 'user' ? '~/' : ''}CLAUDE.md § ${title}`, 'prose-section', 'always-on', file, start + 1, endLine, body),
    );
  };

  lines.forEach((line, i) => {
    const m = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
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

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'section';
}

/** One claim per skill. Skills are on-demand: only the description sits in context by default. */
export function extractSkillClaims(dir: string, scope: 'project' | 'user'): Claim[] {
  if (!fs.existsSync(dir)) return [];
  const claims: Claim[] = [];
  for (const entry of safeReaddir(dir)) {
    const skillFile = path.join(dir, entry, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    let body = '';
    try {
      body = fs.readFileSync(skillFile, 'utf8');
    } catch {
      continue;
    }
    claims.push(
      mkClaim(
        `${scope}:skill:${entry}`,
        `skill/${entry}`,
        'skill',
        'on-demand',
        skillFile,
        1,
        body.split(/\r?\n/).length,
        body,
        skillDescriptionChars(body),
      ),
    );
  }
  return claims;
}

/** One claim per subagent definition. */
export function extractAgentClaims(dir: string, scope: 'project' | 'user'): Claim[] {
  if (!fs.existsSync(dir)) return [];
  const claims: Claim[] = [];
  for (const f of safeReaddirFiles(dir)) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(dir, f);
    let body = '';
    try {
      body = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const name = f.replace(/\.md$/, '');
    claims.push(
      mkClaim(`${scope}:agent:${name}`, `agent/${name}`, 'subagent', 'on-demand', full, 1, body.split(/\r?\n/).length, body),
    );
  }
  return claims;
}

/**
 * MCP servers. Their tool schemas are always-on and are typically the single largest
 * block of context — but their size is only knowable at runtime, so we do not fabricate
 * a token figure. We record the server and let the evidence layer report usage.
 */
export function extractMcpClaims(cwd: string): Claim[] {
  const servers = new Set<string>();
  const push = (obj: unknown) => {
    if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) servers.add(k);
  };

  push(readJson(path.join(cwd, '.mcp.json'))?.mcpServers);
  push(readJson(path.join(claudeHome(), 'settings.json'))?.mcpServers);

  const globalCfg = readJson(path.join(path.dirname(claudeHome()), '.claude.json'));
  push(globalCfg?.mcpServers);
  const projEntry = globalCfg?.projects?.[cwd] ?? globalCfg?.projects?.[path.resolve(cwd)];
  push(projEntry?.mcpServers);

  return [...servers].map((name) => ({
    id: `mcp:${name}`,
    label: `mcp/${name}`,
    kind: 'mcp-server' as ClaimKind,
    class: 'knowledge' as ClaimClass,
    classInferred: true,
    loading: 'always-on' as Loading,
    source: { file: '.mcp.json', startLine: 0, endLine: 0 },
    chars: 0,
    estTokens: 0, // unknowable statically — reported as part of the residual
    alwaysOnTokens: 0,
    protected: false,
  }));
}

export type HarnessScan = {
  claims: Claim[];
  files: string[];
};

export function scanHarness(cwd: string): HarnessScan {
  const home = claudeHome();
  const claims: Claim[] = [
    ...extractProseClaims(path.join(cwd, 'CLAUDE.md'), 'project'),
    ...extractProseClaims(path.join(home, 'CLAUDE.md'), 'user'),
    ...extractSkillClaims(path.join(cwd, '.claude', 'skills'), 'project'),
    ...extractSkillClaims(path.join(home, 'skills'), 'user'),
    ...extractAgentClaims(path.join(cwd, '.claude', 'agents'), 'project'),
    ...extractAgentClaims(path.join(home, 'agents'), 'user'),
    ...extractMcpClaims(cwd),
  ];
  const files = [...new Set(claims.map((c) => c.source.file))];
  return { claims, files };
}

function readJson(file: string): any {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
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
