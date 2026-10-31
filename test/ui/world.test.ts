import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFloor, isWall, wallNear, standSpots, ROWS, type World } from '../../src/ui/sim/world.ts';
import { bfs, seatOf, assignDesk } from '../../src/ui/sim/path.ts';
import { defaultFloor, DEFAULT_DIVISIONS, BULLPEN, type FloorDef, type RoomDef } from '../../src/shared/building.ts';
import { MIN_TILE } from '../../src/ui/render/types.ts';

const walk = (w: World, x: number, y: number) =>
  x >= 0 && y >= 0 && x < w.cols && y < w.rows && !w.grid[y][x].wall && !w.grid[y][x].block;

const DIVS = DEFAULT_DIVISIONS.map((d) => ({ ...d, revision: 1 }));
const room = (id: string, band: 'top' | 'bottom', width: number, division?: string): RoomDef =>
  division ? { id, name: id.toUpperCase(), division, band, width } : { id, name: id.toUpperCase(), band, width };

/** Widths 8 and 24, six rooms in the top band, an unknown division. */
function custom(): FloorDef {
  return {
    revision: 1, source: 'home',
    rooms: [
      room('a', 'top', 8, 'qa'), room('b', 'top', 24, 'security'), room('c', 'top', 9, 'uxui'),
      room('d', 'top', 13, 'frontend'), room('e', 'top', 8, 'mystery'), room('f', 'top', 24, 'backend'),
      { id: BULLPEN, name: 'Bullpen', band: 'bottom', width: 8 },
      room('g', 'bottom', 24, 'animation'),
    ],
  };
}

function checkFloor(f: FloorDef, w: World): void {
  assert.equal(w.grid.length, w.rows);
  assert.ok(w.grid.every((r) => r.length === w.cols));
  // fully enclosed
  for (let x = 0; x < w.cols; x++) assert.ok(w.grid[0][x].wall && w.grid[w.rows - 1][x].wall, `edge col ${x}`);
  for (let y = 0; y < w.rows; y++) assert.ok(w.grid[y][0].wall && w.grid[y][w.cols - 1].wall, `edge row ${y}`);
  assert.equal(w.rooms.length, f.rooms.length);
  assert.deepEqual(w.rooms.map((r) => r.id), f.rooms.map((r) => r.id), 'rooms in floor order');
  const ex = w.elevator;
  for (const r of w.rooms) {
    const def = f.rooms.find((d) => d.id === r.id)!;
    assert.equal(r.name, def.name);
    assert.equal(r.x1 - r.x0 + 1, def.width, `${r.id} width`);
    assert.equal(r.y1 - r.y0 + 1, 9, `${r.id} interior height 9`);
    if (def.band === 'top') assert.deepEqual([r.y0, r.y1], [2, 10]); else assert.deepEqual([r.y0, r.y1], [17, 25]);
    assert.equal(r.doors.length, 2, 'doors are 2 tiles wide');
    for (const [dx, dy] of r.doors) {
      assert.equal(dy, def.band === 'top' ? 11 : 16, 'door faces the hall');
      assert.ok(w.grid[dy][dx].door);
      assert.ok(bfs(w, ex.x, ex.y, dx, dy), `door ${r.id} reachable from the elevator`);
    }
    const mid = (r.x0 + r.x1) / 2;
    assert.ok(Math.abs((r.doors[0][0] + r.doors[1][0]) / 2 - mid) <= 0.5, `${r.id} door centered`);
    // every interior tile belongs to the room
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) assert.equal(w.grid[y][x].room, r.id);
    const desks = w.furn.filter((q) => q.room === r.id && q.type === 'desk');
    assert.equal(desks.length, 2 * Math.floor((def.width - 2) / 4), `${r.id} desk count`);
    assert.equal(new Set(desks.map((d) => d.y)).size, 2, 'two desk rows');
    for (const d of desks) {
      const s = seatOf(d);
      assert.ok(walk(w, Math.floor(s.x), Math.floor(s.y)) && walk(w, Math.floor(s.x - 0.001), Math.floor(s.y)), 'seat walkable');
      assert.equal(w.grid[Math.floor(s.y)][Math.floor(s.x)].room, r.id, 'seat inside its room');
      assert.ok(bfs(w, ex.x, ex.y, Math.floor(s.x), Math.floor(s.y)), `seat in ${r.id} reachable`);
    }
    const spots = standSpots(w, r.id);
    assert.ok(spots.length >= 4, `${r.id} has standing spots`);
    for (const [x, y] of spots) {
      assert.equal(w.grid[y][x].room, r.id);
      assert.ok(walk(w, x, y) && bfs(w, ex.x, ex.y, x, y), 'stand spot reachable');
    }
  }
  // one wall column between neighbouring rooms in a band
  for (const band of ['top', 'bottom'] as const) {
    const rs = w.rooms.filter((r) => f.rooms.find((d) => d.id === r.id)!.band === band);
    for (let i = 1; i < rs.length; i++) {
      assert.equal(rs[i].x0, rs[i - 1].x1 + 2, `one wall between ${rs[i - 1].id} and ${rs[i].id}`);
      for (let y = rs[i].y0; y <= rs[i].y1; y++) assert.ok(w.grid[y][rs[i].x0 - 1].wall);
    }
  }
  // hall rows 12–15, elevator at its left end
  for (let y = 12; y <= 15; y++) for (let x = 1; x < w.cols - 1; x++) assert.equal(w.grid[y][x].room, 'hall', `hall ${x},${y}`);
  assert.ok(ex.x <= 2, 'elevator at the hall\'s left end');
  assert.equal(w.grid[ex.y - 1][ex.x].room, 'hall', 'elevator opens onto the hall');
  const bands = ['top', 'bottom'].map((b) => f.rooms.filter((r) => r.band === b));
  assert.equal(w.cols, 2 + Math.max(...bands.map((rs) => rs.reduce((s, r) => s + r.width, 0) + rs.length + 1)), 'cols formula');
  assert.equal(w.rows, ROWS);
  for (const fu of w.furn) {
    if (fu.decor) continue;
    for (let y = fu.y; y < fu.y + fu.h; y++) for (let x = fu.x; x < fu.x + fu.w; x++) {
      assert.ok(!w.grid[y][x].wall, `${fu.type} on wall at ${x},${y}`);
      assert.equal(w.grid[y][x].room, fu.room, `${fu.type} inside its room`);
    }
  }
  // the Bullpen has the lounge; ambient spots are there and reachable
  const bp = w.rooms.find((r) => r.id === BULLPEN)!;
  assert.equal(bp.kind, 'bullpen');
  for (const t of ['couch', 'coffee', 'plant'] as const) assert.ok(w.furn.some((q) => q.room === BULLPEN && q.type === t), `bullpen ${t}`);
  assert.ok(w.breakSpots.length >= 4);
  for (const [x, y] of w.breakSpots) {
    assert.equal(w.grid[y][x].room, BULLPEN, 'break spot in the Bullpen');
    assert.ok(bfs(w, ex.x, ex.y, x, y), 'break spot reachable');
  }
}

test('default floor: 8 rooms, enclosed, doors and seats reachable, desk counts, Bullpen lounge', () => {
  const f = defaultFloor();
  const w = buildFloor(f, DIVS);
  assert.equal(w.rooms.length, 8);
  checkFloor(f, w);
  const qa = w.rooms.find((r) => r.id === 'qa')!;
  assert.deepEqual({ kind: qa.kind, division: qa.division, color: qa.color, name: qa.name }, { kind: 'division', division: 'qa', color: '#62c4a0', name: 'QA' });
  assert.equal(w.rooms.find((r) => r.id === BULLPEN)!.color, undefined);
  assert.equal(w.rooms.filter((r) => r.kind === 'division').length, 7);
  assert.equal(w.cols, 57);
  assert.ok(w.cols * MIN_TILE <= 1100, `default floor fits 1400 px (${w.cols * MIN_TILE})`);
});

test('widths 8 and 24, six rooms in one band, unknown division: builds and passes the same checks', () => {
  const f = custom();
  const w = buildFloor(f, DIVS);
  checkFloor(f, w);
  const e = w.rooms.find((r) => r.id === 'e')!;
  assert.equal(e.color, undefined, 'unknown division has no color');
  assert.equal(e.kind, 'division');
  assert.equal(e.division, 'mystery');
});

test('a room with no division, and no divisions at all: no color, no throw', () => {
  const f: FloorDef = { revision: 1, source: 'home', rooms: [room('x', 'top', 10), { id: BULLPEN, name: 'Bullpen', band: 'top', width: 14 }] };
  const w = buildFloor(f, []);
  checkFloor(f, w);
  assert.equal(w.rooms[0].color, undefined);
  const w2 = buildFloor(defaultFloor(), []);
  assert.ok(w2.rooms.every((r) => r.color === undefined));
});

test('a floor without a Bullpen still builds (ambient spots empty)', () => {
  const w = buildFloor({ revision: 1, source: 'home', rooms: [room('x', 'top', 10, 'qa')] }, DIVS);
  assert.equal(w.rooms.length, 1);
  assert.deepEqual(w.breakSpots, []);
});

test('assignDesk: distinct desks, stable order, null when full', () => {
  const w = buildFloor(defaultFloor(), DIVS);
  const taken = new Set<any>();
  const got: NonNullable<ReturnType<typeof assignDesk>>[] = [];
  for (let i = 0; i < 4; i++) {
    const d = assignDesk(w, 'qa', taken);
    assert.ok(d); assert.ok(!taken.has(d)); taken.add(d); got.push(d);
  }
  assert.equal(assignDesk(w, 'qa', taken), null);
  assert.equal(assignDesk(w, 'nope', new Set()), null);
  assert.ok(got[0].y === got[1].y && got[2].y > got[0].y);
  assert.ok(got[0].x < got[1].x);
});

test('deterministic', () => {
  assert.deepEqual(buildFloor(defaultFloor(), DIVS), buildFloor(defaultFloor(), DIVS));
  assert.deepEqual(buildFloor(custom(), DIVS), buildFloor(custom(), DIVS));
});

test('isWall / wallNear', () => {
  const w = buildFloor(defaultFloor(), DIVS);
  assert.equal(isWall(w, -1, 0), true);
  assert.equal(isWall(w, w.cols, 0), true);
  assert.equal(isWall(w, 0, 0), true);
  assert.equal(isWall(w, 5, 13), false);
  assert.equal(wallNear(w, 1, 13), true);
  assert.equal(wallNear(w, 5, 13), false);
});

test('bfs returns null for wall target', () => {
  const w = buildFloor(defaultFloor(), DIVS);
  assert.equal(bfs(w, 3, 13, 0, 0), null);
});

test('malformed room defs (width out of range or fractional, odd band) are clamped, never thrown on', () => {
  const rooms = [
    { id: 'a', name: 'A', band: 'top', width: 0 }, { id: 'b', name: 'B', band: 'top', width: 3.5 },
    { id: 'c', name: 'C', band: 'sideways', width: 99 }, { id: 'd', name: 'D', band: 'bottom', width: Number.NaN },
    { id: BULLPEN, name: 'Bullpen', band: 'bottom', width: 14 },
  ] as unknown as RoomDef[];
  const w = buildFloor({ revision: 1, source: 'home', rooms }, DIVS);
  assert.deepEqual(w.rooms.map((r) => r.x1 - r.x0 + 1), [8, 8, 24, 12, 14]);
  assert.equal(w.rooms[2].y0, 17, 'unknown band goes to the bottom band');
});
