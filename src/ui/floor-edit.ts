// Pure floor edit operations on RoomDef[]: move, resize, add, remove. Each returns a new array and
// never mutates its input. Used by the office's edit mode and by the CLI, so no DOM and no Node imports.
import { BULLPEN, ID_RE, type RoomDef } from '../shared/building.ts';

export type Band = 'top' | 'bottom';
export const MIN_WIDTH = 8, MAX_WIDTH = 24, NEW_WIDTH = 12;
const MAX_ID = 32;

/** The rooms of one band, in layout order. */
export function bandRooms(rooms: readonly RoomDef[], band: Band): RoomDef[] {
  return rooms.filter((r) => r.band === band);
}

/**
 * Moves room `id` to `band` at position `index` among that band's other rooms (clamped).
 * Rooms keep their relative order otherwise. An unknown id returns an equal copy.
 */
export function moveRoom(rooms: readonly RoomDef[], id: string, band: Band, index: number): RoomDef[] {
  const room = rooms.find((r) => r.id === id);
  if (!room) return rooms.slice();
  const rest = rooms.filter((r) => r !== room);
  const others = bandRooms(rest, band);
  const i = Math.max(0, Math.min(others.length, Number.isFinite(index) ? Math.trunc(index) : others.length));
  const moved: RoomDef = { ...room, band };
  // Insert before the band room now at position i, or right after the band's last room (else at the end).
  const at = i < others.length ? rest.indexOf(others[i]) : others.length ? rest.indexOf(others[others.length - 1]) + 1 : rest.length;
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

/** Sets room `id`'s width, rounded and clamped to 8–24. A non-number width leaves the room alone. */
export function resizeRoom(rooms: readonly RoomDef[], id: string, width: number): RoomDef[] {
  if (!Number.isFinite(width)) return rooms.slice();
  const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
  return rooms.map((r) => (r.id === id && r.width !== w ? { ...r, width: w } : r));
}

/** A room id from a name: lowercase, each non [a-z0-9] → '-', dashes trimmed, ≤ 32 chars; "room" if nothing is left. */
export function roomIdFrom(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_ID).replace(/-+$/, '');
  return ID_RE.test(id) ? id : 'room';
}

/** `base`, else `base-2`, `base-3`… (the base shortened so the id stays ≤ 32 chars). */
function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = base.slice(0, MAX_ID - suffix.length).replace(/-+$/, '') + suffix;
    if (!taken.has(id)) return id;
  }
}

/**
 * Adds a room at the end of `band`, width 12. A custom room's id comes from its name; a division
 * room uses the division id as the base id (callers pass the division name as `name`). Ids are made unique.
 */
export function addRoom(rooms: readonly RoomDef[], r: { division?: string; name: string; band: Band }): RoomDef[] {
  const name = r.name.trim();
  const base = r.division && ID_RE.test(r.division) ? r.division : roomIdFrom(name);
  const id = uniqueId(base, new Set([...rooms.map((x) => x.id), BULLPEN]));
  const room: RoomDef = { id, name: name || id, ...(r.division ? { division: r.division } : {}), band: r.band, width: NEW_WIDTH };
  return moveRoom([...rooms, room], id, r.band, Number.POSITIVE_INFINITY);
}

/** Removes room `id`. The Bullpen is refused: the input comes back unchanged. */
export function removeRoom(rooms: readonly RoomDef[], id: string): RoomDef[] {
  if (id === BULLPEN) return rooms as RoomDef[];
  return rooms.filter((r) => r.id !== id);
}
