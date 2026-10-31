import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, isWall, wallNear } from '../../src/ui/sim/world.ts';
import { bfs, seatOf, assignDesk } from '../../src/ui/sim/path.ts';

const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `proj-${i}`, order: i + 1 }));
const walk = (w: ReturnType<typeof buildWorld>, x: number, y: number) =>
  x >= 0 && y >= 0 && x < w.cols && y < w.rows && !w.grid[y][x].wall && !w.grid[y][x].block;

for (const n of [0, 1, 3, 12]) {
  test(`${n} projects: builds, enclosed, doors reachable, seats walkable, furniture off walls`, () => {
    const w = buildWorld(mk(n));
    assert.equal(w.grid.length, w.rows);
    assert.ok(w.grid.every((r) => r.length === w.cols));
    // enclosed
    for (let x = 0; x < w.cols; x++) assert.ok(w.grid[0][x].wall && w.grid[w.rows - 1][x].wall);
    for (let y = 0; y < w.rows; y++) assert.ok(w.grid[y][0].wall && w.grid[y][w.cols - 1].wall);
    assert.equal(w.rooms.filter((r) => r.kind === 'wing').length, n);
    const ex = w.elevator;
    for (const r of w.rooms) {
      assert.ok(r.doors.length > 0);
      for (const [dx, dy] of r.doors) {
        assert.ok(bfs(w, ex.x, ex.y - 1, dx, dy), `door ${r.id} reachable`);
        assert.ok(bfs(w, ex.x, ex.y, dx, dy), `door ${r.id} reachable from elevator tile`);
      }
    }
    for (const [x, y] of w.breakSpots) assert.ok(bfs(w, ex.x, ex.y - 1, x, y), 'break spot reachable');
    for (const f of w.furn) {
      for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) {
        if (f.decor) continue;
        assert.ok(!w.grid[y][x].wall, `${f.type} on wall at ${x},${y}`);
      }
      if (f.type === 'desk' || f.type === 'bigdesk') {
        const s = seatOf(f);
        assert.ok(walk(w, Math.floor(s.x), Math.floor(s.y)));
        assert.ok(walk(w, Math.floor(s.x - 0.001), Math.floor(s.y)));
        for (const room of w.rooms) if (room.id === f.room)
          assert.ok(bfs(w, ex.x, ex.y - 1, Math.floor(s.x), Math.floor(s.y)), 'seat reachable');
      }
    }
  });
}

test('minimum two wing slots even when empty; cols grow with ceil(n/2)', () => {
  assert.equal(buildWorld([]).cols, buildWorld(mk(2)).cols);
  assert.equal(buildWorld(mk(3)).cols, buildWorld(mk(4)).cols);
  assert.ok(buildWorld(mk(5)).cols > buildWorld(mk(4)).cols);
});

test('archived skipped; sorted by wing with gaps; alternate above/below hall', () => {
  const w = buildWorld([
    { id: 'c', name: 'C', order: 9 },
    { id: 'a', name: 'A', order: 2 },
    { id: 'x', name: 'X', order: 1, archived: true },
    { id: 'b', name: 'B', order: 5 },
  ]);
  const wings = w.rooms.filter((r) => r.kind === 'wing');
  assert.deepEqual(wings.map((r) => r.id), ['a', 'b', 'c']);
  assert.ok(wings[0].y0 < wings[1].y0 && wings[2].y0 < wings[1].y0);
  assert.ok(wings[1].x0 === wings[0].x0 && wings[2].x0 > wings[0].x0);
  assert.equal(wings[0].name, 'A');
  assert.ok(w.rooms.some((r) => r.id === 'coordinator' && r.kind === 'coordinator'));
  assert.ok(w.rooms.some((r) => r.id === 'break' && r.kind === 'break'));
});

test('assignDesk: distinct desks, stable order, null after 8', () => {
  const w = buildWorld(mk(2));
  const taken = new Set<any>();
  const got: NonNullable<ReturnType<typeof assignDesk>>[] = [];
  for (let i = 0; i < 8; i++) {
    const d = assignDesk(w, 'p0', taken);
    assert.ok(d); assert.ok(!taken.has(d)); taken.add(d); got.push(d);
  }
  assert.equal(assignDesk(w, 'p0', taken), null);
  assert.equal(assignDesk(w, 'nope', new Set()), null);
  assert.ok(got.slice(0, 4).every((d) => d.y === got[0].y) && got[4].y > got[0].y);
  assert.deepEqual(got.slice(0, 4).map((d) => d.x), [...got.slice(0, 4).map((d) => d.x)].sort((a, b) => a - b));
  assert.equal(got.length, new Set(got).size);
});

test('deterministic', () => {
  assert.deepEqual(buildWorld(mk(5)), buildWorld(mk(5)));
});

test('isWall / wallNear', () => {
  const w = buildWorld(mk(1));
  assert.equal(isWall(w, -1, 0), true);
  assert.equal(isWall(w, w.cols, 0), true);
  assert.equal(isWall(w, 0, 0), true);
  assert.equal(isWall(w, 3, 14), false);
  assert.equal(wallNear(w, 1, 14), true);
  assert.equal(wallNear(w, 5, 14), false);
});

test('bfs returns null for wall target', () => {
  const w = buildWorld(mk(1));
  assert.equal(bfs(w, 3, 14, 0, 0), null);
});
