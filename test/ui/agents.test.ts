import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, seatOf, assignDesk, type World } from '../../src/ui/sim/world.ts';
import { Sim } from '../../src/ui/sim/agents.ts';
import type { AgentView } from '../../src/shared/protocol.ts';

const A = '/Users/me/code/alpha', B = '/Users/me/code/beta';
const PROJECTS = [{ id: A, name: 'alpha', wing: 0 }, { id: B, name: 'beta', wing: 1 }];

function view(o: Partial<AgentView> & { id: string }): AgentView {
  return {
    sessionId: o.id.split(':')[0], kind: 'session', name: o.id, role: 'general', projectId: A, status: 'working',
    activity: '', startedAt: 0, lastSeen: 0, approvals: 'off', log: [], ...o,
  };
}

/** Steps the sim in 50 ms ticks; returns the new clock. `each` sees every intermediate state. */
function run(sim: Sim, from: number, secs: number, each?: () => void): number {
  let t = from;
  for (let i = 0; i < secs * 20; i++) { t += 0.05; sim.step(0.05, t); each?.(); }
  return t;
}

const get = (sim: Sim, id: string) => sim.agents().find((a) => a.view.id === id);
const inRoom = (w: World, roomId: string, x: number, y: number) => {
  const r = w.rooms.find((q) => q.id === roomId)!;
  return x >= r.x0 && x <= r.x1 + 1 && y >= r.y0 && y <= r.y1 + 1;
};

test('a new agent starts at the elevator and walks to its desk', () => {
  const w = buildWorld(PROJECTS);
  const sim = new Sim(w);
  sim.upsert(view({ id: 's1' }), 0);
  const a = get(sim, 's1')!;
  assert.ok(Math.hypot(a.x - (w.elevator.x + 0.5), a.y - (w.elevator.y - 0.5)) < 0.01, `starts at elevator, got ${a.x},${a.y}`);
  assert.equal(a.anim, 'walking');
  run(sim, 0, 60);
  const b = get(sim, 's1')!;
  const desk = assignDesk(w, A, new Set())!;
  assert.equal(b.anim, 'seated');
  assert.equal(b.desk, desk);
  const s = seatOf(desk);
  assert.ok(Math.hypot(b.x - s.x, b.y - s.y) < 0.01, 'sits at the seat');
  assert.equal(b.dir, 'up');
});

test('placed agents (snapshot) appear at their desk at once', () => {
  const w = buildWorld(PROJECTS);
  const sim = new Sim(w);
  sim.upsert(view({ id: 's1', projectId: B }), 0, { place: true });
  const a = get(sim, 's1')!;
  assert.equal(a.anim, 'seated');
  assert.equal(a.desk?.room, B);
});

test('a subagent sits in its parent\'s wing', () => {
  const w = buildWorld(PROJECTS);
  const sim = new Sim(w);
  sim.upsert(view({ id: 'p', projectId: B }), 0);
  sim.upsert(view({ id: 'p:x', kind: 'subagent', parentId: 'p', projectId: B, role: 'Explore' }), 0);
  sim.upsert(view({ id: 'p:y', kind: 'subagent', parentId: 'p', projectId: '', role: 'Plan' }), 0); // project not known yet
  run(sim, 0, 60);
  for (const id of ['p:x', 'p:y']) {
    const s = get(sim, id)!;
    assert.equal(s.desk?.room, B, `${id} has a desk in the parent's wing`);
    assert.equal(s.anim, 'seated');
  }
});

test('a subagent with no free desk stands next to its parent', () => {
  const w = buildWorld(PROJECTS);
  const sim = new Sim(w);
  for (let i = 0; i < 8; i++) sim.upsert(view({ id: `s${i}` }), 0, { place: true });
  sim.upsert(view({ id: 's0:sub', kind: 'subagent', parentId: 's0' }), 0);
  run(sim, 0, 60);
  const p = get(sim, 's0')!, s = get(sim, 's0:sub')!;
  assert.equal(s.desk, undefined);
  assert.equal(s.anim, 'standing');
  assert.ok(Math.hypot(s.x - p.x, s.y - p.y) < 2.5, `near parent (${s.x},${s.y} vs ${p.x},${p.y})`);
});

test('remove(ended) walks to the elevator, then disappears', () => {
  const w = buildWorld(PROJECTS);
  const sim = new Sim(w);
  sim.upsert(view({ id: 's1' }), 0, { place: true });
  sim.remove('s1', 'ended', 0);
  const a = get(sim, 's1');
  assert.ok(a, 'still visible while leaving');
  assert.equal(a.anim, 'leaving');
  assert.equal(a.desk, undefined, 'desk released at once');
  let closest = Infinity;
  run(sim, 0, 60, () => {
    const b = get(sim, 's1');
    if (b) closest = Math.min(closest, Math.hypot(b.x - (w.elevator.x + 0.5), b.y - w.elevator.y));
  });
  assert.equal(get(sim, 's1'), undefined, 'gone');
  assert.ok(closest < 1, `reached the elevator (closest ${closest.toFixed(2)})`);
});

test('remove(expired) disappears at once', () => {
  const sim = new Sim(buildWorld(PROJECTS));
  sim.upsert(view({ id: 's1' }), 0, { place: true });
  sim.remove('s1', 'expired', 0);
  assert.equal(get(sim, 's1'), undefined);
  assert.equal(sim.agents().length, 0);
});

test('the 9th agent in a wing gets no desk and stands in the wing', () => {
  const w = buildWorld(PROJECTS);
  const sim = new Sim(w);
  for (let i = 0; i < 9; i++) sim.upsert(view({ id: `s${i}` }), 0);
  run(sim, 0, 90);
  const all = sim.agents();
  assert.equal(all.filter((a) => a.desk).length, 8);
  assert.equal(new Set(all.map((a) => a.desk).filter(Boolean)).size, 8, 'desks are unique');
  const ninth = get(sim, 's8')!;
  assert.equal(ninth.desk, undefined);
  assert.equal(ninth.anim, 'standing');
  assert.ok(inRoom(w, A, ninth.x, ninth.y), `stands inside the wing (${ninth.x},${ninth.y})`);
  for (const o of all) if (o !== ninth) assert.ok(Math.hypot(o.x - ninth.x, o.y - ninth.y) > 0.9, 'not on top of anyone');
});

test('a freed desk goes to the next agent', () => {
  const w = buildWorld(PROJECTS);
  const sim = new Sim(w);
  for (let i = 0; i < 8; i++) sim.upsert(view({ id: `s${i}` }), 0, { place: true });
  const d0 = get(sim, 's0')!.desk;
  sim.remove('s0', 'expired', 0);
  sim.upsert(view({ id: 'new' }), 0);
  assert.equal(get(sim, 'new')!.desk, d0);
});

test('an unassigned agent stands in the hall near the elevator', () => {
  const w = buildWorld(PROJECTS);
  const sim = new Sim(w);
  sim.upsert(view({ id: 'u1', projectId: '' }), 0);
  sim.upsert(view({ id: 'u2', projectId: '' }), 0);
  run(sim, 0, 30);
  const u1 = get(sim, 'u1')!, u2 = get(sim, 'u2')!;
  for (const u of [u1, u2]) {
    assert.equal(u.desk, undefined);
    assert.equal(u.anim, 'standing');
    assert.equal(w.grid[Math.floor(u.y)][Math.floor(u.x)].room, 'hall');
    assert.ok(Math.hypot(u.x - w.elevator.x, u.y - w.elevator.y) < 10, 'near the elevator');
  }
  assert.ok(Math.hypot(u1.x - u2.x, u1.y - u2.y) > 0.9, 'different spots');
  // Once the project is known, it walks to a desk.
  sim.upsert(view({ id: 'u1', projectId: B }), 31);
  run(sim, 31, 60);
  assert.equal(get(sim, 'u1')!.desk?.room, B);
  assert.equal(get(sim, 'u1')!.anim, 'seated');
});

test('nobody is seated in the coordinator room', () => {
  const sim = new Sim(buildWorld(PROJECTS));
  for (let i = 0; i < 12; i++) sim.upsert(view({ id: `s${i}` }), 0, { place: true });
  assert.ok(sim.agents().every((a) => a.desk?.room !== 'coordinator'));
});

test('activity bubbles are rate-limited to one per 4 s per agent', () => {
  const sim = new Sim(buildWorld(PROJECTS));
  sim.upsert(view({ id: 's1', activity: '' }), 0, { place: true });
  sim.upsert(view({ id: 's1', activity: 'Read a.ts' }), 10);
  assert.equal(get(sim, 's1')!.bubble?.text, 'Read a.ts');
  sim.upsert(view({ id: 's1', activity: 'Read b.ts' }), 11);
  assert.equal(get(sim, 's1')!.bubble?.text, 'Read a.ts', 'no second bubble within 4 s');
  sim.upsert(view({ id: 's1', activity: 'Read b.ts' }), 12); // same activity again: no change
  sim.upsert(view({ id: 's1', activity: 'Edit c.ts' }), 14.5);
  assert.equal(get(sim, 's1')!.bubble?.text, 'Edit c.ts', 'bubbles again after 4 s');
  assert.equal(get(sim, 's1')!.view.activity, 'Edit c.ts', 'view updated');
});

test('expired bubbles are cleared on step', () => {
  const sim = new Sim(buildWorld(PROJECTS));
  sim.upsert(view({ id: 's1' }), 0, { place: true });
  sim.upsert(view({ id: 's1', activity: 'Read a.ts' }), 1);
  run(sim, 1, 6);
  assert.equal(get(sim, 's1')!.bubble, undefined);
});

test('an agent idle for over 2 minutes takes a break-room trip and comes back; at most one per 5 min', () => {
  const w = buildWorld(PROJECTS);
  const sim = new Sim(w, { rand: () => 0.5 });
  sim.upsert(view({ id: 's1', status: 'idle' }), 0, { place: true });
  const home = { x: get(sim, 's1')!.x, y: get(sim, 's1')!.y };
  let trips = 0, inBreak = false;
  const each = () => {
    const a = get(sim, 's1')!;
    const now = w.grid[Math.floor(a.y)]?.[Math.floor(a.x)]?.room === 'break';
    if (now && !inBreak) trips++;
    inBreak = now;
  };
  let t = run(sim, 0, 110, each);
  assert.equal(trips, 0, 'no trip before 2 min idle');
  t = run(sim, t, 300, each); // through t = 410 s
  assert.equal(trips, 1, 'exactly one trip in the first ~5 min');
  const a = get(sim, 's1')!;
  assert.equal(a.anim, 'seated', 'back at the desk');
  assert.ok(Math.hypot(a.x - home.x, a.y - home.y) < 0.01);
});

test('ambient trips are off when ambient is disabled (reduced motion)', () => {
  const w = buildWorld(PROJECTS);
  const sim = new Sim(w, { ambient: false });
  sim.upsert(view({ id: 's1', status: 'idle' }), 0, { place: true });
  let moved = false;
  run(sim, 0, 400, () => { if (get(sim, 's1')!.anim !== 'seated') moved = true; });
  assert.equal(moved, false);
});

test('an agent on a break goes back to its desk when work arrives', () => {
  const w = buildWorld(PROJECTS);
  const sim = new Sim(w, { rand: () => 0.5 });
  sim.upsert(view({ id: 's1', status: 'idle' }), 0, { place: true });
  let t = 0;
  for (let i = 0; i < 400 && w.grid[Math.floor(get(sim, 's1')!.y)][Math.floor(get(sim, 's1')!.x)].room !== 'break'; i++) t = run(sim, t, 1);
  assert.equal(w.grid[Math.floor(get(sim, 's1')!.y)][Math.floor(get(sim, 's1')!.x)].room, 'break', 'went on a break');
  sim.upsert(view({ id: 's1', status: 'working', activity: 'Bash ls' }), t);
  run(sim, t, 40);
  assert.equal(get(sim, 's1')!.anim, 'seated');
});

test('setWorld keeps desks stable when a project is added, and re-seats agents of an archived project', () => {
  const sim = new Sim(buildWorld(PROJECTS));
  sim.upsert(view({ id: 'a1', projectId: A }), 0, { place: true });
  sim.upsert(view({ id: 'b1', projectId: B }), 0, { place: true });
  const before = { ...get(sim, 'a1')!.desk! };
  const w2 = buildWorld([...PROJECTS, { id: '/c', name: 'c', wing: 2 }]);
  sim.setWorld(w2);
  const d = get(sim, 'a1')!.desk!;
  assert.ok(w2.furn.includes(d), 'desk belongs to the new world');
  assert.deepEqual({ x: d.x, y: d.y, room: d.room }, { x: before.x, y: before.y, room: before.room });
  assert.equal(get(sim, 'a1')!.anim, 'seated');
  // Archive beta: its agent has no wing any more and stands in the hall.
  const w3 = buildWorld([PROJECTS[0], { ...PROJECTS[1], archived: true }]);
  sim.setWorld(w3);
  run(sim, 0, 60);
  const b = get(sim, 'b1')!;
  assert.equal(b.desk, undefined);
  assert.equal(w3.grid[Math.floor(b.y)][Math.floor(b.x)].room, 'hall');
});

test('appearance is deterministic from the agent id', () => {
  const s1 = new Sim(buildWorld(PROJECTS)), s2 = new Sim(buildWorld(PROJECTS));
  for (const s of [s1, s2]) s.upsert(view({ id: 'abc-123' }), 0);
  assert.equal(get(s1, 'abc-123')!.skin, get(s2, 'abc-123')!.skin);
  assert.equal(get(s1, 'abc-123')!.hair, get(s2, 'abc-123')!.hair);
});
