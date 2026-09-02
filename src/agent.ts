/**
 * Local agent bridge.
 *
 * harnessmeter never holds an API key. When a tier needs judgement, it shells out to the
 * agent CLI already installed on this machine and consumes the quota the user is already
 * paying for. That is also why the tool is stack-agnostic: Claude Code, Codex and anything
 * else with a headless mode are the same code path.
 *
 * Every call pays the full always-on prefix — measured at ~$0.11 for a four-token reply on
 * a loaded setup — so callers must batch. One call judging twelve claims, never twelve calls.
 */

import { spawn } from 'node:child_process';

export type AgentKind = 'claude' | 'codex' | 'none';

export type AgentResult = {
  text: string;
  /** Exact, when the CLI reports it. */
  costUsd?: number;
  usage?: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
  };
};

export type AgentInfo = { kind: AgentKind; bin: string };

async function which(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(process.platform === 'win32' ? 'where' : 'which', [bin], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  });
}

export async function detectAgent(): Promise<AgentInfo> {
  if (await which('claude')) return { kind: 'claude', bin: 'claude' };
  if (await which('codex')) return { kind: 'codex', bin: 'codex' };
  return { kind: 'none', bin: '' };
}

/**
 * Windows needs a shell to resolve a bare command to its `.cmd` shim — but only for a bare
 * command. Running an explicit path through a shell breaks the moment that path contains a
 * space (`C:\Program Files\...` becomes two words), and it widens the injection surface for
 * nothing. So the shell is used exactly where it is required and nowhere else.
 */
function needsShell(bin: string): boolean {
  if (process.platform !== 'win32') return false;
  return !/[\\/]/.test(bin);
}

function run(bin: string, args: string[], stdin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell(bin),
    });
    let out = '';
    let err = '';

    // A spawn can fail, time out and close, in any order. Whichever outcome lands first is
    // the one the caller gets; the rest are the same event told twice.
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill();
      done(() => reject(new Error(`agent timed out after ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => done(() => reject(e)));
    child.on('close', (code) => {
      done(() => {
        if (code !== 0) reject(new Error(err.trim() || `agent exited ${code}`));
        else resolve(out);
      });
    });

    // When the binary does not exist the child is already gone by the time we write, and
    // the broken pipe surfaces on stdin rather than on the child. Unhandled, that EPIPE
    // escapes this promise and takes the process down instead of rejecting — which is the
    // opposite of what a missing agent should do. The child's own error and close events
    // carry the real outcome, so the write failure has nothing to add.
    child.stdin.on('error', () => {
      /* reported by 'error' or 'close' */
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

export type AskOptions = { model?: string; timeoutMs?: number };

function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? v as Record<string, unknown>
    : undefined;
}

function metric(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Claude's JSON envelope is not a measurement merely because an `usage` object exists.
 * Input and output are the two required counters; optional cache fields are accepted only
 * when every field that is present is itself a finite non-negative number.
 */
function claudeUsage(v: unknown): AgentResult['usage'] {
  const usage = record(v);
  if (!usage) return undefined;
  const inputTokens = metric(usage.input_tokens);
  const outputTokens = metric(usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;

  const optional = (owner: Record<string, unknown>, key: string): number | undefined =>
    key in owner ? metric(owner[key]) : 0;
  const cacheReadTokens = optional(usage, 'cache_read_input_tokens');
  const aggregateWrite = optional(usage, 'cache_creation_input_tokens');
  if (cacheReadTokens === undefined || aggregateWrite === undefined) return undefined;

  let cacheWriteTokens = aggregateWrite;
  if ('cache_creation' in usage) {
    const created = record(usage.cache_creation);
    if (!created) return undefined;
    const fiveMinute = optional(created, 'ephemeral_5m_input_tokens');
    const oneHour = optional(created, 'ephemeral_1h_input_tokens');
    if (fiveMinute === undefined || oneHour === undefined) return undefined;
    if ('ephemeral_5m_input_tokens' in created || 'ephemeral_1h_input_tokens' in created) {
      cacheWriteTokens = fiveMinute + oneHour;
    }
  }

  return { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens };
}

export async function ask(
  agent: AgentInfo,
  prompt: string,
  opts: AskOptions = {},
): Promise<AgentResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;

  if (agent.kind === 'claude') {
    const args = ['-p', '--output-format', 'json'];
    if (opts.model) args.push('--model', opts.model);
    const raw = await run(agent.bin, args, prompt, timeoutMs);
    try {
      const j = JSON.parse(raw);
      const costUsd = metric(j.total_cost_usd);
      const usage = claudeUsage(j.usage);
      return {
        text: String(j.result ?? j.text ?? j.content ?? ''),
        ...(costUsd === undefined ? {} : { costUsd }),
        ...(usage === undefined ? {} : { usage }),
      };
    } catch {
      // Older CLIs may ignore --output-format; treat stdout as the answer.
      return { text: raw };
    }
  }

  if (agent.kind === 'codex') {
    const args = ['exec', '-'];
    const raw = await run(agent.bin, args, prompt, timeoutMs);
    return { text: raw };
  }

  throw new Error('no local agent CLI found (looked for `claude`, `codex`)');
}

/** Pull the first JSON object out of a model response, fenced or bare. */
export function extractJson(text: string): unknown | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}
