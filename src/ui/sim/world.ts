// One office floor laid out from a FloorDef: two bands of division rooms (plus the Bullpen) on
// either side of a 4-row hall, the elevator at the hall's left end. Pure data; no DOM, no Node imports.
import { BULLPEN, type DivisionDef, type FloorDef, type RoomDef } from '../../shared/building.ts';

export interface Room { id: string; name: string; kind: 'division' | 'bullpen'; division?: string; color?: string; x0: number; y0: number; x1: number; y1: number; doors: [number, number][] }
export interface Furn { type: 'desk' | 'bigdesk' | 'table' | 'roundtable' | 'plant' | 'couch' | 'coffee' | 'fridge' | 'arcade' | 'shelf' | 'board'; x: number; y: number; w: number; h: number; room: string; decor?: boolean }
export interface Cell { wall: boolean; room: string | null; block: boolean; door?: boolean }
export interface World { cols: number; rows: number; grid: Cell[][]; rooms: Room[]; furn: Furn[]; elevator: { x: number; y: number }; breakSpots: [number, number][] }

export { bfs, seatOf, assignDesk } from './path.ts';

// Rows: 0 outer wall, 1 wall, 2–10 top band, 11 wall (top doors), 12–15 hall, 16 wall (bottom doors), 17–25 bottom band, 26 outer wall.
export const ROWS = 27;
const TOP_Y0 = 2, TOP_Y1 = 10, TOP_DOOR_Y = 11;
const HALL_Y0 = 12, HALL_Y1 = 15;
const BOT_Y0 = 17, BOT_Y1 = 25, BOT_DOOR_Y = 16;
/** x of the first room's left wall; columns 1..FIRST_WALL_X-1 of the hall are the elevator bay. */
const FIRST_WALL_X = 2;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/**
 * Rows (dy from the room's top) per band. Top-band rooms open downward, so their far side is dy 0;
 * bottom-band rooms open upward and their far side is dy 8. Desks sit on `desks`, chairs one row below.
 */
const BAND = {
  top: { desks: [3, 6], far: 0, near: 1, stand: [5, 2, 1, 8] },
  bottom: { desks: [1, 4], far: 8, near: 7, stand: [6, 3, 7, 0] },
} as const;

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

const bandOf = (r: Room): 'top' | 'bottom' => (r.y0 === TOP_Y0 ? 'top' : 'bottom');

/**
 * Standing spots inside a room in order of preference (rows clear of desks, chairs and doorways),
 * filtered to free floor. Callers drop the ones already taken.
 */
export function standSpots(w: World, roomId: string): [number, number][] {
  const r = w.rooms.find((q) => q.id === roomId);
  if (!r) return [];
  const out: [number, number][] = [];
  for (const dy of BAND[bandOf(r)].stand) for (let x = r.x0 + 1; x < r.x1; x++) {
    const y = r.y0 + dy, c = w.grid[y][x];
    if (!c.wall && !c.block && c.room === r.id) out.push([x, y]);
  }
  return out;
}

/** Width 8–24 (12 if not a number) and a known band, so a malformed def can't break the layout. */
function normalize(r: RoomDef): RoomDef {
  const w = Number.isFinite(r.width) ? Math.round(r.width) : 12;
  return { ...r, band: r.band === 'top' ? 'top' : 'bottom', width: Math.min(24, Math.max(8, w)) };
}

export function buildFloor(floor: FloorDef, divisions: Pick<DivisionDef, 'id' | 'color'>[]): World {
  const defs = floor.rooms.map(normalize);
  const bandWidth = (b: 'top' | 'bottom') => {
    const rs = defs.filter((r) => r.band === b);
    return rs.reduce((s, r) => s + r.width, 0) + rs.length + 1;
  };
  const cols = 2 + Math.max(bandWidth('top'), bandWidth('bottom'));
  const grid: Cell[][] = Array.from({ length: ROWS }, () => Array.from({ length: cols }, () => ({ wall: true, room: null, block: false })));
  const rooms: Room[] = [];
  const furn: Furn[] = [];
  const breakSpots: [number, number][] = [];

  const carve = (x0: number, y0: number, x1: number, y1: number, room: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { grid[y][x].wall = false; grid[y][x].room = room; }
  };
  const add = (type: Furn['type'], x: number, y: number, w: number, h: number, room: string, decor?: boolean) => {
    furn.push(decor ? { type, x, y, w, h, room, decor: true } : { type, x, y, w, h, room });
    if (!decor) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) grid[yy][xx].block = true;
  };

  carve(1, HALL_Y0, cols - 2, HALL_Y1, 'hall');
  const elevator = { x: 1, y: BOT_DOOR_Y }; // in the hall's bottom wall at its left end, opening up onto the hall

  const next = { top: FIRST_WALL_X + 1, bottom: FIRST_WALL_X + 1 };
  // Room order in the World follows the FloorDef; layout order within a band does too.
  for (const def of defs) {
    const band = def.band;
    const x0 = next[band], x1 = x0 + def.width - 1;
    next[band] = x1 + 2;
    const y0 = band === 'top' ? TOP_Y0 : BOT_Y0, y1 = band === 'top' ? TOP_Y1 : BOT_Y1;
    const doorY = band === 'top' ? TOP_DOOR_Y : BOT_DOOR_Y;
    const dc = x0 + Math.floor((def.width - 2) / 2);
    const r = roomOf(def, divisions, x0, y0, x1, y1, [[dc, doorY], [dc + 1, doorY]]);
    rooms.push(r);
    carve(x0, y0, x1, y1, r.id);
    for (const [x, y] of r.doors) { carve(x, y, x, y, 'hall'); grid[y][x].door = true; }
    furnish(r, band, def.width, add, breakSpots);
  }
  return { cols, rows: ROWS, grid, rooms, furn, elevator, breakSpots };
}

function roomOf(def: RoomDef, divisions: Pick<DivisionDef, 'id' | 'color'>[], x0: number, y0: number, x1: number, y1: number, doors: [number, number][]): Room {
  const base = { id: def.id, name: def.name, x0, y0, x1, y1, doors };
  if (def.id === BULLPEN) return { ...base, kind: 'bullpen' };
  const color = divisions.find((d) => d.id === def.division)?.color;
  const r: Room = { ...base, kind: 'division' };
  if (def.division) r.division = def.division;
  if (color && COLOR_RE.test(color)) r.color = color.toLowerCase();
  return r;
}

type Add = (type: Furn['type'], x: number, y: number, w: number, h: number, room: string, decor?: boolean) => void;

function furnish(r: Room, band: 'top' | 'bottom', width: number, add: Add, breakSpots: [number, number][]): void {
  const B = BAND[band];
  // Desks: two rows of floor((w-2)/4), 2 tiles wide on a 4-tile pitch, centered.
  const k = Math.floor((width - 2) / 4);
  const off = 1 + Math.floor((width - 2 - (4 * k - 2)) / 2);
  for (const dy of B.desks) for (let i = 0; i < k; i++) add('desk', r.x0 + off + 4 * i, r.y0 + dy, 2, 1, r.id);
  const farY = r.y0 + B.far, nearY = r.y0 + B.near;
  add('plant', r.x0, farY, 1, 1, r.id);
  add('plant', r.x1, farY, 1, 1, r.id);
  if (r.kind === 'bullpen') {
    // Lounge along the far wall: couch and coffee, with ambient spots in front of them.
    const cw = width >= 10 ? 4 : 3, cx = r.x0 + (width >= 10 ? 2 : 1);
    add('couch', cx, farY, cw, 1, r.id);
    const coffeeX = r.x1 - 2;
    add('coffee', coffeeX, farY, 1, 1, r.id);
    for (let x = cx; x < cx + cw; x++) breakSpots.push([x, nearY]);
    breakSpots.push([coffeeX, nearY], [coffeeX - 1, nearY]);
    if (width >= 12) add('plant', cx + cw + 1, farY, 1, 1, r.id);
  } else if (band === 'top') {
    add('board', r.x0 + 2, r.y0 - 1, Math.min(4, width - 4), 1, r.id, true);
  }
}
