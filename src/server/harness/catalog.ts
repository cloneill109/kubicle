import { existsSync } from 'node:fs';
import { stringify } from 'yaml';
import { writeAtomic } from '../fsutil.ts';
import { ID_RE } from '../../shared/building.ts';
import { LIST_MAX } from '../../shared/harness.ts';
import type { McpCatalog, McpServerDef } from '../../shared/catalog.ts';
import { BuildingFileError, DIR_MODE, FILE_MODE, checkBase, isMap, parseFile, validRev } from '../building/files.ts';

export type { McpServerDef, McpCatalog } from '../../shared/catalog.ts';

const KEYS = ['type', 'command', 'args', 'env', 'url', 'headers'];
const TOKEN_RE = /^(sk-|ghp_|xox[bp]-|glpat-)/;
const TOKEN_ANY_RE = /\b(sk-|ghp_|xox[bp]-|glpat-)/;
const SECRET_RE = /secret:([a-z0-9][a-z0-9-]{0,31})/g;

const isStrMap = (v: unknown): v is Record<string, string> => isMap(v) && Object.values(v).every((x) => typeof x === 'string');

export function mcpProblems(name: string, s: unknown): string[] {
  const out: string[] = [];
  if (!ID_RE.test(name)) out.push(`server name "${name}" is invalid`);
  if (!isMap(s)) return [...out, `${name}: server must be a mapping`];
  for (const k of Object.keys(s)) if (!KEYS.includes(k)) out.push(`${name}: unknown key "${k}"`);
  const type = s.type === undefined ? 'stdio' : s.type;
  if (type !== 'stdio' && type !== 'http' && type !== 'sse') { out.push(`${name}: type must be stdio, http or sse`); return out; }
  if (type === 'stdio') {
    if (typeof s.command !== 'string' || s.command.trim() === '') out.push(`${name}: a stdio server needs a command`);
  } else if (typeof s.url !== 'string' || s.url === '') out.push(`${name}: an ${type} server needs a url`);
  else {
    let u: URL | null = null;
    try { u = new URL(s.url); } catch { /* reported below */ }
    const local = u && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    if (!u || (u.protocol !== 'https:' && !local)) out.push(`${name}: url must be https (or http://localhost)`);
  }
  if (typeof s.url === 'string') {
    if (TOKEN_ANY_RE.test(s.url)) out.push(`put tokens in a secret, not in mcp.yaml (url)`);
    if (s.url.includes('secret:')) out.push('secret: references only work in env and headers (url)');
  }
  if (s.args !== undefined && !(Array.isArray(s.args) && s.args.every((a) => typeof a === 'string'))) out.push(`${name}: args must be a list of strings`);
  else if (Array.isArray(s.args)) {
    if (s.args.length > LIST_MAX) out.push(`${name}: args must have at most ${LIST_MAX} entries`);
    if (s.args.some((x) => TOKEN_ANY_RE.test(x as string))) out.push('put tokens in a secret, not in mcp.yaml (args)');
    if (s.args.some((x) => (x as string).includes('secret:'))) out.push('secret: references only work in env and headers (args)');
  }
  for (const field of ['env', 'headers'] as const) {
    const m = s[field];
    if (m === undefined) continue;
    if (!isStrMap(m)) { out.push(`${name}: ${field} must be a mapping of strings`); continue; }
    for (const [k, v] of Object.entries(m)) {
      if (TOKEN_RE.test(v.replace(/^Bearer\s+/i, '')) || TOKEN_ANY_RE.test(v)) out.push(`put tokens in a secret, not in mcp.yaml (${field}.${k})`);
    }
  }
  return out;
}

/** Names referenced as secret:<name> in env and header values, in first-seen order. */
export function secretRefs(s: McpServerDef): string[] {
  const seen = new Set<string>();
  for (const m of [s.env, s.headers]) {
    for (const v of Object.values(m ?? {})) for (const x of v.matchAll(SECRET_RE)) seen.add(x[1]!);
  }
  return [...seen];
}

const envName = (n: string): string => `KUBICLE_SECRET_${n.toUpperCase().replace(/-/g, '_')}`;
const subst = (m: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.replace(SECRET_RE, (_a, n: string) => '${' + envName(n) + '}')]));

/** The server as Claude's --mcp-config wants it; secret:x becomes ${KUBICLE_SECRET_X}. */
export function toClaudeMcp(s: McpServerDef): Record<string, unknown> {
  const o: Record<string, unknown> = { ...s };
  if (s.env) o.env = subst(s.env);
  if (s.headers) o.headers = subst(s.headers);
  return o;
}

function problems(c: { revision: unknown; servers: unknown }): string[] {
  const errs: string[] = [];
  if (!validRev(c.revision)) errs.push('revision must be an integer >= 1');
  if (!isMap(c.servers)) { errs.push('servers must be a mapping'); return errs; }
  const entries = Object.entries(c.servers);
  if (entries.length > LIST_MAX) errs.push(`servers must have at most ${LIST_MAX} entries`);
  for (const [n, s] of entries) errs.push(...mcpProblems(n, s));
  return errs;
}

/** A missing file is an empty catalog at revision 0. A bad file throws BuildingFileError. */
export function readCatalog(file: string): McpCatalog {
  if (!existsSync(file)) return { revision: 0, servers: {} };
  const data = parseFile(file);
  const servers = data.servers === undefined || data.servers === null ? {} : data.servers;
  const errs = problems({ revision: data.revision, servers });
  for (const k of Object.keys(data)) if (k !== 'revision' && k !== 'servers') errs.push(`unknown key "${k}"`);
  if (errs.length > 0) throw new BuildingFileError(file, errs.join('; '));
  return { revision: data.revision as number, servers: servers as Record<string, McpServerDef> };
}

/** Sets (or, with null, removes) one server and bumps the revision. Returns what was stored. */
export function writeServer(file: string, name: string, server: McpServerDef | null, baseRevision: number): McpCatalog {
  checkBase(file, baseRevision);
  const servers = { ...readCatalog(file).servers };
  if (server === null) delete servers[name]; else servers[name] = server;
  const stored: McpCatalog = { revision: baseRevision + 1, servers };
  const errs = problems(stored);
  if (errs.length > 0) throw new BuildingFileError(file, errs.join('; '));
  writeAtomic(file, stringify(stored), FILE_MODE, DIR_MODE);
  return stored;
}
