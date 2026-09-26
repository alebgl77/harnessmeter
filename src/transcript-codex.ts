/**
 * Local Codex rollout reader. Only metadata, token counts and tool signatures survive.
 * Schema: openai/codex codex-rs/protocol/src/{protocol,models}.rs and rollout/src/tests.rs.
 * TokenCountInfo totals are cumulative; cached input and reasoning output are subsets.
 * Claude TTL economics and API dollar prices cannot be read from these rollouts.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Session, Turn, TurnUsage } from './types.ts';

export function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

/** Stable exact project identity, including Windows paths read on another platform. */
export function codexProjectId(cwd: string): string {
  let resolved = cwd;
  try { resolved = fs.realpathSync.native(cwd); } catch { /* deleted/off-host project */ }
  const windows = /^[A-Za-z]:[\\/]/.test(resolved) || resolved.startsWith('\\\\');
  if (windows) return path.win32.normalize(resolved).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const normalized = path.resolve(resolved).replace(/\/$/, '') || '/';
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : undefined;
}
function decode(line: string): RecordValue | undefined {
  try { return record(JSON.parse(line)); } catch { return undefined; }
}
function metric(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
const zeroUsage = (): TurnUsage => ({
  inputTokens: 0, cacheReadTokens: 0, cacheWrite5m: 0, cacheWrite1h: 0, outputTokens: 0,
});
type Counters = { input: number; cached: number; output: number; reasoning: number };
function counters(raw: unknown): Counters | undefined {
  const value = record(raw);
  if (!value || !metric(value.input_tokens) || !metric(value.cached_input_tokens) || !metric(value.output_tokens)) return;
  const reasoning = value.reasoning_output_tokens ?? 0;
  if (!metric(reasoning) || value.cached_input_tokens > value.input_tokens || reasoning > value.output_tokens) return;
  if ('total_tokens' in value && (!metric(value.total_tokens) || value.total_tokens !== value.input_tokens + value.output_tokens)) return;
  if ('cache_write_input_tokens' in value && (!metric(value.cache_write_input_tokens) || value.cache_write_input_tokens > value.input_tokens)) return;
  return { input: value.input_tokens, cached: value.cached_input_tokens, output: value.output_tokens, reasoning };
}
function usageFor(value: Counters): TurnUsage {
  return { ...zeroUsage(), inputTokens: value.input - value.cached, cacheReadTokens: value.cached, outputTokens: value.output };
}
function equal(a: Counters, b: Counters): boolean {
  return a.input === b.input && a.cached === b.cached && a.output === b.output && a.reasoning === b.reasoning;
}
function delta(a: Counters, b: Counters): Counters | undefined {
  const value = { input: a.input - b.input, cached: a.cached - b.cached, output: a.output - b.output, reasoning: a.reasoning - b.reasoning };
  return Object.values(value).every(metric) && value.cached <= value.input && value.reasoning <= value.output ? value : undefined;
}

/** Read line by line with a hard cap; oversized or truncated records cannot exhaust RAM. */
async function readLines(file: string, ingest: (line: string) => void): Promise<boolean> {
  const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
  const maxBytes = 16 * 1024 * 1024;
  let fragments: Buffer[] = [];
  let length = 0;
  let discard = false;
  const finish = () => {
    if (!discard && length > 0) ingest(Buffer.concat(fragments, length).toString('utf8'));
    fragments = [];
    length = 0;
    discard = false;
  };
  try {
    for await (const raw of stream) {
      const chunk = raw as Buffer;
      for (let start = 0; start < chunk.length;) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline < 0 ? chunk.length : newline;
        if (!discard) {
          length += end - start;
          if (length > maxBytes) { discard = true; fragments = []; }
          else fragments.push(chunk.subarray(start, end));
        }
        if (newline < 0) break;
        finish();
        start = newline + 1;
      }
    }
    finish();
    return true;
  } catch { return false; }
  finally { stream.destroy(); }
}

/** Read one rollout. Ambiguous multi-project/forked histories are excluded conservatively. */
export async function readCodexSession(file: string): Promise<Session | undefined> {
  const session: Session = {
    id: path.basename(file, '.jsonl'), provider: 'codex', cacheEconomicsKnown: false,
    project: '', turns: [], skillsUsed: new Set(), mcpServersUsed: new Set(), subagentsUsed: new Set(),
    firstTurnPromptTokens: 0, prefixWrites: 0, cacheTtl: '5m',
  };
  let model = 'unknown';
  let pending: Turn | undefined;
  let previous: Counters = { input: 0, cached: 0, output: 0, reasoning: 0 };
  let sawTotal = false;
  let continuousCounters = true;
  let sawMeta = false;
  let ambiguous = false;
  const seenCalls = new Set<string>();
  const begin = (timestamp?: string): Turn => pending ??= {
    model, usage: zeroUsage(), usageKnown: false, tools: [], commands: [], timestamp,
  };
  const flush = () => {
    if (pending) session.turns.push(pending);
    pending = undefined;
  };
  const setCwd = (cwd: unknown) => {
    if (typeof cwd !== 'string' || !cwd) return;
    const identity = codexProjectId(cwd);
    if (session.project && identity !== session.project) ambiguous = true;
    else { session.cwd = cwd; session.project = identity; }
  };
  const success = await readLines(file, (line) => {
    const entry = decode(line);
    const payload = record(entry?.payload);
    if (!entry || !payload) return;
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
    if (entry.type === 'session_meta') {
      // Fork rollouts can embed earlier metadata and inherited usage. Never count that
      // history a second time or switch ownership to an embedded parent's session.
      if (sawMeta) return;
      sawMeta = true;
      if (typeof payload.id === 'string' && payload.id) session.id = payload.id;
      if (payload.forked_from_id || payload.history_base) ambiguous = true;
      setCwd(payload.cwd);
      const git = record(payload.git);
      if (typeof git?.branch === 'string') session.gitBranch = git.branch;
      return;
    }
    if (entry.type === 'turn_context') {
      flush();
      setCwd(payload.cwd);
      model = typeof payload.model === 'string' && payload.model ? payload.model : 'unknown';
      return;
    }
    if (entry.type === 'response_item') {
      if (payload.type === 'message' || payload.type === 'agent_message') {
        if (payload.role === 'assistant' || payload.type === 'agent_message') begin(timestamp);
        return;
      }
      if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call' && payload.type !== 'local_shell_call') return;
      const callId = typeof payload.call_id === 'string' ? payload.call_id : typeof payload.id === 'string' ? payload.id : undefined;
      if (callId && seenCalls.has(callId)) return;
      if (callId) seenCalls.add(callId);
      const name = payload.type === 'local_shell_call' ? 'local_shell' : payload.name;
      if (typeof name !== 'string' || !name || name.length > 200) return;
      const turn = begin(timestamp);
      turn.tools.push(name);
      const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
      if (mcp) session.mcpServersUsed.add(mcp[1]);
      // Custom/freeform inputs may be entire patches or code. Never retain them.
      const args = payload.type === 'local_shell_call' ? record(payload.action)
        : payload.type === 'function_call' && typeof payload.arguments === 'string' ? decode(payload.arguments) : undefined;
      const shell = name.replace(/^functions\./, '');
      if (args && ['exec_command', 'shell_command', 'shell', 'local_shell'].includes(shell)) {
        const command = args.cmd ?? args.command;
        if (typeof command === 'string') turn.commands.push(command.slice(0, 400));
        else if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
          turn.commands.push(command.map((part) => part.slice(0, 400)).join(' ').slice(0, 400));
        }
      }
      if (args && ['spawn_agent', 'functions.spawn_agent'].includes(name) && typeof args.agent_type === 'string') {
        session.subagentsUsed.add(args.agent_type.slice(0, 200));
      }
      return;
    }
    if (entry.type !== 'event_msg' || payload.type !== 'token_count') return;
    // A null info is a rate-limit update, not a zero-token model response.
    if (payload.info === null) return;
    const info = record(payload.info);
    const total = counters(info?.total_token_usage);
    if (!total) { begin(timestamp); flush(); return; }
    if (sawTotal && equal(total, previous)) return;
    const increment = delta(total, previous);
    previous = total;
    sawTotal = true;
    // A rewind has no epoch/response ID proving whether subsequent increments are new
    // work or replayed history. Once continuity is lost, never bill that tail twice.
    if (!increment || !continuousCounters) {
      continuousCounters = false;
      begin(timestamp);
      flush();
      return;
    }
    const turn = begin(timestamp);
    turn.usage = usageFor(increment);
    turn.usageKnown = true;
    // A cumulative jump may cover multiple missing responses/models. Preserve its token
    // reading, but do not pretend it measures a single first-turn prompt or model.
    const last = counters(info?.last_token_usage);
    if (last && !equal(last, increment)) turn.model = 'unknown';
    if (session.turns.length === 0 && (!last || equal(last, increment))) {
      session.firstTurnPromptTokens = increment.input;
    }
    if (timestamp) turn.timestamp = timestamp;
    flush();
  });
  flush();
  return success && !ambiguous && session.project && session.turns.length ? session : undefined;
}

export type CodexScanOptions = {
  /** Exact working directory, canonicalized; defaults to process.cwd(). */
  cwd?: string;
  /** Include other projects. Claims remain scoped separately by the evidence engine. */
  all?: boolean;
  /** Maximum matching sessions, newest file modification time first. */
  limit?: number;
};

export async function scanCodexSessions(opts: CodexScanOptions = {}): Promise<Session[]> {
  if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 0)) {
    throw new RangeError('Codex session limit must be a non-negative integer');
  }
  if (opts.limit === 0) return [];
  const files: { file: string; mtime: number }[] = [];
  const walk = (directory: string, depth = 0) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try { files.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch { /* moved while scanning */ }
      }
    }
  };
  walk(path.join(codexHome(), 'sessions'));
  walk(path.join(codexHome(), 'archived_sessions'));
  files.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
  const currentProject = codexProjectId(opts.cwd ?? process.cwd());
  const sessions: Session[] = [];
  const seen = new Set<string>();
  for (const { file } of files) {
    const session = await readCodexSession(file);
    if (!session || (!opts.all && session.project !== currentProject) || seen.has(session.id)) continue;
    seen.add(session.id);
    sessions.push(session);
    if (opts.limit !== undefined && sessions.length >= opts.limit) break;
  }
  return sessions;
}
