import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORT_THEME } from '../src/report-theme.ts';
import { alwaysOnCost } from '../src/pricing.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = REPORT_THEME.dark;
const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const sans = 'system-ui, -apple-system, Segoe UI, sans-serif';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const text = (x: number, y: number, value: string, size = 20, color: string = t.fg, font = sans) =>
  '<text x="' + x + '" y="' + y + '" fill="' + color + '" font-family="' + font + '" font-size="' + size + '">' + esc(value) + '</text>';
const rect = (x: number, y: number, w: number, h: number, color: string = t.panel, r = 8) =>
  '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + r + '" fill="' + color + '"/>';
const rule = (x: number, y: number, w: number) => rect(x, y, w, 1, t.line, 0);
const brand = (x: number, y: number, size = 36) => text(x, y, 'harnessmeter', size, t.amber, mono);
const svg = (w: number, h: number, title: string, body: string) =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img" aria-labelledby="title desc">\n<title id="title">' + esc(title) + '</title>\n<desc id="desc">Generated from shared report colors. Illustrative product artwork, not a measurement.</desc>\n' + rect(0, 0, w, h, t.bg, 12) + body + '\n</svg>\n';

const banner = svg(1200, 360, 'harnessmeter: review the context your agents carry',
  brand(56, 78, 38) +
  text(56, 137, 'Review the context your agents carry.', 34) +
  text(56, 178, 'Local inventory. Conservative evidence. Changes you can review.', 22, t.mut) +
  rule(56, 213, 1088) +
  text(56, 254, 'Inventory', 23, t.blue) + text(56, 286, 'Estimated resident footprint', 18, t.mut) +
  text(438, 254, 'Evidence', 23, t.amber) + text(438, 286, 'Observed usage and its limits', 18, t.mut) +
  text(822, 254, 'Review', 23, t.green) + text(822, 286, 'Baselines and proposals', 18, t.mut) +
  text(56, 332, 'T0/T1 run offline. Optional T2 uses your agent provider.', 16, t.mut));

const social = svg(1280, 640, 'harnessmeter: review before you remove',
  rect(0, 0, 1280, 5, t.amber, 0) + brand(72, 112, 46) +
  text(72, 218, 'Know what is in context.', 49) +
  text(72, 281, 'Review before you remove.', 49) +
  text(72, 342, 'Footprint estimates, session evidence and reviewable changes.', 25, t.mut) +
  rule(72, 393, 1136) +
  text(72, 443, 'Inventory', 25, t.blue) + text(456, 443, 'Evidence', 25, t.amber) + text(840, 443, 'Review', 25, t.green) +
  text(72, 521, 'Offline by default. Optional T2 uses your agent provider.', 22, t.mut) +
  text(72, 568, 'github.com/alebgl77/harnessmeter', 22, t.fg, mono) +
  text(72, 607, 'Source branch: Claude Code and Codex profiles. See release coverage in README.', 17, t.mut));

const report = svg(1100, 680, 'Illustrative static harness inventory',
  brand(44, 67, 30) + text(44, 104, 'Claude Code / Static inventory / Synthetic example', 18, t.mut) +
  rule(44, 129, 1012) +
  text(44, 190, '1,260', 42) + text(185, 190, 'estimated resident tokens', 21, t.mut) +
  text(727, 190, '3', 42) + text(775, 190, 'claims inventoried', 21, t.mut) +
  text(44, 238, 'Behavioral evidence not evaluated. No sessions were supplied.', 19, t.amber) +
  rule(44, 268, 1012) +
  text(44, 310, 'Claim / source', 18, t.mut) + text(645, 310, 'Resident estimate', 18, t.mut) + text(870, 310, 'Verdict', 18, t.mut) +
  text(44, 362, 'CLAUDE.md / Testing', 20, t.fg, mono) + text(698, 362, '840 tok', 20) + text(870, 362, 'unproven', 19, t.amber) +
  rule(44, 384, 1012) +
  text(44, 424, 'CLAUDE.md / Secret handling', 20, t.fg, mono) + text(698, 424, '300 tok', 20) + text(870, 424, 'protected', 19, t.blue) +
  rule(44, 446, 1012) +
  text(44, 486, 'skill / release-review', 20, t.fg, mono) + text(698, 486, '120 tok', 20) + text(870, 486, 'unproven', 19, t.amber) +
  rule(44, 512, 1012) +
  text(44, 557, 'API-equivalent spend: unknown. Proposal savings: unknown.', 20, t.mut) +
  text(44, 598, 'Prevention rules are protected. Nothing is applied automatically.', 19, t.green) +
  text(44, 648, 'Synthetic illustration, not a screenshot or a real measurement.', 17, t.mut));

const tokens = 1000, turns = 10, writes = 2;
const effective = alwaysOnCost(tokens, turns, '5m', writes);
const cache = svg(1100, 430, 'Illustrative cache-weighted token calculation',
  brand(44, 65, 28) + text(44, 119, 'Cache writes change the estimate.', 32) +
  text(44, 160, 'Example only: 1,000 prefix tokens, 10 turns, two 5-minute cache writes.', 20, t.mut) +
  text(44, 220, 'Tokens × turns', 20, t.mut) + rect(300, 200, 720, 26, t.blue) + text(940, 252, '10,000', 20) +
  text(44, 302, 'Cache-weighted', 20, t.mut) + rect(300, 282, 720 * effective / (tokens * turns), 26, t.amber) + text(568, 303, effective.toLocaleString('en-US') + ' effective input tokens', 20) +
  text(44, 365, '1,000 × (2 × 1.25 + 8 × 0.1) = ' + effective.toLocaleString('en-US'), 20, t.fg, mono) +
  text(44, 407, 'Not a saving guarantee or a subscription bill. Results depend on observed writes and TTL.', 17, t.mut));

const outputs = { 'banner.svg': banner, 'social-preview.svg': social, 'report.svg': report, 'cache-math.svg': cache };
const check = process.argv.includes('--check');
for (const [name, content] of Object.entries(outputs)) {
  const target = path.join(root, 'assets', name);
  if (check) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
      console.error(name + ' is stale: run npm run assets');
      process.exitCode = 1;
    }
  } else fs.writeFileSync(target, content);
}
