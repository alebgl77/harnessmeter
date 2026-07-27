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

function run(bin: string, args: string[], stdin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`agent timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) reject(new Error(err.trim() || `agent exited ${code}`));
      else resolve(out);
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

export type AskOptions = { model?: string; timeoutMs?: number };

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
      const u = j.usage ?? {};
      const created = u.cache_creation ?? {};
      return {
        text: String(j.result ?? j.text ?? j.content ?? ''),
        costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined,
        usage: {
          inputTokens: u.input_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens:
            (created.ephemeral_5m_input_tokens ?? 0) + (created.ephemeral_1h_input_tokens ?? 0) ||
            (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
        },
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
