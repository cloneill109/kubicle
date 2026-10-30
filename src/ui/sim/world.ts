// Office floor plan generated from the project list. Pure data; no DOM, no Node imports.
export interface Room { id: string; name: string; kind: 'wing' | 'coordinator' | 'break'; x0: number; y0: number; x1: number; y1: number; doors: [number, number][]; auto?: boolean }
export interface Furn { type: 'desk' | 'bigdesk' | 'table' | 'roundtable' | 'plant' | 'couch' | 'coffee' | 'fridge' | 'arcade' | 'shelf' | 'board'; x: number; y: number; w: number; h: number; room: string; decor?: boolean }
export interface Cell { wall: boolean; room: string | null; block: boolean; door?: boolean }
export interface World { cols: number; rows: number; grid: Cell[][]; rooms: Room[]; furn: Furn[]; elevator: { x: number; y: number }; breakSpots: [number, number][] }

export { bfs, seatOf, assignDesk } from './path.ts';

export const ROWS = 30;
const HALL_Y0 = 13, HALL_Y1 = 16;          // hall rows (4 tall)
const TOP_Y0 = 2, TOP_Y1 = 11, TOP_DOOR_Y = 12;
const BOT_Y0 = 18, BOT_Y1 = 27, BOT_DOOR_Y = 17;
const FIRST_WING_X = 20, WING_W = 14, WING_PITCH = 16;
const MIN_SLOTS = 2;

export function isWall(w: World, x: number, y: number): boolean {
  return x < 0 || y < 0 || x >= w.cols || y >= w.rows || w.grid[y][x].wall;
}

/** True if any wall tile lies in the 8-neighborhood (self excluded; out-of-bounds counts as wall). */
export function wallNear(w: World, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (dx === 0 && dy === 0) continue;
    if (isWall(w, x + dx, y + dy)) return true;
  }
  return false;
}

export function buildWorld(projects: { id: string; name: string; wing: number; archived?: boolean }[]): World {
  const live = projects.filter((p) => !p.archived).slice().sort((a, b) => a.wing - b.wing);
  const slots = Math.max(MIN_SLOTS, live.length);
  const columns = Math.ceil(slots / 2);
  const cols = FIRST_WING_X - 1 + WING_PITCH * columns;
  const grid: Cell[][] = Array.from({ length: ROWS }, () => Array.from({ length: cols }, () => ({ wall: true, room: null, block: false })));
  const rooms: Room[] = [];
  const furn: Furn[] = [];

  const carve = (x0: number, y0: number, x1: number, y1: number, room: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { grid[y][x].wall = false; grid[y][x].room = room; }
  };
  const add = (type: Furn['type'], x: number, y: number, w: number, h: number, room: string, decor?: boolean) => {
    const f: Furn = decor ? { type, x, y, w, h, room, decor: true } : { type, x, y, w, h, room };
    furn.push(f);
    if (!decor) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) grid[yy][xx].block = true;
    return f;
  };

  carve(1, HALL_Y0, cols - 2, HALL_Y1, 'hall');
  const elevX = 16;
  carve(15, BOT_DOOR_Y, 18, ROWS - 2, 'hall'); // elevator corridor
  const elevator = { x: elevX, y: ROWS - 1 };

  const room = (r: Room) => {
    rooms.push(r);
    carve(r.x0, r.y0, r.x1, r.y1, r.id);
    for (const [x, y] of r.doors) { carve(x, y, x, y, 'hall'); grid[y][x].door = true; }
  };

  // Coordinator (top-left)
  {
    const x0 = 2, y0 = TOP_Y0, x1 = 17, y1 = TOP_Y1;
    room({ id: 'coordinator', name: 'Coordinator', kind: 'coordinator', x0, y0, x1, y1, doors: [[x0 + 7, TOP_DOOR_Y], [x0 + 8, TOP_DOOR_Y]] });
    add('bigdesk', x0 + 6, y0 + 2, 4, 1, 'coordinator');
    add('table', x0 + 5, y0 + 6, 6, 2, 'coordinator');
    add('shelf', x0 + 11, y0, 3, 1, 'coordinator');
    for (const [x, y] of [[x0, y0], [x0, y1], [x1, y1]]) add('plant', x, y, 1, 1, 'coordinator');
  }

  // Break room (bottom-left)
  const breakSpots: [number, number][] = [];
  {
    const x0 = 2, y0 = BOT_Y0, x1 = 13, y1 = BOT_Y1;
    room({ id: 'break', name: 'Break room', kind: 'break', x0, y0, x1, y1, doors: [[x0 + 5, BOT_DOOR_Y], [x0 + 6, BOT_DOOR_Y]] });
    add('couch', x0 + 1, y0, 4, 1, 'break');
    add('arcade', x0 + 8, y0, 1, 1, 'break');
    add('fridge', x0 + 9, y0, 1, 1, 'break');
    add('coffee', x0 + 11, y0, 1, 1, 'break');
    add('roundtable', x0 + 5, y0 + 4, 2, 2, 'break');
    for (const [x, y] of [[x0, y1], [x1, y1]]) add('plant', x, y, 1, 1, 'break');
    for (const [dx, dy] of [[1, 1], [2, 1], [3, 1], [4, 1], [8, 1], [9, 1], [11, 1], [3, 3], [8, 3], [3, 6], [8, 6], [10, 4]]) breakSpots.push([x0 + dx, y0 + dy]);
  }

  // Wings
  live.forEach((p, i) => {
    const top = i % 2 === 0;
    const col = Math.floor(i / 2);
    const x0 = FIRST_WING_X + WING_PITCH * col, x1 = x0 + WING_W - 1;
    const y0 = top ? TOP_Y0 : BOT_Y0, y1 = top ? TOP_Y1 : BOT_Y1;
    const doorY = top ? TOP_DOOR_Y : BOT_DOOR_Y;
    room({ id: p.id, name: p.name, kind: 'wing', x0, y0, x1, y1, doors: [[x0 + 7, doorY], [x0 + 8, doorY]] });
    for (const dy of [1, 5]) for (const dx of [1, 4, 7, 10]) add('desk', x0 + dx, y0 + dy, 2, 1, p.id);
    for (const [x, y] of [[x0, y1], [x1, y1]]) add('plant', x, y, 1, 1, p.id);
    add('board', x0 + 3, y0 - 1, 4, 1, p.id, true);
  });

  return { cols, rows: ROWS, grid, rooms, furn, elevator, breakSpots };
}
