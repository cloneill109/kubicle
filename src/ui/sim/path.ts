import type { World, Furn } from './world.ts';

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const walkable = (w: World, x: number, y: number) =>
  Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < w.cols && y < w.rows && !w.grid[y][x].wall && !w.grid[y][x].block;

/** 4-connected shortest path (excludes the start tile, includes the goal). Start may be any tile (e.g. the elevator). */
export function bfs(w: World, sx: number, sy: number, tx: number, ty: number): { x: number; y: number }[] | null {
  if (!walkable(w, tx, ty)) return null;
  if (sx < 0 || sy < 0 || sx >= w.cols || sy >= w.rows) return null;
  const prev = new Int32Array(w.cols * w.rows).fill(-1);
  const s = sy * w.cols + sx, goal = ty * w.cols + tx;
  const q = [s];
  prev[s] = s;
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    if (c === goal) break;
    const cx = c % w.cols, cy = (c / w.cols) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!walkable(w, nx, ny)) continue;
      const n = ny * w.cols + nx;
      if (prev[n] !== -1) continue;
      prev[n] = c;
      q.push(n);
    }
  }
  if (prev[goal] === -1) return null;
  const out: { x: number; y: number }[] = [];
  for (let c = goal; c !== s; c = prev[c]) out.push({ x: c % w.cols, y: (c / w.cols) | 0 });
  return out.reverse();
}

export function seatOf(d: Furn): { x: number; y: number } {
  return { x: d.x + d.w / 2, y: d.y + d.h + 0.45 };
}

/** First free desk in stable order (top row left to right, then bottom row), or null. */
export function assignDesk(w: World, roomId: string, taken: Set<Furn>): Furn | null {
  const desks = w.furn
    .filter((f) => f.room === roomId && (f.type === 'desk' || f.type === 'bigdesk'))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return desks.find((d) => !taken.has(d)) ?? null;
}
