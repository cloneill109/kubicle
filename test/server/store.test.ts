import { test } from 'node:test';
import { slugFor } from '../../src/server/building/files.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, EventWriter } from '../../src/server/store.ts';
import type { Store } from '../../src/server/store.ts';
import { loadConfig, ensureHome } from '../../src/server/config.ts';
import type { AgentEvent } from '../../src/shared/events.ts';

const ev = (n: number, over: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `e${n}`, ts: n, event: 'PreToolUse', sessionId: 's1', payload: '{}', ...over,
});

test('append + recentEvents newest first, round-trips whole event', () => {
  const s = openStore(':memory:');
  s.appendEvents([ev(1), ev(3, { toolName: 'Bash', agentId: 'a' }), ev(2)]);
  const r = s.recentEvents(2);
  assert.deepEqual(r.map((e) => e.id), ['e3', 'e2']);
  assert.equal(r[0].toolName, 'Bash');
  s.close();
});

test('eventsSince is ts >= and oldest first', () => {
  const s = openStore(':memory:');
  s.appendEvents([ev(5), ev(1), ev(3), ev(4)]);
  assert.deepEqual(s.eventsSince(3).map((e) => e.id), ['e3', 'e4', 'e5']);
  s.close();
});

test('project upsert round-trips and updates', () => {
  const s = openStore(':memory:');
  const p = { id: '/r/a', name: 'a', order: 2, slug: slugFor('/r/a'), approvals: 'office' as const, archived: false, firstSeen: 9 };
  s.upsertProject(p);
  assert.deepEqual(s.listProjects(), [p]);
  s.upsertProject({ ...p, archived: true, approvals: 'off' });
  const l = s.listProjects();
  assert.equal(l.length, 1);
  assert.equal(l[0].archived, true);
  assert.equal(l[0].approvals, 'off');
  s.close();
});

test('session approvals default null then set/get', () => {
  const s = openStore(':memory:');
  assert.equal(s.getSessionApprovals('x'), null);
  s.setSessionApprovals('x', 'office');
  assert.equal(s.getSessionApprovals('x'), 'office');
  s.setSessionApprovals('x', 'off');
  assert.equal(s.getSessionApprovals('x'), 'off');
  s.close();
});

test('prune deletes events older than ts', () => {
  const s = openStore(':memory:');
  s.appendEvents([ev(1), ev(2), ev(3)]);
  s.prune(3);
  assert.deepEqual(s.eventsSince(0).map((e) => e.id), ['e3']);
  s.close();
});

test('duplicate event id does not throw or duplicate', () => {
  const s = openStore(':memory:');
  s.appendEvents([ev(1)]);
  s.appendEvents([ev(1)]);
  assert.equal(s.recentEvents(10).length, 1);
  s.close();
});

test('EventWriter buffers until flush, one transaction for 500', () => {
  const calls: AgentEvent[][] = [];
  const inner = openStore(':memory:');
  const spy: Store = { ...inner, appendEvents: (es) => { calls.push(es); inner.appendEvents(es); } };
  const w = new EventWriter(spy, 60_000);
  for (let i = 0; i < 500; i++) w.push(ev(i));
  assert.equal(inner.recentEvents(1000).length, 0);
  w.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 500);
  assert.equal(inner.recentEvents(1000).length, 500);
  w.flush(); // empty flush is a no-op
  assert.equal(calls.length, 1);
  w.stop();
  inner.close();
});

test('EventWriter timer flushes and stop() flushes remaining', async () => {
  const s = openStore(':memory:');
  const w = new EventWriter(s, 10);
  w.push(ev(1));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.recentEvents(10).length, 1);
  w.push(ev(2));
  w.stop();
  assert.equal(s.recentEvents(10).length, 2);
  s.close();
});

test('db file mode is 0600; ensureHome dir is 0700', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  try {
    const home = join(dir, 'home');
    ensureHome({ ...loadConfig({}), home });
    assert.equal(statSync(home).mode & 0o777, 0o700);
    const file = join(home, 'office.db');
    const s = openStore(file);
    s.appendEvents([ev(1)]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    s.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadConfig defaults and env overrides', () => {
  const c = loadConfig({});
  assert.equal(c.port, 4317);
  assert.equal(c.payloadCap, 4096);
  assert.equal(c.approvalWaitMs, 120000);
  assert.equal(c.quietMs, 300000);
  assert.equal(c.lostMs, 1800000);
  assert.equal(c.expireMs, 86400000);
  assert.equal(c.bannerMs, 600000);
  assert.match(c.home, /\.kubicle$/);
  const o = loadConfig({ KUBICLE_PORT: '5000', KUBICLE_HOME: '/x/y' });
  assert.equal(o.port, 5000);
  assert.equal(o.home, '/x/y');
});

test('EventWriter isolates a poison event: others persist, dropped counted', () => {
  const s = openStore(':memory:');
  const w = new EventWriter(s, 60_000);
  const bad = ev(2) as AgentEvent & { toJSON?: () => never };
  bad.toJSON = () => { throw new Error('poison'); };
  const orig = console.error;
  const logged: unknown[][] = [];
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    w.push(ev(1)); w.push(bad); w.push(ev(3));
    w.flush();
  } finally { console.error = orig; }
  assert.deepEqual(s.eventsSince(0).map((e) => e.id), ['e1', 'e3']);
  assert.equal(w.dropped, 1);
  assert.equal(logged.length, 1);
  w.stop();
  s.close();
});

// ---- final review I2: the CLI's read-only store works on an un-migrated stage-1 office.db ----
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

function stage1Db(file: string, rows: { id: string; name: string; wing: number; archived?: boolean }[]): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL,
      agent_id TEXT, event TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, wing INTEGER NOT NULL,
      approvals TEXT NOT NULL, archived INTEGER NOT NULL, first_seen INTEGER NOT NULL);
    CREATE TABLE session_settings (session_id TEXT PRIMARY KEY, approvals TEXT NOT NULL);
  `);
  const ins = db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?)');
  rows.forEach((r, i) => ins.run(r.id, r.name, r.wing, 'off', r.archived ? 1 : 0, i + 1));
  db.close();
}

test('I2: read-only openStore lists projects on a stage-1 schema (no room column) and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-store-'));
  try {
    const file = join(dir, 'office.db');
    stage1Db(file, [{ id: '/p/a', name: 'a', wing: 2 }, { id: '/p/b', name: 'b', wing: 1, archived: true }]);
    const before = readFileSync(file);
    const st = openStore(file, { readOnly: true });
    try {
      assert.deepEqual(st.listProjects().map((p) => [p.id, p.order, p.archived]), [['/p/a', 2, false], ['/p/b', 1, true]]);
      assert.equal(st.getSessionApprovals('x'), null);
    } finally { st.close(); }
    assert.deepEqual(readFileSync(file), before, 'unchanged');
    const cols = (new DatabaseSync(file).prepare('PRAGMA table_info(session_settings)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(!cols.includes('room'), 'not migrated');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migration user_version 0 -> 1: every project becomes office once; a later explicit off survives reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-store-'));
  try {
    const file = join(dir, 'office.db');
    stage1Db(file, [{ id: '/p/a', name: 'a', wing: 0 }, { id: '/p/b', name: 'b', wing: 1 }]);
    let st = openStore(file);
    assert.deepEqual(st.listProjects().map((p) => p.approvals), ['office', 'office']);
    assert.equal((st.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
    const a = st.listProjects()[0]!;
    st.upsertProject({ ...a, approvals: 'off' });
    st.close();
    st = openStore(file);
    assert.deepEqual(st.listProjects().map((p) => p.approvals), ['off', 'office']);
    st.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
