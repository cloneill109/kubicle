// ~/.kubicle/bubbles.yaml: optional. Invalid or wrongly typed content falls back to defaults plus a warning
// (shown as a building-style banner). Pure function: no watching; the caller decides when to reload.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export interface BubblesConfig {
  /** Boot default only; the live on/off toggle is stored in Policy. */
  enabled: boolean;
  models: { fast: string; strong: string };
  dailyCallCap: number;
  protectedBranches: string[];
  strictScripts: boolean;
}

const KNOWN = new Set(['enabled', 'models', 'daily_call_cap', 'protected_branches', 'strict_scripts']);
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._\/+@-]*$/;

/** A git-safe branch name: ASCII word characters and `._/+@-`, no leading `-`, no `..`, no trailing `.` / `/`, no `.lock`. */
export function isGitSafeBranch(x: unknown): x is string {
  return typeof x === 'string' && BRANCH.test(x) && !x.includes('..') && !/[.\/]$/.test(x) && !x.endsWith('.lock');
}

export function defaultBubblesConfig(): BubblesConfig {
  return { enabled: true, models: { fast: 'haiku', strong: 'sonnet' }, dailyCallCap: 300, protectedBranches: [], strictScripts: false };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function loadBubblesConfig(home: string): { config: BubblesConfig; warning: string | null } {
  const file = join(home, 'bubbles.yaml');
  const config = defaultBubblesConfig();
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config, warning: null };
    return { config, warning: `${file}: cannot read (${(err as Error).message}); using defaults` };
  }
  let doc: unknown;
  try { doc = parse(text); } catch (err) {
    return { config, warning: `${file}: invalid YAML (${(err as Error).message.split('\n')[0]}); using defaults` };
  }
  if (doc === null || doc === undefined) return { config, warning: null };
  if (!isObj(doc)) return { config, warning: `${file}: expected a mapping at the top level; using defaults` };

  const problems: string[] = [];
  const bad = (key: string, want: string) => problems.push(`${key} must be ${want}`);
  if ('enabled' in doc) typeof doc.enabled === 'boolean' ? (config.enabled = doc.enabled) : bad('enabled', 'true or false');
  if ('strict_scripts' in doc) typeof doc.strict_scripts === 'boolean' ? (config.strictScripts = doc.strict_scripts) : bad('strict_scripts', 'true or false');
  if ('daily_call_cap' in doc) {
    const n = doc.daily_call_cap;
    typeof n === 'number' && Number.isInteger(n) && n >= 0 ? (config.dailyCallCap = n) : bad('daily_call_cap', 'a non-negative integer');
  }
  if ('models' in doc) {
    const m = doc.models;
    if (!isObj(m)) bad('models', 'a mapping with fast and strong');
    else {
      for (const k of ['fast', 'strong'] as const) {
        if (!(k in m)) continue;
        typeof m[k] === 'string' && (m[k] as string).trim() ? (config.models[k] = m[k] as string) : bad(`models.${k}`, 'a model alias string');
      }
      for (const k of Object.keys(m)) if (k !== 'fast' && k !== 'strong') problems.push(`unknown key models.${k} ignored`);
    }
  }
  if ('protected_branches' in doc) {
    const b = doc.protected_branches;
    if (!Array.isArray(b) || !b.every(isGitSafeBranch)) {
      bad('protected_branches', 'an array of git-safe branch names (no spaces, "..", or leading "-")');
    } else config.protectedBranches = [...b] as string[];
  }
  for (const k of Object.keys(doc)) if (!KNOWN.has(k)) problems.push(`unknown key ${k} ignored`);
  return { config, warning: problems.length ? `${file}: ${problems.join('; ')}` : null };
}
