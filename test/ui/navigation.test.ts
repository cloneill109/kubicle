// Stage 1b navigation: per-floor badges, the default floor, the picker's items, the elevator glow
// condition, and per-floor Sim placement (division hint, label, removed room, subagent next to parent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfficeState, liveFloors, moveFloor } from '../../src/ui/state.ts';
import { buildFloor } from '../../src/ui/sim/world.ts';
import { Sim } from '../../src/ui/sim/agents.ts';
import { defaultFloor, DEFAULT_DIVISIONS, type Building, type FloorDef } from '../../src/shared/building.ts';
import type { AgentView, ProjectRow, ServerMsg } from '../../src/shared/protocol.ts';

const DIVS = DEFAULT_DIVISIONS.map((d) => ({ ...d, revision: 1 }));
const v = (id: string, o: Partial<AgentView> = {}): AgentView => ({
  id, sessionId: id.split(':')[0], kind: 'session', name: id, role: 'general', projectId: '/a', status: 'working', activity: '',
  startedAt: 0, lastSeen: 0, approvals: 'off', log: [], ...o,
});
const proj = (id: string, order: number, o: Partial<ProjectRow> = {}): ProjectRow => ({ id, name: id.slice(1), order, slug: id.slice(1), approvals: 'off', archived: false, firstSeen: 0, ...o });
const bld = (ids: string[]): Building => ({ divisions: DIVS, floors: Object.fromEntries(ids.map((id) => [id, defaultFloor()])), overrides: {}, mcp: { revision: 0, servers: {} }, skills: [], importable: [], warnings: [], settings: { revision: 0, default_permission_mode: 'auto' } });
const snap = (agents: AgentView[], projects: ProjectRow[] = [proj('/a', 0), proj('/b', 1)]): ServerMsg =>
  ({ t: 'snapshot', agents, projects, feed: [], banner: null, building: bld(projects.map((p) => p.id)),
    bubbles: { status: { state: 'on', detail: '', callsToday: 0, cap: 300, thinking: 0 }, instructions: [], grants: [], pending: [] } });
const pend = (since: number) => ({ id: `p${since}`, toolName: 'Bash', activity: 'x', since, answerable: true });

test('floorBadges counts agents and needs-you per project (unassigned under "")', () => {
  const s = new OfficeState();
  s.apply(snap([
    v('a1'), v('a1:x', { kind: 'subagent', parentId: 'a1' }), v('a2', { status: 'waiting' }),
    v('b1', { projectId: '/b', status: 'waiting' }), v('u', { projectId: '' }),
  ]));
  const b = s.floorBadges();
  assert.deepEqual(b.get('/a'), { agents: 3, needYou: 1 });
  assert.deepEqual(b.get('/b'), { agents: 1, needYou: 1 });
  assert.deepEqual(b.get(''), { agents: 1, needYou: 0 });
  assert.equal(b.get('/c'), undefined);
});

test('default currentFloor: the waiting agent\'s floor, else the most recently active, else the Lobby', () => {
  const w = new OfficeState();
  w.apply(snap([v('a1', { lastSeen: 900 }), v('b1', { projectId: '/b', status: 'waiting', lastSeen: 5, pending: pend(5) })]));
  assert.equal(w.currentFloor, '/b', 'waiting beats recent activity');

  const r = new OfficeState();
  r.apply(snap([v('a1', { lastSeen: 10 }), v('b1', { projectId: '/b', lastSeen: 50 }), v('u', { projectId: '', lastSeen: 99, status: 'waiting' })]));
  assert.equal(r.currentFloor, '/b', 'most recent lastSeen; unassigned agents never pick a floor');

  const l = new OfficeState();
  l.apply(snap([]));
  assert.equal(l.currentFloor, 'lobby');
  assert.equal(new OfficeState().currentFloor, 'lobby', 'before any snapshot');
});

test('a saved floor wins on reload if it still exists; otherwise the default', () => {
  const s = new OfficeState({ preferredFloor: '/a' });
  s.apply(snap([v('b1', { projectId: '/b', status: 'waiting' })]));
  assert.equal(s.currentFloor, '/a');
  const l = new OfficeState({ preferredFloor: 'lobby' });
  l.apply(snap([v('b1', { projectId: '/b' })]));
  assert.equal(l.currentFloor, 'lobby');
  const gone = new OfficeState({ preferredFloor: '/zzz' });
  gone.apply(snap([v('b1', { projectId: '/b' })]));
  assert.equal(gone.currentFloor, '/b');
});

test('an automatic Lobby moves to the first floor that gets agents; a chosen Lobby stays', () => {
  const s = new OfficeState();
  s.apply(snap([], []));
  assert.equal(s.currentFloor, 'lobby');
  s.apply({ t: 'projects', projects: [proj('/a', 0)] });
  const c = s.apply({ t: 'agent', agent: v('a1') });
  assert.equal(s.currentFloor, '/a');
  assert.equal(c.floor, true, 'reports the floor change');
  assert.equal(s.apply({ t: 'agent', agent: v('b1', { projectId: '/b' }) }).floor, false, 'no jump once on a floor');

  const k = new OfficeState();
  k.apply(snap([]));
  k.setFloor('lobby');
  k.apply({ t: 'agent', agent: v('a1') });
  assert.equal(k.currentFloor, 'lobby', 'the owner chose the Lobby');
});

test('the current floor falls back to the Lobby if its project disappears', () => {
  const s = new OfficeState();
  s.apply(snap([v('b1', { projectId: '/b' })]));
  assert.equal(s.currentFloor, '/b');
  const c = s.apply({ t: 'projects', projects: [proj('/a', 0)] });
  assert.equal(s.currentFloor, 'lobby');
  assert.equal(c.floor, true);
});

test('floorItems: Lobby first, then live floors in order with badges; othersNeedYou excludes the current floor', () => {
  const s = new OfficeState();
  s.apply(snap([v('a1', { status: 'waiting' }), v('c1', { projectId: '/c' }), v('b1', { projectId: '/b', status: 'waiting' }), v('u', { projectId: '', status: 'waiting' })],
    [proj('/a', 2), proj('/b', 0), proj('/c', 1), proj('/d', 3, { archived: true })]));
  assert.deepEqual(s.floorItems(), [
    { id: 'lobby', name: 'Lobby', agents: 4, needYou: 3 },
    { id: '/b', name: 'b', agents: 1, needYou: 1 },
    { id: '/c', name: 'c', agents: 1, needYou: 0 },
    { id: '/a', name: 'a', agents: 1, needYou: 1 },
  ]);
  s.setFloor('/a');
  assert.equal(s.othersNeedYou(), 1, 'only /b (not /a, not unassigned)');
  s.setFloor('/c');
  assert.equal(s.othersNeedYou(), 2);
  s.setFloor('lobby');
  assert.equal(s.othersNeedYou(), 2);
});

test('floor moves skip archived floors', () => {
  const ps = [proj('/a', 0), proj('/b', 1), proj('/c', 2, { archived: true }), proj('/d', 5)];
  assert.deepEqual(liveFloors(ps).map((p) => p.id), ['/a', '/b', '/d']);
  assert.equal(moveFloor(ps, '/a', -1), null);
  assert.deepEqual(moveFloor(ps, '/b', 1), { order: 5 });
});

// ---- Sim placement per floor ----
const floorWithout = (id: string): FloorDef => ({ ...defaultFloor(), rooms: defaultFloor().rooms.filter((r) => r.id !== id) });
const roomOfAgent = (sim: Sim, id: string) => sim.roomOf(sim.agents().find((a) => a.view.id === id)!);
const roomAt = (sim: Sim, id: string) => { const a = sim.agents().find((x) => x.view.id === id)!; return sim.world.grid[Math.floor(a.y)][Math.floor(a.x)].room; };

test('Sim: a division hint lands in the matching room; a label wins over it', () => {
  const sim = new Sim(buildFloor(defaultFloor(), DIVS));
  sim.upsert(v('d', { division: 'security' }), 0, { place: true });
  sim.upsert(v('l', { division: 'security', roomLabel: 'animation' }), 0, { place: true });
  assert.equal(roomAt(sim, 'd'), 'security');
  assert.equal(roomAt(sim, 'l'), 'animation');
});

test('Sim: a label naming a room the floor no longer has puts the agent in the Bullpen', () => {
  const sim = new Sim(buildFloor(floorWithout('qa'), DIVS));
  sim.upsert(v('x', { roomLabel: 'qa', division: 'qa' }), 0, { place: true });
  assert.equal(roomOfAgent(sim, 'x'), 'bullpen');
  assert.equal(roomAt(sim, 'x'), 'bullpen');
});

test('Sim: a subagent stands next to its parent', () => {
  const sim = new Sim(buildFloor(defaultFloor(), DIVS));
  sim.upsert(v('p', { roomLabel: 'uxui' }), 0, { place: true });
  sim.upsert(v('p:s', { kind: 'subagent', parentId: 'p', division: 'backend' }), 0, { place: true });
  const p = sim.agents().find((a) => a.view.id === 'p')!, s = sim.agents().find((a) => a.view.id === 'p:s')!;
  assert.equal(roomAt(sim, 'p:s'), 'uxui');
  assert.ok(Math.hypot(p.x - s.x, p.y - s.y) < 2.5);
});
