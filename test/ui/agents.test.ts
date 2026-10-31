import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFloor, seatOf, assignDesk, type World } from '../../src/ui/sim/world.ts';
import { Sim } from '../../src/ui/sim/agents.ts';
import type { AgentView } from '../../src/shared/protocol.ts';
import { defaultFloor, DEFAULT_DIVISIONS, BULLPEN, type FloorDef } from '../../src/shared/building.ts';

const DIVS = DEFAULT_DIVISIONS.map((d) => ({ ...d, revision: 1 }));
const floor = () => buildFloor(defaultFloor(), DIVS);

function view(o: Partial<AgentView> & { id: string }): AgentView {
  return {
    sessionId: o.id.split(':')[0], kind: 'session', name: o.id, role: 'general', projectId: '/p', status: 'working',
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
const roomAt = (w: World, a: { x: number; y: number }) => w.grid[Math.floor(a.y)][Math.floor(a.x)].room;

test('a new agent starts at the elevator and walks to a desk in its division\'s room', () => {
  const w = floor();
  const sim = new Sim(w);
  sim.upsert(view({ id: 's1', division: 'qa' }), 0);
  const a = get(sim, 's1')!;
  assert.ok(Math.hypot(a.x - (w.elevator.x + 0.5), a.y - (w.elevator.y - 0.5)) < 0.01, `starts at elevator, got ${a.x},${a.y}`);
  assert.equal(a.anim, 'walking');
  run(sim, 0, 60);
  const b = get(sim, 's1')!;
  const desk = assignDesk(w, 'qa', new Set())!;
  assert.equal(b.anim, 'seated');
  assert.equal(b.desk, desk);
  const s = seatOf(desk);
  assert.ok(Math.hypot(b.x - s.x, b.y - s.y) < 0.01, 'sits at the seat');
  assert.equal(b.dir, 'up');
  assert.equal(sim.roomOf(b), 'qa');
});

test('placed agents (snapshot) appear at their desk at once', () => {
  const sim = new Sim(floor());
  sim.upsert(view({ id: 's1', division: 'backend' }), 0, { place: true });
  const a = get(sim, 's1')!;
  assert.equal(a.anim, 'seated');
  assert.equal(a.desk?.room, 'backend');
});

test('placement: label beats room beats division; no or unknown hints go to the Bullpen', () => {
  const sim = new Sim(floor());
  const cases: [Partial<AgentView>, string][] = [
    [{}, BULLPEN],
    [{ division: 'nope' }, BULLPEN],
    [{ room: 'gone', division: 'nope' }, BULLPEN],
    [{ division: 'security' }, 'security'],
    [{ room: 'uxui', division: 'security' }, 'uxui'],
    [{ roomLabel: 'animation', room: 'uxui', division: 'security' }, 'animation'],
    [{ roomLabel: 'removed-room', division: 'imagegen' }, 'imagegen'],
  ];
  cases.forEach(([hints, want], i) => {
    sim.upsert(view({ id: `c${i}`, ...hints }), 0, { place: true });
    const a = get(sim, `c${i}`)!;
    assert.equal(sim.roomOf(a), want, JSON.stringify(hints));
    assert.equal(a.desk?.room, want, `${JSON.stringify(hints)} seated in ${want}`);
  });
});

test('a subagent stands next to its parent, in the parent\'s room, whatever its own hints', () => {
  const w = floor();
  const sim = new Sim(w);
  sim.upsert(view({ id: 'p', division: 'frontend' }), 0);
  sim.upsert(view({ id: 'p:x', kind: 'subagent', parentId: 'p', role: 'Explore' }), 0);
  sim.upsert(view({ id: 'p:y', kind: 'subagent', parentId: 'p', role: 'Plan', division: 'qa' }), 0);
  run(sim, 0, 60);
  const p = get(sim, 'p')!;
  for (const id of ['p:x', 'p:y']) {
    const s = get(sim, id)!;
    assert.equal(s.desk, undefined, `${id} takes no desk`);
    assert.equal(s.anim, 'standing');
    assert.equal(sim.roomOf(s), 'frontend');
    assert.equal(roomAt(w, s), 'frontend', `${id} stands in the parent's room`);
    assert.ok(Math.hypot(s.x - p.x, s.y - p.y) < 2.5, `near parent (${s.x},${s.y} vs ${p.x},${p.y})`);
  }
  assert.ok(Math.hypot(get(sim, 'p:x')!.x - get(sim, 'p:y')!.x, get(sim, 'p:x')!.y - get(sim, 'p:y')!.y) > 0.9, 'not on top of each other');
});

test('a subagent follows its parent when the parent is moved to another room', () => {
  const w = floor();
  const sim = new Sim(w);
  sim.upsert(view({ id: 'p', division: 'qa' }), 0, { place: true });
  sim.upsert(view({ id: 'p:x', kind: 'subagent', parentId: 'p' }), 0, { place: true });
  assert.equal(roomAt(w, get(sim, 'p:x')!), 'qa');
  sim.upsert(view({ id: 'p', division: 'qa', roomLabel: 'imagegen' }), 1);
  const t = run(sim, 1, 60);
  assert.equal(get(sim, 'p')!.desk?.room, 'imagegen');
  assert.equal(roomAt(w, get(sim, 'p:x')!), 'imagegen', 'subagent followed');
  assert.equal(get(sim, 'p:x')!.anim, 'standing');
  assert.ok(t > 0);
});

test('remove(ended) walks to the elevator, then disappears', () => {
  const w = floor();
  const sim = new Sim(w);
  sim.upsert(view({ id: 's1', division: 'imagegen' }), 0, { place: true });
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
  const sim = new Sim(floor());
  sim.upsert(view({ id: 's1' }), 0, { place: true });
  sim.remove('s1', 'expired', 0);
  assert.equal(get(sim, 's1'), undefined);
  assert.equal(sim.agents().length, 0);
});

test('agents beyond a room\'s desks stand in that room, not on top of anyone', () => {
  const w = floor();
  const sim = new Sim(w);
  for (let i = 0; i < 7; i++) sim.upsert(view({ id: `s${i}`, division: 'qa' }), 0);
  run(sim, 0, 90);
  const all = sim.agents();
  assert.equal(all.filter((a) => a.desk).length, 4, 'qa has 4 desks');
  assert.equal(new Set(all.map((a) => a.desk).filter(Boolean)).size, 4, 'desks are unique');
  for (const id of ['s4', 's5', 's6']) {
    const o = get(sim, id)!;
    assert.equal(o.desk, undefined);
    assert.equal(o.anim, 'standing');
    assert.ok(inRoom(w, 'qa', o.x, o.y), `${id} stands inside qa (${o.x},${o.y})`);
    for (const p of all) if (p !== o) assert.ok(Math.hypot(p.x - o.x, p.y - o.y) > 0.9, 'not on top of anyone');
  }
});

test('a freed desk goes to the next agent, and to someone standing in that room', () => {
  const sim = new Sim(floor());
  for (let i = 0; i < 5; i++) sim.upsert(view({ id: `s${i}`, division: 'qa' }), 0, { place: true });
  assert.equal(get(sim, 's4')!.desk, undefined);
  const d0 = get(sim, 's0')!.desk;
  sim.remove('s0', 'expired', 0);
  assert.equal(get(sim, 's4')!.desk, d0, 'the standing agent got the freed desk');
  const d1 = get(sim, 's1')!.desk;
  sim.remove('s1', 'expired', 0);
  sim.upsert(view({ id: 'new', division: 'qa' }), 0);
  assert.equal(get(sim, 'new')!.desk, d1);
});

test('a floor without a Bullpen: unplaceable agents stand in the hall near the elevator', () => {
  const f: FloorDef = { revision: 1, source: 'home', rooms: [{ id: 'qa', name: 'QA', division: 'qa', band: 'top', width: 10 }] };
  const w = buildFloor(f, DIVS);
  const sim = new Sim(w);
  sim.upsert(view({ id: 'u1' }), 0);
  sim.upsert(view({ id: 'u2' }), 0);
  run(sim, 0, 30);
  const u1 = get(sim, 'u1')!, u2 = get(sim, 'u2')!;
  for (const u of [u1, u2]) {
    assert.equal(u.desk, undefined);
    assert.equal(u.anim, 'standing');
    assert.equal(roomAt(w, u), 'hall');
    assert.ok(Math.hypot(u.x - w.elevator.x, u.y - w.elevator.y) < 10, 'near the elevator');
  }
  assert.ok(Math.hypot(u1.x - u2.x, u1.y - u2.y) > 0.9, 'different spots');
  // Once it hints a room that exists, it walks to a desk there.
  sim.upsert(view({ id: 'u1', division: 'qa' }), 31);
  run(sim, 31, 60);
  assert.equal(get(sim, 'u1')!.desk?.room, 'qa');
  assert.equal(get(sim, 'u1')!.anim, 'seated');
});

test('activity bubbles are rate-limited to one per 4 s per agent', () => {
  const sim = new Sim(floor());
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
  const sim = new Sim(floor());
  sim.upsert(view({ id: 's1' }), 0, { place: true });
  sim.upsert(view({ id: 's1', activity: 'Read a.ts' }), 1);
  run(sim, 1, 6);
  assert.equal(get(sim, 's1')!.bubble, undefined);
});

const atBreakSpot = (w: World, a: { x: number; y: number }) => w.breakSpots.some(([x, y]) => x === Math.floor(a.x) && y === Math.floor(a.y));

test('an agent idle for over 2 minutes takes a trip to the Bullpen couch and comes back; at most one per 5 min', () => {
  const w = floor();
  const sim = new Sim(w, { rand: () => 0.5 });
  sim.upsert(view({ id: 's1', status: 'idle', division: 'security' }), 0, { place: true });
  const home = { x: get(sim, 's1')!.x, y: get(sim, 's1')!.y };
  let trips = 0, inBreak = false;
  const each = () => {
    const now = atBreakSpot(w, get(sim, 's1')!);
    if (now && !inBreak) { trips++; assert.equal(roomAt(w, get(sim, 's1')!), BULLPEN); }
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
  const sim = new Sim(floor(), { ambient: false });
  sim.upsert(view({ id: 's1', status: 'idle' }), 0, { place: true });
  let moved = false;
  run(sim, 0, 400, () => { if (get(sim, 's1')!.anim !== 'seated') moved = true; });
  assert.equal(moved, false);
});

test('an agent on a break goes back to its desk when work arrives', () => {
  const w = floor();
  const sim = new Sim(w, { rand: () => 0.5 });
  sim.upsert(view({ id: 's1', status: 'idle', division: 'qa' }), 0, { place: true });
  let t = 0;
  for (let i = 0; i < 400 && !atBreakSpot(w, get(sim, 's1')!); i++) t = run(sim, t, 1);
  assert.ok(atBreakSpot(w, get(sim, 's1')!), 'went on a break');
  sim.upsert(view({ id: 's1', status: 'working', activity: 'Bash ls', division: 'qa' }), t);
  run(sim, t, 40);
  assert.equal(get(sim, 's1')!.anim, 'seated');
  assert.equal(get(sim, 's1')!.desk?.room, 'qa');
});

test('setWorld keeps desks stable when a room is added, and sends agents of a removed room to the Bullpen', () => {
  const sim = new Sim(floor());
  sim.upsert(view({ id: 'a1', division: 'qa' }), 0, { place: true });
  sim.upsert(view({ id: 'b1', division: 'imagegen' }), 0, { place: true });
  const before = { ...get(sim, 'a1')!.desk! };
  const f2 = defaultFloor();
  f2.rooms.push({ id: 'ops', name: 'Ops', band: 'top', width: 10 });
  const w2 = buildFloor(f2, DIVS);
  sim.setWorld(w2);
  const d = get(sim, 'a1')!.desk!;
  assert.ok(w2.furn.includes(d), 'desk belongs to the new world');
  assert.deepEqual({ x: d.x, y: d.y, room: d.room }, { x: before.x, y: before.y, room: before.room });
  assert.equal(get(sim, 'a1')!.anim, 'seated');
  // Remove imagegen: its agent goes to the Bullpen (Review Focus 4), nothing throws.
  const f3 = defaultFloor();
  f3.rooms = f3.rooms.filter((r) => r.id !== 'imagegen');
  const w3 = buildFloor(f3, DIVS);
  sim.setWorld(w3);
  run(sim, 0, 60);
  const b = get(sim, 'b1')!;
  assert.equal(b.desk?.room, BULLPEN);
  assert.equal(sim.roomOf(b), BULLPEN);
  assert.equal(b.anim, 'seated');
});

test('appearance is deterministic from the agent id', () => {
  const s1 = new Sim(floor()), s2 = new Sim(floor());
  for (const s of [s1, s2]) s.upsert(view({ id: 'abc-123' }), 0);
  assert.equal(get(s1, 'abc-123')!.skin, get(s2, 'abc-123')!.skin);
  assert.equal(get(s1, 'abc-123')!.hair, get(s2, 'abc-123')!.hair);
});

test('a subagent that arrives before its parent joins the parent once it appears', () => {
  const w = floor();
  const sim = new Sim(w);
  sim.upsert(view({ id: 'p:x', kind: 'subagent', parentId: 'p' }), 0, { place: true });
  assert.equal(roomAt(w, get(sim, 'p:x')!), BULLPEN, 'no parent yet: Bullpen');
  sim.upsert(view({ id: 'p', division: 'backend' }), 1, { place: true });
  run(sim, 1, 60);
  assert.equal(roomAt(w, get(sim, 'p:x')!), 'backend');
  const p = get(sim, 'p')!, s = get(sim, 'p:x')!;
  assert.ok(Math.hypot(s.x - p.x, s.y - p.y) < 2.5);
});
