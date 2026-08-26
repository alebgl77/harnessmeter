/**
 * Transcript reader.
 *
 * Claude Code writes one JSONL file per session under ~/.claude/projects/<encoded-cwd>/.
 * Assistant entries carry `message.usage` with the tokens that were actually billed,
 * including the 5m/1h cache-write split. We read those numbers; we never estimate them.
 *
 * Nothing leaves this machine and no message content is retained — only counts, tool
 * names, and attribution fields.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Session, Turn, TurnUsage } from './types.ts';

export function claudeHome(): string {
  return process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude');
}

export function projectsRoot(): string {
  return path.join(claudeHome(), 'projects');
}

/**
 * Claude Code encodes a cwd as a directory name by replacing every character that is not
 * alphanumeric with a dash — and it does NOT collapse runs of dashes. `C:\Users` becomes
 * `C--Users`, not `C-Users`; `~/.config/x` becomes `-home-u--config-x`.
 *
 * Collapsing them here matched none of the directories Claude Code actually writes, so the
 * default invocation could never find the project it was standing in.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function listProjectDirs(): string[] {
  const root = projectsRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Match a working directory to its transcript directory.
 *
 * Exact encoding first, then each parent in turn: a run from `project/src` belongs to the
 * session recorded for `project`. Nothing looser than that — a substring or suffix match
 * can silently select a different project, and reporting the wrong project's sessions is
 * worse than reporting none.
 */
export function findProjectDir(cwd: string): string | undefined {
  const dirs = listProjectDirs();
  const exact = new Set(dirs);
  const folded = new Map<string, string>();
  for (const d of dirs) if (!folded.has(d.toLowerCase())) folded.set(d.toLowerCase(), d);

  // Above the home directory nothing is a project, and a directory registered for a very
  // high ancestor would otherwise answer for every unrelated repository beneath it.
  const home = path.resolve(os.homedir());

  const match = (key: string): string | undefined => {
    if (exact.has(key)) return key;

    // Case folding is a fallback, not the primary key: on a case-sensitive filesystem
    // /home/u/proj and /home/u/PROJ are two directories, and conflating them would report
    // one project's sessions as the other's.
    if (!CASE_SENSITIVE_FS) {
      const ci = folded.get(key.toLowerCase());
      if (ci) return ci;
    }

    // Claude Code shortens a very long directory name and appends a discriminator. We do
    // not know how that suffix is built, so we match on the part we can reproduce and
    // accept it only when exactly one directory starts with it.
    if (key.length > TRUNCATED_NAME_PREFIX) {
      const head = key.slice(0, TRUNCATED_NAME_PREFIX);
      const hits = dirs.filter((d) => d.startsWith(head));
      if (hits.length === 1) return hits[0];
    }
    return undefined;
  };

  // A run from project/src belongs to project, so the walk climbs; the deepest match is
  // the most specific one. Claude Code and harnessmeter both take their working directory
  // from process.cwd(), which resolves symbolic links, so both see the same path and no
  // link-following is needed here.
  let dir = path.resolve(cwd);
  for (let up = 0; up <= MAX_PARENT_WALK; up++) {
    const hit = match(encodeCwd(dir));
    if (hit) return hit;
    if (dir === home) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** How far up the tree a run may be attributed to an ancestor's project directory. */
const MAX_PARENT_WALK = 16;

/** Claude Code keeps this many characters of a long directory name before shortening it. */
const TRUNCATED_NAME_PREFIX = 200;

/**
 * Whether two paths differing only in case are two different directories. Windows and the
 * default macOS volume say no; Linux says yes. Getting this backwards either misses a
 * project or reports someone else's.
 */
const CASE_SENSITIVE_FS = process.platform !== 'win32' && process.platform !== 'darwin';

function emptyUsage(): TurnUsage {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    outputTokens: 0,
  };
}

function readUsage(raw: any): TurnUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const created = raw.cache_creation ?? {};
  const total = num(raw.cache_creation_input_tokens);
  const w5 = num(created.ephemeral_5m_input_tokens);
  const w1 = num(created.ephemeral_1h_input_tokens);
  // Older transcripts omit the TTL split; fall back to the conservative 5m rate.
  const split = w5 + w1;
  return {
    inputTokens: num(raw.input_tokens),
    cacheReadTokens: num(raw.cache_read_input_tokens),
    cacheWrite5m: split > 0 ? w5 : total,
    cacheWrite1h: split > 0 ? w1 : 0,
    outputTokens: num(raw.output_tokens),
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * One assistant RESPONSE, and the turns already folded in, keyed by the response id.
 *
 * Claude Code writes one JSONL entry per content block, so a single API response arrives
 * as several lines — thinking, then text, then one per tool_use — every one of them
 * carrying a copy of the SAME `message.usage`. That usage was billed once. Treating each
 * line as a turn counts the same bill two to five times over: on a real corpus, 19,663
 * entries for 9,064 responses, and every billed figure inflated 2.4x.
 *
 * So responses are folded by id. The tool calls, which really are spread across the
 * entries, are merged into the one turn; the usage is taken once and never again.
 */
type ResponseIndex = Map<string, Turn>;

/**
 * The only two markers a line can carry that make it worth reading, as bytes.
 *
 * An assistant entry's JSON necessarily contains the literal `"assistant"`, and an
 * attribution marker contains `attribution`. Everything else — overwhelmingly tool_result
 * payloads, which is where the bulk of a transcript's weight lives — cannot contribute a
 * turn, a skill, a server or a subagent. Over-approximation only: prose that happens to
 * mention "assistant" costs one wasted parse, never a lost turn.
 */
const MARK_ASSISTANT = Buffer.from('"assistant"');
const MARK_ATTRIBUTION = Buffer.from('attribution');
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

/**
 * How much of a long line is searched for the markers.
 *
 * An assistant entry declares itself in its own preamble — measured across a 400 MB corpus,
 * `"assistant"` never appears later than byte 170 of such a line — so a kilobyte is six
 * times the margin needed. What lies past it is the message payload, and a payload cannot
 * turn a line into an assistant entry.
 */
const HEAD_SCAN_BYTES = 1024;

/**
 * A line no longer than this is searched in full.
 *
 * The attribution fields are set on assistant entries, which the head scan already catches;
 * this covers the other shape a marker could take — a small standalone record — without
 * paying to search megabyte tool results for a word that, in a payload that size, can only
 * be prose. Short lines are a rounding error of the bytes and most of the count, so
 * scanning them whole costs nothing worth measuring.
 */
const FULL_SCAN_BYTES = 8 * 1024;

/**
 * Can this line contribute anything, judged without decoding it?
 *
 * Searching all 400 MB for two needles was the single most expensive thing a scan did —
 * more than reading the files off disk, more than parsing the JSON that matters.
 */
function isCandidate(buf: Buffer, start: number, end: number): boolean {
  const stop = end - start <= FULL_SCAN_BYTES ? end : start + HEAD_SCAN_BYTES;
  const head = buf.subarray(start, stop);
  return head.includes(MARK_ASSISTANT) || head.includes(MARK_ATTRIBUTION);
}

/**
 * Decide on the raw bytes whether a line can matter, and decode it only if it can.
 *
 * UTF-8 decoding a 400 MB corpus to find the 36 MB of assistant entries inside it is most
 * of what a scan used to spend its time on. The markers are pure ASCII, so searching the
 * bytes is exact; a newline byte cannot occur inside a multi-byte character, so a line
 * boundary found this way is always a real one.
 */
function ingestBytes(
  session: Session,
  buf: Buffer,
  start: number,
  end: number,
  seen: ResponseIndex,
): void {
  if (end - start < 2 || !isCandidate(buf, start, end)) return;
  ingestLine(session, buf.toString('utf8', start, end), seen);
}

/** Fold one decoded JSONL line into the session. Shared by both readers. */
function ingestLine(session: Session, line: string, seen: ResponseIndex): void {
  if (!line.trim()) return;
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }

  if (typeof e.attributionSkill === 'string') session.skillsUsed.add(e.attributionSkill);
  if (typeof e.attributionMcpServer === 'string')
    session.mcpServersUsed.add(e.attributionMcpServer);
  if (!session.cwd && typeof e.cwd === 'string') session.cwd = e.cwd;
  if (!session.gitBranch && typeof e.gitBranch === 'string') session.gitBranch = e.gitBranch;

  if (e.type !== 'assistant' || !e.message) return;

  const usage = readUsage(e.message.usage);
  if (!usage) return;

  const tools: string[] = [];
  const commands: string[] = [];
  for (const b of e.message.content ?? []) {
    if (b?.type !== 'tool_use') continue;
    if (typeof b.name === 'string') tools.push(b.name);
    // Every shell invocation is just "Bash" by name, so a rule that prescribes a
    // command is invisible without the command line itself. Truncated: we only ever
    // regex-match against it, and it never leaves the machine.
    if ((b.name === 'Bash' || b.name === 'PowerShell') && typeof b.input?.command === 'string') {
      commands.push(b.input.command.slice(0, 400));
    }
    // Subagent dispatch: the Task tool carries the agent type in its input.
    const sub = b.input?.subagent_type;
    if (typeof sub === 'string') session.subagentsUsed.add(sub);
    // MCP tools are named mcp__<server>__<tool>
    const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(String(b.name ?? ''));
    if (m) session.mcpServersUsed.add(m[1]);
  }

  // The response id, falling back to the request id. An entry carrying neither is folded
  // on its own rather than merged into someone else's turn.
  const id =
    (typeof e.message.id === 'string' && e.message.id) ||
    (typeof e.requestId === 'string' && e.requestId) ||
    undefined;

  const already = id ? seen.get(id) : undefined;
  if (already) {
    // Same billed response, another content block. Take the tool calls, leave the bill.
    already.tools.push(...tools);
    already.commands.push(...commands);
    return;
  }

  const turn: Turn = {
    model: String(e.message.model ?? 'unknown'),
    usage,
    tools,
    commands,
    timestamp: typeof e.timestamp === 'string' ? e.timestamp : undefined,
  };
  if (id) seen.set(id, turn);

  if (session.turns.length === 0) {
    session.firstTurnPromptTokens =
      usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5m + usage.cacheWrite1h;
  }
  session.turns.push(turn);
}

/**
 * Files up to this size are read in one call and split, which is several times faster
 * than readline's per-line event machinery. Larger transcripts (rare — p95 on a busy
 * machine is under 2 MB) fall back to streaming so memory stays bounded even with
 * concurrent reads.
 */
const BUFFERED_READ_LIMIT = 8 * 1024 * 1024;

export async function readSession(file: string, project: string): Promise<Session | undefined> {
  const session: Session = {
    id: path.basename(file, '.jsonl'),
    project,
    turns: [],
    skillsUsed: new Set(),
    mcpServersUsed: new Set(),
    subagentsUsed: new Set(),
    firstTurnPromptTokens: 0,
    prefixWrites: 1,
    cacheTtl: '5m',
  };

  // Responses already folded in, so a multi-block response is one turn and one bill.
  const seen: ResponseIndex = new Map();

  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return undefined;
  }

  if (size <= BUFFERED_READ_LIMIT) {
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(file);
    } catch {
      return undefined;
    }
    // Newline-delimited, and JSON.parse tolerates a trailing \r, so CRLF needs no special
    // case. Scanning for the byte beats splitting into an array of every line in the file.
    for (let start = 0; start <= buf.length; ) {
      const nl = buf.indexOf(NEWLINE, start);
      const end = nl < 0 ? buf.length : nl;
      ingestBytes(session, buf, start, end, seen);
      if (nl < 0) break;
      start = nl + 1;
    }
  } else {
    // Manual chunk splitting instead of readline: same bounded memory (one chunk plus
    // the longest pending line), a fraction of the per-line event overhead.
    let stream: fs.ReadStream;
    try {
      // No encoding: chunks arrive as Buffers so the marker test runs before any decode.
      stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    } catch {
      return undefined;
    }
    try {
      // Annotated, not inferred: Buffer.concat and Buffer.subarray disagree on the
      // buffer generic, and the inferred type from EMPTY is the narrower of the two.
      let carry: Buffer = EMPTY;
      for await (const chunk of stream) {
        const buf = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
        let start = 0;
        for (;;) {
          const nl = buf.indexOf(NEWLINE, start);
          if (nl < 0) break;
          ingestBytes(session, buf, start, nl, seen);
          start = nl + 1;
        }
        // Bounded memory: one chunk plus the longest line still waiting for its newline.
        carry = start < buf.length ? buf.subarray(start) : EMPTY;
      }
      if (carry.length) ingestBytes(session, carry, 0, carry.length, seen);
    } finally {
      stream.close();
    }
  }

  // Synthetic and error-only transcripts carry no signal.
  if (session.turns.length === 0) return undefined;

  measureCache(session);
  return session;
}


/**
 * How the cache actually behaved this session: how many times the resident prefix had to
 * be paid for, and at which TTL. Both are read off the turns rather than assumed.
 *
 * A single pass after ingestion, so the two readers share it and cannot drift.
 */
function measureCache(session: Session): void {
  let w5 = 0;
  let w1 = 0;
  let cold = 0;
  session.turns.forEach((t, i) => {
    w5 += t.usage.cacheWrite5m;
    w1 += t.usage.cacheWrite1h;
    if (i > 0 && isColdPrefix(t.usage)) cold++;
  });
  // The first turn always writes the prefix; every cold turn after it writes it again.
  session.prefixWrites = 1 + cold;
  session.cacheTtl = w1 > w5 ? '1h' : '5m';
}

/**
 * Did this turn have to re-write the resident prefix?
 *
 * The turn is compared against itself, not against a yardstick. On a warm turn the prompt
 * is READ back out of the cache and only the new tail is written, so reads dwarf writes.
 * When the cache has expired — or compaction rebuilt the prompt, or a harness file changed
 * — there is nothing to read and the whole prompt is written instead, so writes exceed
 * reads. That inequality is the signal.
 *
 * The obvious alternative is to compare against the first turn's prompt size, but that
 * number is an upper bound on the resident prefix (it also contains the opening user
 * message), and the count then swings with the bound's error rather than with the cache:
 * scaling that yardstick by half moved the corpus median from seven writes to one. A test
 * a turn can answer about itself has no such knob.
 */
function isColdPrefix(u: TurnUsage): boolean {
  return u.cacheWrite5m + u.cacheWrite1h > u.cacheReadTokens;
}

export type ScanOptions = {
  /** Limit to a single project directory name. Omit to scan every project. */
  project?: string;
  /** Hard cap on sessions read, newest first. */
  limit?: number;
};

export async function scanSessions(opts: ScanOptions = {}): Promise<Session[]> {
  const root = projectsRoot();
  if (!fs.existsSync(root)) return [];

  const dirs = opts.project ? [opts.project] : listProjectDirs();
  const files: { file: string; project: string; mtime: number }[] = [];

  for (const d of dirs) {
    const dir = path.join(root, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      try {
        files.push({ file: full, project: d, mtime: fs.statSync(full).mtimeMs });
      } catch {
        /* unreadable file — skip */
      }
    }
  }

  files.sort((a, b) => b.mtime - a.mtime);
  const picked = opts.limit ? files.slice(0, opts.limit) : files;

  // Bounded read pool: transcripts are independent, so overlap their I/O and parsing.
  // Results land by index, which keeps the newest-first order deterministic. The cap
  // times BUFFERED_READ_LIMIT also bounds peak memory.
  const CONCURRENCY = 8;
  const slots: (Session | undefined)[] = new Array(picked.length);
  let next = 0;
  const worker = async () => {
    while (next < picked.length) {
      const i = next++;
      const { file, project } = picked[i];
      slots[i] = await readSession(file, project);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, picked.length) }, () => worker()),
  );
  return slots.filter((s): s is Session => s !== undefined);
}
