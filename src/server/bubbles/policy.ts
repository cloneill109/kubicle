// Bubbles policy: owner grants, standing instructions, the on/off toggle, and CLI proposals that only
// take effect once the owner confirms them in the office UI.
//
// Auth: the write methods (addGrant, addInstruction, revoke, setEnabled) have no auth of their own; the
// HTTP layer gates them. `who` ends up in the log detail ("owner (office)" or "owner (confirmed CLI request <id>)").
// Log ordering: each write commits its table change FIRST, then calls log.append (which opens its own
// BEGIN IMMEDIATE and so must never run inside another transaction).
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { BubblesLog } from './log.ts';
import type { Grant } from './rules.ts';

export type { Grant };

export interface Instruction {
  id: string; projectId: string | null; text: string; version: number; createdAt: number; revokedAt: number | null;
}

export type PendingChange = {
  id: string; createdAt: number; source: 'cli';
  change:
    | { type: 'grant'; projectId: string; action: 'push' | 'merge'; branch: string | null; uses: number | null; ttlMs: number }
    | { type: 'instruction'; projectId: string | null; text: string }
    | { type: 'revoke'; target: 'grant' | 'instruction'; id: string }
    | { type: 'toggle'; enabled: boolean };
};
type Change = PendingChange['change'];

export class PolicyError extends Error {
  constructor(message: string) { super(message); this.name = 'PolicyError'; }
}

export const GRANT_DEFAULT_TTL_MS = 3_600_000;
export const GRANT_MAX_TTL_MS = 7 * 86_400_000;
export const PENDING_TTL_MS = 15 * 60_000;
export const INSTRUCTION_MAX = 1000;

export interface GrantInput { projectId: string; action: 'push' | 'merge'; branch: string | null; uses?: number | null; ttlMs?: number }
export interface InstructionInput { id?: string; projectId: string | null; text: string }

interface GrantRow {
  id: string; project_id: string; action: string; branch: string | null; uses_left: number | null;
  expires_at: number; created_at: number; confirmed_at: number; revoked_at: number | null;
}
interface InstrRow { id: string; version: number; project_id: string | null; text: string; created_at: number; revoked_at: number | null }

const toGrant = (r: GrantRow): Grant => ({
  id: r.id, projectId: r.project_id, action: r.action as 'push' | 'merge', branch: r.branch, usesLeft: r.uses_left,
  expiresAt: r.expires_at, createdAt: r.created_at, confirmedAt: r.confirmed_at, revokedAt: r.revoked_at,
});
const toInstr = (r: InstrRow): Instruction => ({
  id: r.id, projectId: r.project_id, text: r.text, version: r.version, createdAt: r.created_at, revokedAt: r.revoked_at,
});

export class Policy {
  private db: DatabaseSync;
  private log: BubblesLog;
  private now: () => number;
  private defaultEnabled: boolean;
  private cache: Grant[] | null = null;

  constructor(db: DatabaseSync, log: BubblesLog, opts: { defaultEnabled: boolean; now?: () => number }) {
    this.db = db; this.log = log; this.defaultEnabled = opts.defaultEnabled; this.now = opts.now ?? Date.now;
  }

  // ---- reads -------------------------------------------------------------------------------------

  /** Active grants (confirmed, not revoked, uses left, not expired at `now`). Served from memory; no DB hit when warm. */
  grants(now: number): Grant[] {
    this.cache ??= (this.db.prepare(
      'SELECT * FROM bubbles_grants WHERE revoked_at IS NULL AND (uses_left IS NULL OR uses_left > 0) ORDER BY created_at, rowid')
      .all() as unknown as GrantRow[]).map(toGrant);
    return this.cache.filter((g) => g.expiresAt > now);
  }

  /** Active instructions: global plus `projectId`'s (just the global ones for null), oldest first. */
  instructions(projectId: string | null): Instruction[] {
    const rows = this.db.prepare(
      `SELECT i.* FROM bubbles_instructions i
       WHERE i.revoked_at IS NULL
         AND i.version = (SELECT MAX(version) FROM bubbles_instructions WHERE id = i.id)
         AND (i.project_id IS NULL OR i.project_id = ?)
       ORDER BY i.created_at, i.rowid`).all(projectId) as unknown as InstrRow[];
    return rows.map(toInstr);
  }

  pending(): PendingChange[] {
    const rows = this.db.prepare('SELECT id, created_at, json FROM bubbles_pending WHERE created_at > ? ORDER BY created_at, rowid')
      .all(this.now() - PENDING_TTL_MS) as unknown as { id: string; created_at: number; json: string }[];
    return rows.map((r) => ({ id: r.id, createdAt: r.created_at, source: 'cli', change: JSON.parse(r.json) as Change }));
  }

  enabled(): boolean {
    const r = this.db.prepare("SELECT value FROM bubbles_state WHERE key = 'enabled'").get() as { value: string } | undefined;
    return r ? r.value === '1' : this.defaultEnabled;
  }

  // ---- owner-only writes ---------------------------------------------------------------------------

  addGrant(input: GrantInput, who: string, outcome = 'granted'): Grant {
    const v = validateGrant(input);
    const now = this.now();
    const g: Grant = {
      id: randomUUID(), projectId: v.projectId, action: v.action, branch: v.branch, usesLeft: v.uses,
      expiresAt: now + v.ttlMs, createdAt: now, confirmedAt: now, revokedAt: null,
    };
    this.db.prepare('INSERT INTO bubbles_grants (id, project_id, action, branch, uses_left, expires_at, created_at, confirmed_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,NULL)')
      .run(g.id, g.projectId, g.action, g.branch, g.usesLeft, g.expiresAt, g.createdAt, g.confirmedAt);
    this.cache = null;
    this.log.append({
      ts: now, kind: 'grant', projectId: g.projectId, outcome,
      detail: `${who}: ${g.action} ${g.branch ?? 'any branch'}, ${g.usesLeft === null ? 'unlimited uses' : g.usesLeft + ' use(s)'}, until ${new Date(g.expiresAt).toISOString()} [${g.id}]`,
    });
    return g;
  }

  /** With an existing `id`, creates version+1 and retires the older version. */
  addInstruction(input: InstructionInput, who: string, outcome?: string): Instruction {
    const text = validateInstruction(input.text);
    const now = this.now();
    const id = input.id ?? randomUUID();
    const prev = this.db.prepare('SELECT MAX(version) AS v FROM bubbles_instructions WHERE id = ?').get(id) as { v: number | null };
    const version = (prev.v ?? 0) + 1;
    this.db.prepare('INSERT INTO bubbles_instructions (id, version, project_id, text, created_at, revoked_at) VALUES (?,?,?,?,?,NULL)')
      .run(id, version, input.projectId, text, now);
    this.log.append({
      ts: now, kind: 'instruction', ...(input.projectId ? { projectId: input.projectId } : {}), outcome: outcome ?? (version > 1 ? 'replaced' : 'added'),
      detail: `${who}: [${id} v${version}] ${text}`,
    });
    return { id, projectId: input.projectId, text, version, createdAt: now, revokedAt: null };
  }

  revoke(target: 'grant' | 'instruction', id: string, who: string, outcome = 'revoked'): boolean {
    const now = this.now();
    let projectId: string | null = null;
    if (target === 'grant') {
      const row = this.db.prepare('SELECT project_id FROM bubbles_grants WHERE id = ? AND revoked_at IS NULL').get(id) as { project_id: string } | undefined;
      if (!row) return false;
      projectId = row.project_id;
      this.db.prepare('UPDATE bubbles_grants SET revoked_at = ? WHERE id = ?').run(now, id);
      this.cache = null;
    } else {
      const row = this.db.prepare('SELECT project_id FROM bubbles_instructions WHERE id = ? AND revoked_at IS NULL ORDER BY version DESC LIMIT 1').get(id) as { project_id: string | null } | undefined;
      if (!row) return false;
      projectId = row.project_id;
      this.db.prepare('UPDATE bubbles_instructions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
    }
    this.log.append({
      ts: now, kind: target, ...(projectId ? { projectId } : {}), outcome, detail: `${who}: revoked ${target} ${id}`,
    });
    return true;
  }

  setEnabled(enabled: boolean, who: string, outcome?: string): void {
    this.db.prepare("INSERT INTO bubbles_state (key, value) VALUES ('enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(enabled ? '1' : '0');
    this.log.append({ ts: this.now(), kind: 'toggle', outcome: outcome ?? (enabled ? 'on' : 'off'), detail: `${who}: Bubbles turned ${enabled ? 'on' : 'off'}` });
  }

  // ---- CLI proposals -------------------------------------------------------------------------------

  /** Validates exactly like the direct write, stores it pending (15 min), and logs outcome `proposed`. Throws PolicyError. */
  propose(change: Change): PendingChange {
    this.validate(change);
    const p: PendingChange = { id: randomUUID(), createdAt: this.now(), source: 'cli', change };
    this.db.prepare('INSERT INTO bubbles_pending (id, created_at, json) VALUES (?,?,?)').run(p.id, p.createdAt, JSON.stringify(change));
    this.logChange(p, 'proposed', `CLI request ${p.id}`);
    return p;
  }

  /** Applies a live pending change as the owner. 'not-found' when unknown, already handled, or older than 15 min. */
  confirm(id: string): 'ok' | 'not-found' {
    const p = this.pending().find((x) => x.id === id);
    if (!p) return 'not-found';
    this.db.prepare('DELETE FROM bubbles_pending WHERE id = ?').run(id);
    const who = `owner (confirmed CLI request ${id})`;
    const c = p.change;
    try {
      if (c.type === 'grant') this.addGrant({ projectId: c.projectId, action: c.action, branch: c.branch, uses: c.uses, ttlMs: c.ttlMs }, who, 'confirmed');
      else if (c.type === 'instruction') this.addInstruction({ projectId: c.projectId, text: c.text }, who, 'confirmed');
      else if (c.type === 'revoke') this.revoke(c.target, c.id, who, 'confirmed');
      else this.setEnabled(c.enabled, who, 'confirmed');
    } catch (err) {
      if (err instanceof PolicyError) return 'not-found';
      throw err;
    }
    return 'ok';
  }

  reject(id: string): void {
    const p = this.pending().find((x) => x.id === id);
    this.db.prepare('DELETE FROM bubbles_pending WHERE id = ?').run(id);
    if (p) this.logChange(p, 'rejected', `owner (office) rejected CLI request ${id}`);
  }

  /** Decrements a limited grant's uses; unlimited grants are untouched. */
  useGrant(id: string): void {
    this.db.prepare('UPDATE bubbles_grants SET uses_left = uses_left - 1 WHERE id = ? AND uses_left IS NOT NULL AND uses_left > 0').run(id);
    this.cache = null;
  }

  // ---- internals -----------------------------------------------------------------------------------

  private validate(c: Change): void {
    if (c.type === 'grant') validateGrant(c);
    else if (c.type === 'instruction') validateInstruction(c.text);
    else if (c.type === 'toggle') { if (typeof c.enabled !== 'boolean') throw new PolicyError('enabled must be true or false'); }
    else if (c.type === 'revoke') {
      const table = c.target === 'grant' ? 'bubbles_grants' : c.target === 'instruction' ? 'bubbles_instructions' : null;
      if (!table) throw new PolicyError(`unknown revoke target: ${String(c.target)}`);
      if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND revoked_at IS NULL`).get(c.id)) {
        throw new PolicyError(`no active ${c.target} with id ${String(c.id)}`);
      }
    } else throw new PolicyError(`unknown change type: ${String((c as { type?: unknown }).type)}`);
  }

  private logChange(p: PendingChange, outcome: string, who: string): void {
    const c = p.change;
    const kind = c.type === 'revoke' ? c.target : c.type;
    const desc = c.type === 'grant' ? `${c.action} ${c.branch ?? 'any branch'}, ${c.uses ?? 'unlimited'} use(s), ${c.ttlMs} ms`
      : c.type === 'instruction' ? c.text : c.type === 'revoke' ? `revoke ${c.target} ${c.id}` : `turn ${c.enabled ? 'on' : 'off'}`;
    const projectId = c.type === 'grant' || c.type === 'instruction' ? c.projectId : null;
    this.log.append({ ts: this.now(), kind, ...(projectId ? { projectId } : {}), outcome, detail: `${who}: ${desc}` });
  }
}

function validateGrant(g: GrantInput): { projectId: string; action: 'push' | 'merge'; branch: string | null; uses: number | null; ttlMs: number } {
  if (typeof g.projectId !== 'string' || !g.projectId) throw new PolicyError('projectId is required');
  if (g.action !== 'push' && g.action !== 'merge') throw new PolicyError(`unknown action: ${String(g.action)} (expected push or merge)`);
  if (g.branch !== null && (typeof g.branch !== 'string' || !g.branch)) throw new PolicyError('branch must be a name or null');
  const uses = g.uses === undefined ? 1 : g.uses;
  if (uses !== null && (!Number.isInteger(uses) || uses < 1)) throw new PolicyError('uses must be a positive integer or null');
  const ttlMs = g.ttlMs === undefined ? GRANT_DEFAULT_TTL_MS : g.ttlMs;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new PolicyError('ttl must be positive');
  if (ttlMs > GRANT_MAX_TTL_MS) throw new PolicyError('ttl may not exceed 7 days');
  return { projectId: g.projectId, action: g.action, branch: g.branch, uses, ttlMs };
}

function validateInstruction(text: unknown): string {
  if (typeof text !== 'string' || text.length < 1 || text.length > INSTRUCTION_MAX) {
    throw new PolicyError(`instruction text must be 1-${INSTRUCTION_MAX} characters`);
  }
  return text;
}
