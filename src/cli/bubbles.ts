import { basename } from 'node:path';
import type { LogEntry } from '../server/bubbles/log.ts';
import type { BubblesState } from '../shared/protocol.ts';
import { CliError, UsageError, expectPositionals, parseArgs } from './args.ts';
import { projectOf } from './floor.ts';
import { socketJson } from './socket.ts';

type Cfg = { home: string; hookSocket: string };

const MIN = 60_000;
const UNIT: Record<string, number> = { m: MIN, h: 60 * MIN, d: 24 * 60 * MIN };
const MAX_FOR_MS = 7 * UNIT.d!;
const PENDING = 'Pending: confirm in the office (Lobby → Bubbles). Request %ID% expires in 15 min.';

/** `30m`, `2h`, `1d` → milliseconds. */
function duration(v: string, flag: string): number {
  const m = /^(\d{1,6})([mhd])$/.exec(v);
  const n = m ? Number(m[1]) * UNIT[m[2]!]! : 0;
  if (!m || n <= 0) throw new UsageError(`${flag} must look like 30m, 2h or 1d`);
  return n;
}

/** A duration back from now, or an ISO date; epoch ms. */
function sinceMs(v: string, now: number): number {
  if (/^\d+[mhd]$/.test(v)) return now - duration(v, '--since');
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) { const t = Date.parse(v); if (Number.isFinite(t)) return t; }
  throw new UsageError('--since must be an ISO date or a duration like 30m, 2h, 1d');
}

/** Agent-provided text must never reach the terminal as escape sequences: drop C0/C1 controls (whitespace ones become a space). */
export function clean(s: unknown): string {
  return String(s ?? '').replace(/[\t\n\r]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

async function propose(cfg: Cfg, change: unknown): Promise<number> {
  const { json } = await socketJson(cfg, 'POST', '/cli/propose', { change });
  const id = (json as { id?: string } | null)?.id ?? '?';
  console.log(PENDING.replace('%ID%', clean(id)));
  return 0;
}

function grant(rest: string[], cfg: Cfg): Promise<number> {
  const p = parseArgs(rest.filter((a) => a !== '--unlimited'), ['branch', 'uses', 'for', 'project']);
  const unlimited = rest.includes('--unlimited');
  expectPositionals(p, 1, 'grant push|merge');
  const action = p.positionals[0];
  if (action !== 'push' && action !== 'merge') throw new UsageError('grant needs push or merge');
  const usesFlag = p.flags.get('uses');
  if (unlimited && usesFlag !== undefined) throw new UsageError('--uses and --unlimited cannot be combined');
  let uses: number | null = 1;
  if (unlimited) uses = null;
  else if (usesFlag !== undefined) {
    if (!/^\d+$/.test(usesFlag) || Number(usesFlag) < 1) throw new UsageError('--uses must be a positive integer');
    uses = Number(usesFlag);
  }
  const forFlag = p.flags.get('for');
  const ttlMs = forFlag === undefined ? 60 * MIN : duration(forFlag, '--for');
  if (ttlMs > MAX_FOR_MS) throw new UsageError('--for may not exceed 7d');
  const projectId = projectOf(p.flags, cfg.home, false);
  return propose(cfg, { type: 'grant', projectId, action, branch: p.flags.get('branch') ?? null, uses, ttlMs });
}

function instruct(rest: string[], cfg: Cfg): Promise<number> {
  const p = parseArgs(rest, ['project']);
  expectPositionals(p, 1, 'instruct "<text>"');
  const text = p.positionals[0]!;
  // No --project: the instruction applies to every project.
  const projectId = p.flags.has('project') ? projectOf(p.flags, cfg.home, false) : null;
  return propose(cfg, { type: 'instruction', projectId, text });
}

function revoke(rest: string[], cfg: Cfg): Promise<number> {
  const p = parseArgs(rest, []);
  expectPositionals(p, 2, 'revoke grant|instruction <id>');
  const [target, id] = p.positionals as [string, string];
  if (target !== 'grant' && target !== 'instruction') throw new UsageError('revoke needs grant or instruction');
  return propose(cfg, { type: 'revoke', target, id });
}

async function bubbles(rest: string[], cfg: Cfg): Promise<number> {
  const p = parseArgs(rest.filter((a) => a !== '--json'), []);
  const json = rest.includes('--json');
  expectPositionals(p, 1, 'bubbles status|on|off');
  const sub = p.positionals[0];
  if (sub === 'on' || sub === 'off') {
    if (json) throw new UsageError('--json only applies to status');
    return propose(cfg, { type: 'toggle', enabled: sub === 'on' });
  }
  if (sub !== 'status') throw new UsageError('bubbles needs status, on or off');
  const st = (await socketJson(cfg, 'GET', '/cli/bubbles')).json as BubblesState;
  if (json) { console.log(JSON.stringify(st)); return 0; }
  const now = Date.now();
  const out = [`${clean(st.status.state)}${st.status.detail ? ` — ${clean(st.status.detail)}` : ''}`, `calls today ${st.status.callsToday} / ${st.status.cap}`];
  const grants = st.grants.filter((g) => g.revokedAt === null && g.expiresAt > now);
  const instr = st.instructions.filter((i) => i.revokedAt === null);
  out.push('', `Active grants (${grants.length})`);
  for (const g of grants) {
    out.push(`  ${g.id.slice(0, 8)}  ${g.action}  ${clean(basename(g.projectId))}  ${clean(g.branch ?? 'any branch')}  ${g.usesLeft === null ? 'unlimited' : `${g.usesLeft} use(s)`}  until ${new Date(g.expiresAt).toISOString()}`);
  }
  out.push('', `Instructions (${instr.length})`);
  for (const i of instr) out.push(`  ${i.id.slice(0, 8)}  ${i.projectId === null ? 'all projects' : clean(basename(i.projectId))}  ${clean(i.text)}`);
  console.log(out.join('\n'));
  return 0;
}

const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 19).replace('T', ' ');

function line(e: LogEntry): string {
  const agent = e.agentType || e.agentId || '-';
  const verdict = [e.decision ?? e.outcome, e.reason ? `— ${clean(e.reason).slice(0, 100)}` : ''].filter(Boolean).map((x, i) => (i === 0 ? clean(x) : x)).join(' ');
  return [e.seq, stamp(e.ts), clean(e.kind), e.projectId ? clean(basename(e.projectId)) : '-', clean(agent), verdict].join('  ').trimEnd();
}

async function log(rest: string[], cfg: Cfg): Promise<number> {
  const p = parseArgs(rest.filter((a) => a !== '--json'), ['project', 'session', 'kind', 'since', 'grep', 'limit']);
  const json = rest.includes('--json');
  if (p.positionals[0] === 'verify') {
    expectPositionals(p, 1, 'log verify');
    const r = (await socketJson(cfg, 'GET', '/cli/log/verify')).json as { ok: true; count: number } | { ok: false; badSeq: number; why: string };
    if (r.ok) { console.log(`ok: ${r.count} entries`); return 0; }
    console.error(`chain broken at seq ${r.badSeq}: ${clean(r.why)}`);
    return 1;
  }
  expectPositionals(p, 0, 'no positional arguments');
  const q = new URLSearchParams();
  const since = p.flags.get('since');
  if (since !== undefined) q.set('since', String(sinceMs(since, Date.now())));
  const limit = p.flags.get('limit');
  if (limit !== undefined) {
    if (!/^\d+$/.test(limit) || Number(limit) < 1) throw new UsageError('--limit must be a positive integer');
    q.set('limit', limit);
  }
  if (p.flags.has('project')) q.set('project', projectOf(p.flags, cfg.home, false));
  for (const k of ['session', 'kind', 'grep']) { const v = p.flags.get(k); if (v !== undefined) q.set(k, v); }
  const qs = q.toString();
  const entries = (await socketJson(cfg, 'GET', `/cli/log${qs ? `?${qs}` : ''}`)).json;
  if (!Array.isArray(entries)) throw new CliError('unexpected reply from the office');
  for (const e of entries as LogEntry[]) console.log(json ? JSON.stringify(e) : line(e));
  return 0;
}

export function bubblesCommand(cmd: string, rest: string[], cfg: Cfg): Promise<number> {
  switch (cmd) {
    case 'grant': return grant(rest, cfg);
    case 'instruct': return instruct(rest, cfg);
    case 'revoke': return revoke(rest, cfg);
    case 'bubbles': return bubbles(rest, cfg);
    default: return log(rest, cfg);
  }
}
