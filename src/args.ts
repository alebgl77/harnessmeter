import type { Provider } from './types.ts';

export type Args = {
  all: boolean; limit: number; json: boolean; html: boolean; out?: string;
  patch: boolean; t2: boolean; t2Model?: string; yes: boolean; help: boolean;
  version: boolean; provider: Provider; static: boolean; projectOnly: boolean;
  baseline?: string; saveBaseline?: string; maxTokens?: number; maxGrowth?: number;
};

/** Parse before reading transcripts or writing anything. Typos must fail closed in CI. */
export function parseArgs(argv: string[]): Args {
  const args: Args = {
    all: false, limit: 400, json: false, html: true, patch: false, t2: false,
    yes: false, help: false, version: false, provider: 'claude', static: false, projectOnly: false,
  };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] === '-h' ? '--help' : argv[i] === '-y' ? '--yes' : argv[i];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith('--') || next.trim() !== next) throw new Error(`${flag} requires a value`);
      return next;
    };
    const numeric = (integer: boolean, minimum: number) => {
      const raw = value();
      const n = Number(raw);
      if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw) || !Number.isFinite(n) || n < minimum ||
          (integer && (!Number.isSafeInteger(n) || raw.includes('.')))) {
        throw new Error(`${flag} requires ${integer ? 'a safe integer' : 'a finite number'} >= ${minimum}`);
      }
      return n;
    };
    switch (flag) {
      case '--all': args.all = true; break;
      case '--json': args.json = true; break;
      case '--no-html': args.html = false; break;
      case '--patch': args.patch = true; break;
      case '--t2': args.t2 = true; break;
      case '--yes': args.yes = true; break;
      case '--help': args.help = true; break;
      case '--version': args.version = true; break;
      case '--static': args.static = true; break;
      case '--project-only': args.projectOnly = true; break;
      case '--limit': args.limit = numeric(true, 1); break;
      case '--max-tokens': args.maxTokens = numeric(true, 0); break;
      case '--max-growth': args.maxGrowth = numeric(false, 0); break;
      case '--out': args.out = value(); break;
      case '--baseline': args.baseline = value(); break;
      case '--save-baseline': args.saveBaseline = value(); break;
      case '--provider': {
        const provider = value();
        if (provider !== 'claude' && provider !== 'codex') throw new Error('--provider must be claude or codex');
        args.provider = provider;
        break;
      }
      case '--t2-model': {
        const model = value();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(model)) throw new Error('--t2-model is not a valid model id');
        args.t2Model = model;
        break;
      }
      default: throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (args.static && (args.t2 || args.patch)) throw new Error('--static cannot be combined with --t2 or --patch');
  if (args.provider === 'codex' && (args.t2 || args.patch)) throw new Error('--t2 and --patch are not supported for --provider codex');
  if (args.maxGrowth !== undefined && !args.baseline) throw new Error('--max-growth requires --baseline');
  if (args.t2Model && !args.t2) throw new Error('--t2-model requires --t2');
  return args;
}
