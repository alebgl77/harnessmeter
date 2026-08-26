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

/** Claude Code encodes a cwd as a directory name by replacing separators with dashes. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[\\/:]/g, '-').replace(/-+/g, '-');
}

export function listProjectDirs(): string[] {
  const root = projectsRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Best-effort match of a working directory to its transcript directory. */
export function findProjectDir(cwd: string): string | undefined {
  const target = encodeCwd(path.resolve(cwd)).toLowerCase();
  const dirs = listProjectDirs();
  let best: string | undefined;
  for (const d of dirs) {
    const norm = d.toLowerCase();
    if (norm === target) return d;
    if (target.endsWith(norm) || norm.endsWith(target)) {
      if (!best || d.length > best.length) best = d;
    }
  }
  return best;
}

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

/** Fold one JSONL line into the session. Shared by the buffered and streaming readers. */
function ingestLine(session: Session, line: string): void {
  if (!line.trim()) return;
  // Cheap substring pre-filter before the expensive JSON.parse. Once cwd and gitBranch
  // are known, the only lines that can still contribute are assistant turns (their JSON
  // necessarily contains the literal "assistant") and attribution markers. Everything
  // else — chiefly huge tool_result payloads — is skipped unparsed. Over-approximation
  // only: a prose mention of "assistant" costs one wasted parse, never a lost turn.
  if (
    session.cwd &&
    session.gitBranch &&
    !line.includes('"assistant"') &&
    !line.includes('attribution')
  ) {
    return;
  }
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

  const turn: Turn = {
    model: String(e.message.model ?? 'unknown'),
    usage,
    tools,
    commands,
    timestamp: typeof e.timestamp === 'string' ? e.timestamp : undefined,
  };

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
  };

  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return undefined;
  }

  if (size <= BUFFERED_READ_LIMIT) {
    let text: string;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      return undefined;
    }
    // JSON.parse tolerates a trailing \r, so a plain newline split handles CRLF too.
    for (const line of text.split('\n')) ingestLine(session, line);
  } else {
    // Manual chunk splitting instead of readline: same bounded memory (one chunk plus
    // the longest pending line), a fraction of the per-line event overhead.
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
    } catch {
      return undefined;
    }
    try {
      let carry = '';
      for await (const chunk of stream) {
        const parts = (carry + chunk).split('\n');
        carry = parts.pop() ?? '';
        for (const line of parts) ingestLine(session, line);
      }
      if (carry) ingestLine(session, carry);
    } finally {
      stream.close();
    }
  }

  // Synthetic and error-only transcripts carry no signal.
  if (session.turns.length === 0) return undefined;
  return session;
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
