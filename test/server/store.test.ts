import { test } from 'node:test';
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
  const p = { id: '/r/a', name: 'a', wing: 2, approvals: 'office' as const, archived: false, firstSeen: 9 };
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
  assert.match(c.home, /\.agent-office$/);
  const o = loadConfig({ AGENT_OFFICE_PORT: '5000', AGENT_OFFICE_HOME: '/x/y' });
  assert.equal(o.port, 5000);
  assert.equal(o.home, '/x/y');
});
