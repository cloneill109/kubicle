import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Redactor } from './redact.ts';

export type LogKind =
  'triage' | 'escalation' | 'owner-answer' | 'guard' | 'grant' | 'instruction' | 'toggle' | 'error' | 'usage';

export interface LogEntry {
  seq: number; ts: number; kind: LogKind;
  projectId?: string; room?: string; sessionId?: string; agentId?: string; agentType?: string;
  transcriptPath?: string; toolUseId?: string; request?: string; shownHash?: string; shown?: string;
  model?: string; promptVersion?: string; latencyMs?: number; usage?: unknown;
  decision?: string; confidence?: number; reason?: string; outcome?: string;
  ref?: number; detail?: string; prevHash: string; hash: string;
}

export interface LogQuery {
  projectId?: string; sessionId?: string; kind?: LogKind; since?: number; grep?: string; limit?: number;
}

export type VerifyResult = { ok: true; count: number } | { ok: false; badSeq: number; why: string };

const GENESIS = '0'.repeat(64);
const REDACTED_FIELDS = ['request', 'shown', 'reason', 'detail', 'recommendation'];

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** JSON with keys sorted at every depth, so the hashed bytes do not depend on insertion order. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x);
}

const pad = (n: number) => String(n).padStart(2, '0');
const monthOf = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

interface Row { seq: number; ts: number; kind: string; json: string; prev_hash: string; hash: string }

/**
 * Append-only: this module only ever INSERTs and SELECTs bubbles_log.
 * Chain: hash = sha256(prev_hash + '\n' + json), json = canonical entry without seq/prevHash/hash.
 * Limitation: deleting the LAST row(s) leaves a valid shorter chain, so verify() cannot see it from the
 * DB alone; the JSONL mirror (which keeps the deleted lines) is what exposes that.
 */
export class BubblesLog {
  onAppend?: (e: LogEntry) => void;
  private db: DatabaseSync;
  private home: string;
  private redact: Redactor;
  private warn: string | null = null;

  constructor(db: DatabaseSync, home: string, redact: Redactor) {
    this.db = db; this.home = home; this.redact = redact;
  }

  /** Banner text while the JSONL mirror is failing; cleared by the next successful mirror write. */
  warning(): string | null { return this.warn; }

  /**
   * `opts.verbatim`: fields the caller has ALREADY redacted with this same redactor and that must be stored
   * byte-for-byte (e.g. `shown`, whose sha256 is logged alongside it). Every other field is redacted here.
   */
  append(e: Omit<LogEntry, 'seq' | 'prevHash' | 'hash'>, opts: { verbatim?: readonly 'shown'[] } = {}): LogEntry {
    const body: Record<string, unknown> = { ...e };
    const keep = new Set<string>(opts.verbatim ?? []);
    for (const f of REDACTED_FIELDS) if (!keep.has(f) && typeof body[f] === 'string') body[f] = this.redact(body[f] as string);
    // Object-valued fields (usage, …) may carry strings too: redact every nested string.
    for (const k of Object.keys(body)) if (body[k] && typeof body[k] === 'object') body[k] = this.deep(body[k]);
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    const json = canonical(body);

    let seq: number; let prevHash: string; let hash: string;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const last = this.db.prepare('SELECT hash FROM bubbles_log ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
      prevHash = last?.hash ?? GENESIS;
      hash = sha(prevHash + '\n' + json);
      const r = this.db.prepare('INSERT INTO bubbles_log (ts, kind, json, prev_hash, hash) VALUES (?,?,?,?,?)')
        .run(e.ts, e.kind, json, prevHash, hash);
      seq = Number(r.lastInsertRowid);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const entry = { ...(JSON.parse(json) as object), seq, prevHash, hash } as LogEntry;
    this.mirror(e.ts, JSON.stringify({ seq, ts: e.ts, kind: e.kind, ...(JSON.parse(json) as object), prev_hash: prevHash, hash }));
    try { this.onAppend?.(entry); } catch (err) { console.error('bubbles log onAppend failed:', err); }
    return entry;
  }

  private deep(v: unknown): unknown {
    if (typeof v === 'string') return this.redact(v);
    if (Array.isArray(v)) return v.map((x) => this.deep(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.deep(x)]));
    return v;
  }

  private mirror(ts: number, line: string): void {
    try {
      const dir = join(this.home, 'log');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700); // recursive mkdir leaves a pre-existing dir's mode alone
      const file = join(dir, `bubbles-${monthOf(ts)}.jsonl`);
      appendFileSync(file, line + '\n', { mode: 0o600 });
      chmodSync(file, 0o600);
      this.warn = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Bubbles log mirror failed:', msg);
      this.warn = `Bubbles log mirror failed: ${msg}`;
    }
  }

  query(f: LogQuery = {}): LogEntry[] {
    const where: string[] = []; const args: (string | number)[] = [];
    if (f.kind) { where.push('kind = ?'); args.push(f.kind); }
    if (f.since !== undefined) { where.push('ts >= ?'); args.push(f.since); }
    if (f.projectId) { where.push("json_extract(json, '$.projectId') = ?"); args.push(f.projectId); }
    if (f.sessionId) { where.push("json_extract(json, '$.sessionId') = ?"); args.push(f.sessionId); }
    if (f.grep) { where.push('instr(lower(json), lower(?)) > 0'); args.push(f.grep); }
    const limit = Math.min(Math.max(Math.trunc(f.limit ?? 200), 1), 1000);
    const sql = `SELECT seq, ts, kind, json, prev_hash, hash FROM bubbles_log${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, limit) as unknown as Row[]).map(toEntry);
  }

  verify(): VerifyResult {
    let prev = GENESIS; let expectSeq = 0; let count = 0;
    for (const r of this.db.prepare('SELECT seq, ts, kind, json, prev_hash, hash FROM bubbles_log ORDER BY seq').iterate() as Iterable<unknown> as Iterable<Row>) {
      if (expectSeq !== 0 && r.seq !== expectSeq) return { ok: false, badSeq: r.seq, why: `seq gap: expected ${expectSeq}` };
      if (r.prev_hash !== prev) return { ok: false, badSeq: r.seq, why: 'prev_hash does not match previous row' };
      if (sha(r.prev_hash + '\n' + r.json) !== r.hash) return { ok: false, badSeq: r.seq, why: 'hash does not match content' };
      let j: { ts?: unknown; kind?: unknown };
      try { j = JSON.parse(r.json); } catch { return { ok: false, badSeq: r.seq, why: 'json is not parseable' }; }
      if (j.ts !== r.ts || j.kind !== r.kind) return { ok: false, badSeq: r.seq, why: 'column/json mismatch' };
      prev = r.hash; expectSeq = r.seq + 1; count++;
    }
    return { ok: true, count };
  }
}

function toEntry(r: Row): LogEntry {
  return { ...(JSON.parse(r.json) as object), seq: r.seq, prevHash: r.prev_hash, hash: r.hash } as LogEntry;
}
