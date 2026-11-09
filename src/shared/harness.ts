// Shared harness model: validation, merge and effective view. Browser-safe (no Node imports).
import { ID_RE } from './building.ts';

/** Claude Code permission modes a room (or the global default) may use. The bypass modes are never allowed. */
export const PERMISSION_MODES = ['auto', 'acceptEdits', 'manual', 'plan'] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
const REFUSED_MODES = ['bypassPermissions', 'dontAsk'];

/** null when `v` is an allowed mode; else the problem, naming `key`. */
export function permissionModeProblem(key: string, v: unknown): string | null {
  if (typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v)) return null;
  if (typeof v === 'string' && REFUSED_MODES.includes(v)) return `${key} "${v}" is not allowed: it would skip your approvals`;
  return `${key} must be auto, acceptEdits, manual or plan`;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface Harness {
  inherit?: boolean; model?: string; prompt?: string; prompt_mode?: 'append' | 'replace'; permission_mode?: PermissionMode;
  tools?: string[]; allow?: string[]; ask?: string[]; deny?: string[];
  mcp?: string[]; skills?: string[]; optional?: string[];
}

export interface Effective {
  inherit: boolean; model?: string; prompt?: string; promptMode: 'append' | 'replace'; permissionMode?: PermissionMode;
  tools?: string[]; allow: string[]; ask: string[]; deny: string[];
  mcp: string[]; skills: string[]; optional: Set<string>;
}

export const HARNESS_KEYS: readonly string[] = [
  'inherit', 'model', 'prompt', 'prompt_mode', 'permission_mode', 'tools', 'allow', 'ask', 'deny', 'mcp', 'skills', 'optional',
];

export const PROMPT_MAX = 20000;
export const LIST_MAX = 50;

const RULE_LISTS = ['tools', 'allow', 'ask', 'deny'] as const;
const NAME_LISTS = ['mcp', 'skills', 'optional'] as const;

/** Where a harness lives: only a room override may remove an inherited tool (`-Name`). */
export type HarnessLevel = 'division' | 'room';

export function harnessProblems(h: unknown, level: HarnessLevel = 'division'): string[] {
  if (h === null || typeof h !== 'object' || Array.isArray(h)) return ['harness must be a mapping'];
  const o = h as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(o)) if (!HARNESS_KEYS.includes(k)) out.push(`harness has unknown key "${k}"`);
  if ('inherit' in o && typeof o.inherit !== 'boolean') out.push('inherit must be true or false');
  if ('model' in o) {
    if (typeof o.model !== 'string') out.push('model must be text');
    else if (!MODEL_RE.test(o.model)) out.push(`model "${o.model}" is not a model name`);
  }
  if ('prompt' in o) {
    if (typeof o.prompt !== 'string') out.push('prompt must be text');
    else if (o.prompt.length > PROMPT_MAX) out.push(`prompt must be at most ${PROMPT_MAX} characters`);
    else if (o.prompt.includes('\0')) out.push('prompt must not contain NUL characters');
  }
  if ('prompt_mode' in o && o.prompt_mode !== 'append' && o.prompt_mode !== 'replace') out.push('prompt_mode must be append or replace');
  if ('permission_mode' in o) { const p = permissionModeProblem('permission_mode', o.permission_mode); if (p) out.push(p); }
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
    else if (key === 'tools') {
      for (const x of v as string[]) {
        const removal = x.startsWith('-');
        if (!TOOL_RE.test(removal ? x.slice(1) : x)) out.push(`tool name "${x}" is invalid`);
        else if (removal && level !== 'room') out.push(`tools entry "${x}" only works in a room override`);
      }
    }
    else if (v.some((x) => (x as string).trimStart().startsWith('-'))) out.push("a room can't remove an inherited rule; add a deny or ask rule instead");
    else if (v.some((x) => (x as string).includes('\0'))) out.push(`${key} entries must not contain NUL characters`);
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

/** `-Name` removes from the division's list. With no list there is nothing to remove from, and that must never read as "no tools" (resolve refuses it). */
function mergeTools(base: string[] | undefined, over: string[] | undefined): string[] | undefined {
  if (base) return mergeNames(base, over);
  if (!over) return undefined;
  const add = over.filter((t) => !t.startsWith('-'));
  return over.length > 0 && add.length === 0 ? undefined : uniq(add);
}

export function mergeHarness(base: Harness, over: Harness): Harness {
  const out: Harness = {};
  const inherit = over.inherit ?? base.inherit;
  if (inherit !== undefined) out.inherit = inherit;
  const model = over.model ?? base.model;
  if (model !== undefined) out.model = model;
  const pm = over.permission_mode ?? base.permission_mode;
  if (pm !== undefined) out.permission_mode = pm;
  const mode = over.prompt_mode ?? base.prompt_mode;
  if (mode !== undefined) out.prompt_mode = mode;
  let prompt: string | undefined;
  if (over.prompt_mode === 'replace' && over.prompt !== undefined) prompt = over.prompt;
  else if (base.prompt !== undefined && over.prompt !== undefined) prompt = `${base.prompt}\n\n${over.prompt}`;
  else prompt = over.prompt ?? base.prompt;
  if (prompt !== undefined) out.prompt = prompt;
  const tools = mergeTools(base.tools, over.tools);
  if (tools) out.tools = tools;
  for (const k of ['allow', 'ask', 'deny', 'optional'] as const) {
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
  if (h.permission_mode !== undefined) e.permissionMode = h.permission_mode;
  if (h.prompt !== undefined) e.prompt = h.prompt;
  if (h.tools !== undefined) e.tools = uniq(h.tools);
  return e;
}
