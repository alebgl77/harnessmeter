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
import readline from 'node:readline';
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

  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(file);
  } catch {
    return undefined;
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }

      if (typeof e.attributionSkill === 'string') session.skillsUsed.add(e.attributionSkill);
      if (typeof e.attributionMcpServer === 'string')
        session.mcpServersUsed.add(e.attributionMcpServer);
      if (!session.cwd && typeof e.cwd === 'string') session.cwd = e.cwd;
      if (!session.gitBranch && typeof e.gitBranch === 'string') session.gitBranch = e.gitBranch;

      if (e.type !== 'assistant' || !e.message) continue;

      const usage = readUsage(e.message.usage);
      if (!usage) continue;

      const tools: string[] = [];
      for (const b of e.message.content ?? []) {
        if (b?.type !== 'tool_use') continue;
        if (typeof b.name === 'string') tools.push(b.name);
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
        timestamp: typeof e.timestamp === 'string' ? e.timestamp : undefined,
      };

      if (session.turns.length === 0) {
        session.firstTurnPromptTokens =
          usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5m + usage.cacheWrite1h;
      }
      session.turns.push(turn);
    }
  } finally {
    rl.close();
    stream.close();
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

  const sessions: Session[] = [];
  for (const { file, project } of picked) {
    const s = await readSession(file, project);
    if (s) sessions.push(s);
  }
  return sessions;
}
