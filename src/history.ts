/**
 * When a claim's text last changed, from the repository rather than from the filesystem.
 *
 * 0.2.1 dated a claim by its file's modification time, which is a blunt instrument in three
 * ways it documented and could not fix: it moves when anything in the file changes, it is
 * reset by a clone or a checkout, and it says nothing about what the text used to be. Git
 * knows all three, for the files that live in a repository.
 *
 * The cost matters. Asking `git log -L` per claim is about 70 ms each — six seconds on a
 * harness with eighty claims, seven times the whole scan. One `git blame --line-porcelain`
 * per file returns the commit behind every line at once, for about 100 ms, and a real
 * harness has a handful of files. So blame per file, then read off the lines a claim spans.
 *
 * Everything here fails closed. No git, no repository, a detached worktree, a timeout, an
 * unreadable file: the caller falls back to modification time and the report says which
 * clock it used. A wrong date is worse than a coarse one, because it silently changes which
 * sessions a claim is judged against.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** How a claim's date was established. Reported, because the two are not equally good. */
export type DateSource = 'git' | 'mtime' | 'unknown';

/** Git is not allowed to hold up a scan. Past this, we take the filesystem's word for it. */
const GIT_TIMEOUT_MS = 3000;

/** Blame output for a file, as epoch milliseconds per 1-based line. */
type Blame = number[];

const blameCache = new Map<string, Blame | undefined>();
const repoCache = new Map<string, boolean>();

function run(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/**
 * Is this file inside a git work tree?
 *
 * Cached per directory, and an ancestor already known NOT to be a repository settles every
 * directory beneath it without another process. That matters: a harness has one directory
 * per skill, and asking git seventy-five times costs more than the entire transcript scan.
 */
function inRepo(dir: string): boolean {
  const hit = repoCache.get(dir);
  if (hit !== undefined) return hit;

  for (let up = path.dirname(dir); ; up = path.dirname(up)) {
    const known = repoCache.get(up);
    if (known === false) {
      repoCache.set(dir, false);
      return false;
    }
    if (known !== undefined) break;
    if (path.dirname(up) === up) break;
  }

  const out = run(['rev-parse', '--is-inside-work-tree'], dir);
  const ok = out?.trim() === 'true';
  repoCache.set(dir, ok);
  return ok;
}

/**
 * The commit time behind every line of a file.
 *
 * A line that is modified but not yet committed is blamed on the all-zero commit, and git
 * reports the current time for it — which is the honest answer: that text changed just now,
 * and no session has run against it.
 */
function blame(file: string): Blame | undefined {
  const cached = blameCache.get(file);
  if (cached !== undefined || blameCache.has(file)) return cached;

  const dir = path.dirname(file);
  let out: string | undefined;
  if (inRepo(dir)) {
    out = run(['blame', '--line-porcelain', '--', path.basename(file)], dir);
  }

  let lines: Blame | undefined;
  if (out) {
    lines = [0]; // index 0 unused; blame is 1-based
    let pending = 0;
    for (const line of out.split('\n')) {
      if (line.startsWith('author-time ')) {
        pending = Number(line.slice(12).trim()) * 1000;
      } else if (line.startsWith('\t')) {
        // The content line closes each porcelain record, in file order.
        lines.push(Number.isFinite(pending) ? pending : 0);
      }
    }
    if (lines.length <= 1) lines = undefined;
  }

  blameCache.set(file, lines);
  return lines;
}

/**
 * When the text between these lines last changed, as epoch milliseconds.
 *
 * The most recent commit touching any line the claim spans: if one line of a rule was
 * rewritten yesterday, the rule as it now reads is a day old, whatever the rest of it says.
 * Returns undefined when git cannot answer, which is not a failure — it is the signal to
 * use the filesystem instead.
 */
export function sectionChangedMs(
  file: string,
  startLine: number,
  endLine: number,
): number | undefined {
  const lines = blame(file);
  if (!lines) return undefined;
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length - 1, Math.max(from, endLine));
  let newest = 0;
  for (let i = from; i <= to; i++) if (lines[i] > newest) newest = lines[i];
  return newest > 0 ? newest : undefined;
}

/** Drop everything remembered. Tests build repositories and then change them. */
export function resetHistoryCache(): void {
  blameCache.clear();
  repoCache.clear();
}
