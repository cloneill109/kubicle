import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfficeState, titleFor, moveWing, FEED_MAX, pickNeedsYou, shouldAutoSelect } from '../../src/ui/state.ts';
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
  assert.equal(titleFor(s.counts().needYou), '(2) Kubicle');
  assert.equal(titleFor(0), 'Kubicle');
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

const pend = (id: string, since: number, answerable: boolean) => ({ id, toolName: 'Bash', activity: 'x', since, answerable });

test('I5: pickNeedsYou -> oldest answerable waiting; fallback oldest waiting; none -> undefined', () => {
  const s = new OfficeState();
  s.apply({ t: 'snapshot', projects: [], feed: [], banner: null, agents: [
    v('w-old', { status: 'waiting', pending: pend('p1', 10, false) }),
    v('a-new', { status: 'waiting', pending: pend('p2', 50, true) }),
    v('a-old', { status: 'waiting', pending: pend('p3', 30, true) }),
    v('busy', { status: 'working' }),
  ] });
  assert.equal(pickNeedsYou(s.agents.values())?.id, 'a-old');
  const t = new OfficeState();
  t.apply({ t: 'snapshot', projects: [], feed: [], banner: null, agents: [
    v('w2', { status: 'waiting', pending: pend('p1', 20, false) }),
    v('w1', { status: 'waiting', lastSeen: 5 }), // waiting with no pending: ordered by lastSeen
    v('idle', { status: 'idle' }),
  ] });
  assert.equal(pickNeedsYou(t.agents.values())?.id, 'w1');
  assert.equal(pickNeedsYou(new OfficeState().agents.values()), undefined);
});

test('I5: newlyAnswerable reports a new answerable approval once (not on first snapshot)', () => {
  const s = new OfficeState();
  const first = s.apply({ t: 'snapshot', projects: [], feed: [], banner: null, agents: [v('a', { status: 'waiting', pending: pend('p0', 1, true) })] });
  assert.equal(first.newlyAnswerable.length, 0);
  assert.equal(s.apply({ t: 'agent', agent: v('b', { status: 'waiting', pending: pend('p1', 2, false) }) }).newlyAnswerable.length, 0, 'unanswerable');
  assert.deepEqual(s.apply({ t: 'agent', agent: v('b', { status: 'waiting', pending: pend('p1', 2, true) }) }).newlyAnswerable.map((x) => x.id), ['b'], 'upgraded to answerable');
  assert.equal(s.apply({ t: 'agent', agent: v('b', { status: 'waiting', pending: pend('p1', 2, true), activity: 'y' }) }).newlyAnswerable.length, 0, 'same approval again');
  assert.deepEqual(s.apply({ t: 'agent', agent: v('b', { status: 'waiting', pending: pend('p2', 3, true) }) }).newlyAnswerable.map((x) => x.id), ['b'], 'a different approval');
});

test('I5: shouldAutoSelect only when the current selection has no answerable pending', () => {
  const inc = v('n', { status: 'waiting', pending: pend('p', 1, true) });
  assert.equal(shouldAutoSelect(undefined, inc), true);
  assert.equal(shouldAutoSelect(v('cur', { status: 'working' }), inc), true);
  assert.equal(shouldAutoSelect(v('cur', { status: 'waiting', pending: pend('q', 1, false) }), inc), true);
  assert.equal(shouldAutoSelect(v('cur', { status: 'waiting', pending: pend('q', 1, true) }), inc), false, 'never steal an open approval');
  assert.equal(shouldAutoSelect(inc, inc), false, 'already selected');
});
