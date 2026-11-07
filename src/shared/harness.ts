// Shared harness model: validation, merge and effective view. Browser-safe (no Node imports).
import { ID_RE } from './building.ts';

export interface Harness {
  inherit?: boolean; model?: string; prompt?: string; prompt_mode?: 'append' | 'replace';
  tools?: string[]; allow?: string[]; ask?: string[]; deny?: string[];
  mcp?: string[]; skills?: string[]; optional?: string[];
}

export interface Effective {
  inherit: boolean; model?: string; prompt?: string; promptMode: 'append' | 'replace';
  tools?: string[]; allow: string[]; ask: string[]; deny: string[];
  mcp: string[]; skills: string[]; optional: Set<string>;
}

export const HARNESS_KEYS: readonly string[] = [
  'inherit', 'model', 'prompt', 'prompt_mode', 'tools', 'allow', 'ask', 'deny', 'mcp', 'skills', 'optional',
];

export const PROMPT_MAX = 20000;
export const LIST_MAX = 50;

const RULE_LISTS = ['tools', 'allow', 'ask', 'deny'] as const;
const NAME_LISTS = ['mcp', 'skills', 'optional'] as const;

export function harnessProblems(h: unknown): string[] {
  if (h === null || typeof h !== 'object' || Array.isArray(h)) return ['harness must be a mapping'];
  const o = h as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(o)) if (!HARNESS_KEYS.includes(k)) out.push(`harness has unknown key "${k}"`);
  if ('inherit' in o && typeof o.inherit !== 'boolean') out.push('inherit must be true or false');
  if ('model' in o && typeof o.model !== 'string') out.push('model must be text');
  if ('prompt' in o) {
    if (typeof o.prompt !== 'string') out.push('prompt must be text');
    else if (o.prompt.length > PROMPT_MAX) out.push(`prompt must be at most ${PROMPT_MAX} characters`);
  }
  if ('prompt_mode' in o && o.prompt_mode !== 'append' && o.prompt_mode !== 'replace') out.push('prompt_mode must be append or replace');
  const list = (key: string): unknown[] | null => {
    if (!(key in o)) return null;
    const v = o[key];
    if (!Array.isArray(v)) { out.push(`${key} must be a list`); return null; }
    if (v.length > LIST_MAX) { out.push(`${key} must have at most ${LIST_MAX} entries`); return null; }
    return v;
  };
  for (const key of RULE_LISTS) {
    const v = list(key);
    if (!v) continue;
    if (v.some((x) => typeof x !== 'string')) out.push(`${key} entries must be text`);
    else if (v.some((x) => (x as string).trim() === '')) out.push(`${key} entries must not be empty`);
  }
  for (const key of NAME_LISTS) {
    const v = list(key);
    if (!v) continue;
    for (const x of v) {
      const s = typeof x === 'string' ? x : String(x);
      const bare = key !== 'optional' && typeof x === 'string' && s.startsWith('-') ? s.slice(1) : s;
      if (typeof x !== 'string' || !ID_RE.test(bare)) out.push(`${key} name "${s}" is invalid`);
    }
  }
  return out;
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

/** Apply `over` after `base` in order; `-name` entries remove earlier names (and are not kept). */
function mergeNames(base: string[] | undefined, over: string[] | undefined): string[] | undefined {
  if (!base && !over) return undefined;
  const out = new Set<string>();
  for (const n of [...(base ?? []), ...(over ?? [])]) {
    if (n.startsWith('-')) out.delete(n.slice(1)); else out.add(n);
  }
  return [...out];
}

function mergeList(base: string[] | undefined, over: string[] | undefined): string[] | undefined {
  if (!base && !over) return undefined;
  return uniq([...(base ?? []), ...(over ?? [])]);
}

export function mergeHarness(base: Harness, over: Harness): Harness {
  const out: Harness = {};
  const inherit = over.inherit ?? base.inherit;
  if (inherit !== undefined) out.inherit = inherit;
  const model = over.model ?? base.model;
  if (model !== undefined) out.model = model;
  const mode = over.prompt_mode ?? base.prompt_mode;
  if (mode !== undefined) out.prompt_mode = mode;
  let prompt: string | undefined;
  if (over.prompt_mode === 'replace' && over.prompt !== undefined) prompt = over.prompt;
  else if (base.prompt !== undefined && over.prompt !== undefined) prompt = `${base.prompt}\n\n${over.prompt}`;
  else prompt = over.prompt ?? base.prompt;
  if (prompt !== undefined) out.prompt = prompt;
  for (const k of ['tools', 'allow', 'ask', 'deny', 'optional'] as const) {
    const v = mergeList(base[k], over[k]);
    if (v) out[k] = v;
  }
  for (const k of ['mcp', 'skills'] as const) {
    const v = mergeNames(base[k], over[k]);
    if (v) out[k] = v;
  }
  return out;
}

export function effective(h: Harness): Effective {
  const deny = uniq(h.deny ?? []);
  const ask = uniq(h.ask ?? []).filter((r) => !deny.includes(r));
  const allow = uniq(h.allow ?? []).filter((r) => !deny.includes(r) && !ask.includes(r));
  const e: Effective = {
    inherit: h.inherit ?? true,
    promptMode: h.prompt_mode ?? 'append',
    allow, ask, deny,
    mcp: mergeNames(undefined, h.mcp) ?? [],
    skills: mergeNames(undefined, h.skills) ?? [],
    optional: new Set(h.optional ?? []),
  };
  if (h.model !== undefined) e.model = h.model;
  if (h.prompt !== undefined) e.prompt = h.prompt;
  if (h.tools !== undefined) e.tools = uniq(h.tools);
  return e;
}
