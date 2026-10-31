import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import type { AgentEvent } from '../shared/events.ts';
import type { ProjectRow } from '../shared/protocol.ts';
import { slugFor } from './building/files.ts';

export type { ProjectRow };

export interface Store {
  appendEvents(events: AgentEvent[]): void;
  recentEvents(limit: number): AgentEvent[];
  eventsSince(ts: number): AgentEvent[];
  upsertProject(p: ProjectRow): void;
  listProjects(): ProjectRow[];
  getSessionApprovals(sessionId: string): 'off' | 'office' | null;
  setSessionApprovals(sessionId: string, mode: 'off' | 'office'): void;
  getSessionRoom(sessionId: string): string | null;
  setSessionRoom(sessionId: string, roomId: string | null): void;
  prune(olderThanTs: number): void;
  close(): void;
}

/** `readOnly` opens an existing file without creating tables, changing the journal mode or chmod-ing (the CLI uses it to list projects). */
export function openStore(file: string, opts: { readOnly?: boolean } = {}): Store {
  const db = new DatabaseSync(file, opts.readOnly ? { readOnly: true } : {});
  if (!opts.readOnly) initSchema(db, file);
  return storeOn(db);
}

function initSchema(db: DatabaseSync, file: string): void {
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL,
      agent_id TEXT, event TEXT NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, wing INTEGER NOT NULL,
      approvals TEXT NOT NULL, archived INTEGER NOT NULL, first_seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS session_settings (
      session_id TEXT PRIMARY KEY, approvals TEXT NOT NULL);
  `);
  // Older databases lack the room column; add it in place.
  if (!(db.prepare('PRAGMA table_info(session_settings)').all() as { name: string }[]).some((c) => c.name === 'room')) {
    db.exec('ALTER TABLE session_settings ADD COLUMN room TEXT');
  }
  if (file !== ':memory:') {
    // Main file plus WAL/SHM sidecars must not be world-readable.
    for (const f of [file, file + '-wal', file + '-shm']) {
      if (existsSync(f)) chmodSync(f, 0o600);
    }
  }
}

function storeOn(db: DatabaseSync): Store {
  // Statements are prepared on first use: a read-only open of an un-migrated (stage 1) database
  // must still list projects, and preparing `SELECT room …` there would throw.
  const lazy = (sql: string) => { let st: StatementSync | undefined; return () => (st ??= db.prepare(sql)); };
  const insEvent = lazy(
    'INSERT OR IGNORE INTO events (id, ts, session_id, agent_id, event, json) VALUES (?,?,?,?,?,?)');
  const selRecent = lazy('SELECT json FROM events ORDER BY ts DESC, rowid DESC LIMIT ?');
  const selSince = lazy('SELECT json FROM events WHERE ts >= ? ORDER BY ts ASC, rowid ASC');
  const upProject = lazy(
    `INSERT INTO projects (id, name, wing, approvals, archived, first_seen) VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, wing=excluded.wing,
       approvals=excluded.approvals, archived=excluded.archived, first_seen=excluded.first_seen`);
  const selProjects = lazy(
    'SELECT id, name, wing, approvals, archived, first_seen FROM projects ORDER BY first_seen, id');
  const selSession = lazy('SELECT approvals FROM session_settings WHERE session_id = ?');
  // approvals is NOT NULL in older databases: a row that only carries a room stores '' (= unset).
  const upSession = lazy(
    `INSERT INTO session_settings (session_id, approvals) VALUES (?,?)
     ON CONFLICT(session_id) DO UPDATE SET approvals=excluded.approvals`);
  const selRoom = lazy('SELECT room FROM session_settings WHERE session_id = ?');
  const upRoom = lazy(
    `INSERT INTO session_settings (session_id, approvals, room) VALUES (?,'',?)
     ON CONFLICT(session_id) DO UPDATE SET room=excluded.room`);
  const delOld = lazy('DELETE FROM events WHERE ts < ?');

  const parse = (rows: unknown[]): AgentEvent[] =>
    rows.map((r) => JSON.parse((r as { json: string }).json) as AgentEvent);

  return {
    appendEvents(events) {
      if (events.length === 0) return;
      db.exec('BEGIN');
      try {
        for (const e of events) {
          insEvent().run(e.id, e.ts, e.sessionId, e.agentId ?? null, e.event, JSON.stringify(e));
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    recentEvents: (limit) => parse(selRecent().all(limit)),
    eventsSince: (ts) => parse(selSince().all(ts)),
    upsertProject(p) {
      upProject().run(p.id, p.name, p.order, p.approvals, p.archived ? 1 : 0, p.firstSeen);
    },
    listProjects() {
      return selProjects().all().map((r: any) => ({
        id: r.id, name: r.name, order: r.wing, slug: slugFor(r.id), approvals: r.approvals,
        archived: r.archived !== 0, firstSeen: r.first_seen,
      }));
    },
    getSessionApprovals(sessionId) {
      const r = selSession().get(sessionId) as { approvals: 'off' | 'office' } | undefined;
      return r && (r.approvals === 'off' || r.approvals === 'office') ? r.approvals : null;
    },
    setSessionApprovals(sessionId, mode) { upSession().run(sessionId, mode); },
    getSessionRoom(sessionId) {
      const r = selRoom().get(sessionId) as { room: string | null } | undefined;
      return r?.room ?? null;
    },
    setSessionRoom(sessionId, roomId) { upRoom().run(sessionId, roomId); },
    prune(ts) { delOld().run(ts); },
    close() { db.close(); },
  };
}

export class EventWriter {
  private buf: AgentEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null;
  private store: Store;
  dropped = 0;

  constructor(store: Store, flushMs = 250) {
    this.store = store;
    this.timer = setInterval(() => this.flush(), flushMs);
    this.timer.unref();
  }

  push(e: AgentEvent): void { this.buf.push(e); }

  flush(): void {
    if (this.buf.length === 0) return;
    const batch = this.buf;
    this.buf = [];
    try {
      this.store.appendEvents(batch);
      return;
    } catch {
      // Batch rolled back: retry one by one so a poison event drops only itself.
    }
    for (const e of batch) {
      try {
        this.store.appendEvents([e]);
      } catch (err) {
        this.dropped++;
        console.error('event write failed, dropped:', err);
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }
}
