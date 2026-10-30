import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfficeState, titleFor, moveWing, FEED_MAX } from '../../src/ui/state.ts';
import type { AgentView, ProjectRow } from '../../src/shared/protocol.ts';

const v = (id: string, o: Partial<AgentView> = {}): AgentView => ({
  id, sessionId: id, kind: 'session', name: id, role: 'general', projectId: '/p', status: 'working', activity: '',
  startedAt: 0, lastSeen: 0, approvals: 'off', log: [], ...o,
});
const proj = (id: string, wing: number, o: Partial<ProjectRow> = {}): ProjectRow => ({ id, name: id, wing, approvals: 'off', archived: false, firstSeen: 0, ...o });

test('needs-you fires only on the transition into waiting', () => {
  const s = new OfficeState();
  const first = s.apply({ t: 'snapshot', agents: [v('a', { status: 'waiting' })], projects: [], feed: [], banner: null });
  assert.equal(first.newlyWaiting.length, 0, 'no alert for what was already waiting at page load');
  assert.equal(first.firstSnapshot, true);
  assert.equal(s.apply({ t: 'agent', agent: v('b') }).newlyWaiting.length, 0);
  assert.deepEqual(s.apply({ t: 'agent', agent: v('b', { status: 'waiting' }) }).newlyWaiting.map((x) => x.id), ['b']);
  assert.equal(s.apply({ t: 'agent', agent: v('b', { status: 'waiting', activity: 'x' }) }).newlyWaiting.length, 0, 'staying waiting does not repeat');
  assert.equal(s.counts().needYou, 2);
  assert.equal(titleFor(s.counts().needYou), '(2) Agent Office');
  assert.equal(titleFor(0), 'Agent Office');
  // Reconnect snapshot: c newly waiting alerts, a (still waiting) does not; b vanished → expired.
  const re = s.apply({ t: 'snapshot', agents: [v('a', { status: 'waiting' }), v('c', { status: 'waiting' })], projects: [], feed: [], banner: null });
  assert.deepEqual(re.newlyWaiting.map((x) => x.id), ['c']);
  assert.deepEqual(re.removed.map((r) => [r.view.id, r.reason]), [['b', 'expired']]);
  assert.equal(re.firstSnapshot, false);
});

test('counts, removal and feed cap', () => {
  const s = new OfficeState();
  s.apply({ t: 'snapshot', agents: [v('a'), v('a:x', { kind: 'subagent', parentId: 'a' })], projects: [], feed: [], banner: null });
  assert.deepEqual(s.counts(), { sessions: 1, subagents: 1, needYou: 0 });
  const r = s.apply({ t: 'agentRemoved', id: 'a:x', reason: 'ended' });
  assert.deepEqual(r.removed.map((x) => x.view.id), ['a:x']);
  assert.equal(s.apply({ t: 'agentRemoved', id: 'nope', reason: 'ended' }).removed.length, 0);
  for (let i = 0; i < FEED_MAX + 5; i++) s.apply({ t: 'feed', item: { ts: i, event: 'PreToolUse', agentName: 'a', detail: String(i) } });
  assert.equal(s.feed.length, FEED_MAX);
  assert.equal(s.feed[0].detail, String(FEED_MAX + 4), 'newest first');
  assert.equal(s.apply({ t: 'banner', text: 'hi' }).banner, true);
  assert.equal(s.apply({ t: 'banner', text: 'hi' }).banner, false);
});

test('projects change detection and wing moves', () => {
  const s = new OfficeState();
  const ps = [proj('/a', 0), proj('/b', 1), proj('/c', 2, { archived: true }), proj('/d', 5)];
  assert.equal(s.apply({ t: 'projects', projects: ps }).projects, true);
  assert.equal(s.apply({ t: 'projects', projects: ps.map((p) => ({ ...p })) }).projects, false);
  assert.deepEqual(moveWing(ps, '/a', -1), null);
  assert.deepEqual(moveWing(ps, '/a', 1), { wing: 1 });
  assert.deepEqual(moveWing(ps, '/b', 1), { wing: 5 }, 'skips archived wings');
  assert.deepEqual(moveWing(ps, '/d', 1), null);
});
