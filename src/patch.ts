/**
 * Turning a proposal into a diff someone can read.
 *
 * The primary action this project argues for is DEMOTION, not deletion: a CLAUDE.md section
 * that nothing was observed to need moves into a skill, where only its frontmatter
 * description stays resident and the body loads on demand. Up to now the tool described
 * that move in prose and left the editing to the reader, which is the gap between what the
 * README promises and what the CLI does.
 *
 * Two things this deliberately does not do.
 *
 * It never writes to your harness. It emits a patch, prints the command to apply it, and
 * stops. A tool that edits the file it just measured cannot be trusted to have measured it.
 *
 * And it does not pretend to write the description for you. The description is the ONLY
 * part that stays in context after the move, and it is the whole mechanism by which the
 * skill ever loads again — a bad one silences the rule without any error. What is generated
 * is a draft from the heading and the opening sentence, and the patch says so at the top,
 * because that is a judgement about when the rule matters and only its author can make it.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Claim, Proposal } from './types.ts';

/** Lines of unchanged text kept either side of a change, so the hunk can be located. */
const CONTEXT = 3;

export type PatchEntry = {
  claimId: string;
  label: string;
  /** Path the skill will be created at, relative to the root. */
  skillPath: string;
  savingPerSession: number;
  /** Drafted, not decided. See the module comment. */
  description: string;
};

export type PatchSet = {
  /** Directory the patch is expressed relative to, and must be applied from. */
  root: string;
  /** True when that directory is inside a git work tree, which changes the apply command. */
  git: boolean;
  text: string;
  entries: PatchEntry[];
  /** Proposals that could not be turned into a diff, and why. */
  skipped: { label: string; reason: string }[];
};

/** A skill directory name: lowercase, hyphenated, and stable for the same heading. */
export function skillSlug(label: string): string {
  const heading = label.includes('§') ? label.slice(label.lastIndexOf('§') + 1) : label;
  return (
    heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'demoted-section'
  );
}

/**
 * A first draft of the sentence that will decide whether this skill ever loads.
 *
 * Built from the heading and the opening sentence, because those are what the author
 * already wrote about when the rule applies. It is a starting point for a human, not an
 * answer — which is why the patch says so rather than burying it.
 */
export function draftDescription(label: string, body: string): string {
  const heading = (label.includes('§') ? label.slice(label.lastIndexOf('§') + 1) : label).trim();
  // Headings are not prose, and neither is fenced code: a description built out of a shell
  // command says nothing about when the rule applies.
  const lines: string[] = [];
  let fence: string | undefined;
  for (const l of body.split(/\r?\n/)) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence || /^\s{0,3}#{1,6}\s/.test(l) || !l.trim()) continue;
    lines.push(l);
  }
  const prose = lines
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const first = /^(.{20,240}?[.!?])(\s|$)/.exec(prose)?.[1] ?? prose.slice(0, 240);
  const tail = first ? ` ${first}` : '';
  return `Use when working on ${heading.toLowerCase()}.${tail}`.slice(0, 480);
}

/**
 * Quote a description as YAML, safely.
 *
 * A double-quoted YAML scalar interprets backslash escapes, and a memory file is full of
 * backslashes: a regex like `\\d{4}`, a Windows path, an escaped pipe in a table. Wrapped in
 * double quotes those either make the frontmatter unparseable — so the skill never loads,
 * and the rule has been deleted from the memory file for nothing — or silently rewrite the
 * author's words. Escaping only the double quote made one case actively worse, turning the
 * legal `\\"` into the illegal `\\'`.
 *
 * A single-quoted scalar has no escapes at all. Only the quote itself is special, and it is
 * written twice. Newlines and tabs are folded to spaces because a description is one line.
 */
function yamlQuote(s: string): string {
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return "'" + flat.replace(/'/g, "''") + "'";
}

/** The file a demoted section becomes. Only the frontmatter stays resident. */
function skillFile(slug: string, description: string, body: string): string {
  return ['---', `name: ${slug}`, `description: ${yamlQuote(description)}`, '---', '', body.trimEnd(), ''].join('\n');
}

type Deletion = { start: number; end: number };

/**
 * A unified diff that removes the given 1-based line ranges from a file.
 *
 * Demotion only ever deletes a contiguous block and creates a new file, so no general diff
 * algorithm is needed — which is the reason this is worth writing by hand rather than
 * taking a dependency for it.
 *
 * Lines are split on the newline byte alone, keeping any carriage return as part of the
 * line, so the emitted text is byte-identical to the file. Splitting on /\r?\n/ here would
 * produce a patch that cannot apply to a CRLF file.
 */
function deletionDiff(relPath: string, original: string, deletions: Deletion[]): string {
  const endsWithNewline = original.endsWith('\n');
  const lines = original.split('\n');
  if (endsWithNewline) lines.pop(); // the split leaves a trailing empty element

  // Ascending, and ranges close enough that their context would overlap become one hunk.
  const sorted = [...deletions].sort((a, b) => a.start - b.start);
  const groups: Deletion[][] = [];
  for (const d of sorted) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && d.start - prev.end <= CONTEXT * 2 + 1) last.push(d);
    else groups.push([d]);
  }

  const out: string[] = [`diff --git a/${relPath} b/${relPath}`, `--- a/${relPath}`, `+++ b/${relPath}`];
  let offset = 0;

  for (const group of groups) {
    const first = group[0].start;
    const last = group[group.length - 1].end;
    const from = Math.max(1, first - CONTEXT);
    const to = Math.min(lines.length, last + CONTEXT);
    const removed = new Set<number>();
    for (const d of group) for (let i = d.start; i <= d.end; i++) removed.add(i);

    const body: string[] = [];
    let kept = 0;
    for (let i = from; i <= to; i++) {
      const text = lines[i - 1] ?? '';
      if (removed.has(i)) {
        body.push('-' + text);
        if (i === lines.length && !endsWithNewline) body.push('\\ No newline at end of file');
      } else {
        body.push(' ' + text);
        kept++;
        if (i === lines.length && !endsWithNewline) body.push('\\ No newline at end of file');
      }
    }

    const oldCount = to - from + 1;
    out.push(`@@ -${from},${oldCount} +${from + offset},${kept} @@`);
    out.push(...body);
    offset -= oldCount - kept;
  }

  return out.join('\n');
}

/** A unified diff that creates a file that does not exist yet. */
function newFileDiff(relPath: string, content: string): string {
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return [
    `diff --git a/${relPath} b/${relPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => '+' + l),
  ].join('\n');
}

export type PatchInput = {
  claims: Claim[];
  proposals: Proposal[];
  /** Section text as it was when scanned, keyed by claim id. */
  bodies: Map<string, string>;
  /** Where the patch will be applied from. */
  root: string;
  /**
   * Which claims this patch is for.
   *
   * This is the field that decides, not where the file happens to sit. A project normally
   * lives INSIDE the home directory, so a containment test admits every project section
   * into the home patch as well — and the paired skill is then written to the machine-wide
   * skills directory, putting a project's rule in the always-on prefix of every other
   * project. The scope was on the claim all along.
   */
  scope: 'project' | 'user';
  /** Where a skill goes, relative to the root: '.claude/skills' or 'skills'. */
  skillDir: string;
};

/**
 * Build one patch for every demotion whose file lives under `root`.
 *
 * A claim is only turned into a diff when the file on disk still says what it said during
 * the scan. Anything else — the file moved, the section was edited, the target already
 * exists — is skipped with a reason rather than patched hopefully.
 */
export function buildPatch({ claims, proposals, bodies, root, scope, skillDir }: PatchInput): PatchSet {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const entries: PatchEntry[] = [];
  const skipped: { label: string; reason: string }[] = [];
  const perFile = new Map<string, { claim: Claim; proposal: Proposal }[]>();
  const takenSlugs = new Set<string>();

  for (const p of proposals) {
    if (p.action !== 'demote') continue;
    const claim = byId.get(p.claimId);
    if (!claim) continue;
    // Not this patch's claims. Silently, because it is in the other one.
    if (claim.scope !== scope) continue;

    const file = path.resolve(claim.source.file);
    const rel = path.relative(path.resolve(root), file);
    // A belt to the scope braces: a claim of the right scope whose file somehow sits
    // outside the root would produce a diff reaching out of it.
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      skipped.push({ label: p.label, reason: 'lives outside ' + root });
      continue;
    }
    if (claim.source.startLine < 1 || claim.source.endLine < claim.source.startLine) {
      skipped.push({ label: p.label, reason: 'no line range to remove' });
      continue;
    }

    let current: string;
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch {
      skipped.push({ label: p.label, reason: 'file could not be read' });
      continue;
    }

    // The scan is a photograph. If the section has changed since, the patch would be
    // applied to text nobody measured.
    const scanned = bodies.get(claim.id);
    const now = current
      .split(/\r?\n/)
      .slice(claim.source.startLine - 1, claim.source.endLine)
      .join('\n')
      .trim();
    if (!scanned || now !== scanned.trim()) {
      skipped.push({ label: p.label, reason: 'the section changed since the scan' });
      continue;
    }

    const slug = skillSlug(p.label);
    if (takenSlugs.has(slug)) {
      skipped.push({ label: p.label, reason: `another section already claims skills/${slug}` });
      continue;
    }
    const skillRel = path.posix.join(...skillDir.split(/[\\/]/), slug, 'SKILL.md');
    if (fs.existsSync(path.join(root, skillRel))) {
      skipped.push({ label: p.label, reason: `${skillRel} already exists` });
      continue;
    }
    takenSlugs.add(slug);

    const list = perFile.get(file) ?? [];
    list.push({ claim, proposal: p });
    perFile.set(file, list);
    entries.push({
      claimId: claim.id,
      label: p.label,
      skillPath: skillRel,
      savingPerSession: p.savingPerSession,
      description: draftDescription(p.label, scanned),
    });
  }

  const chunks: string[] = [];
  for (const [file, list] of perFile) {
    const rel = path.relative(path.resolve(root), file).split(path.sep).join('/');
    const original = fs.readFileSync(file, 'utf8');
    chunks.push(
      deletionDiff(
        rel,
        original,
        list.map(({ claim }) => ({ start: claim.source.startLine, end: claim.source.endLine })),
      ),
    );
    for (const { claim, proposal } of list) {
      const entry = entries.find((e) => e.claimId === claim.id)!;
      chunks.push(
        newFileDiff(entry.skillPath, skillFile(skillSlug(proposal.label), entry.description, bodies.get(claim.id)!)),
      );
    }
  }

  return {
    root: path.resolve(root),
    git: fs.existsSync(path.join(root, '.git')),
    text: chunks.length ? preamble(entries) + chunks.join('\n') + '\n' : '',
    entries,
    skipped,
  };
}

/**
 * What a reader needs before they apply this.
 *
 * `git apply` and `patch` both ignore everything before the first `diff --git`, so the
 * caveat travels with the file instead of only appearing in a terminal someone has closed.
 */
function preamble(entries: PatchEntry[]): string {
  const lines = [
    'Proposed by harnessmeter. Nothing here has been applied.',
    '',
    'Each section below moves out of your memory file and into a skill, so that only its',
    'description stays in context and the body loads when it is needed.',
    '',
    'READ THE DESCRIPTIONS BEFORE APPLYING. After this move, the description is the only',
    'part the model sees, and it is the entire mechanism by which the skill loads again. It',
    'was drafted from your own heading and opening sentence, which is a starting point, not',
    'a decision: a description that does not say when the rule matters will silence the rule',
    'without any error anywhere.',
    '',
  ];
  for (const e of entries) {
    lines.push(`  ${e.label}`);
    lines.push(`    -> ${e.skillPath}`);
    lines.push(`    saves ~${Math.round(e.savingPerSession).toLocaleString('en-US')} effective tokens per session`);
  }
  lines.push('');
  return lines.join('\n');
}
