import type { Harness } from './harness.ts';

// Shared building model: divisions, floors, rooms. Browser-safe (no Node imports).

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const BULLPEN = 'bullpen';

export interface DivisionDef { id: string; name: string; color: string; harness: Record<string, unknown>; revision: number }
export interface RoomDef { id: string; name: string; division?: string; band: 'top' | 'bottom'; width: number }
export interface FloorDef { revision: number; rooms: RoomDef[]; source: 'default' | 'home' | 'repo' }
export interface RoomOverrides { revision: number; rooms: Record<string, Harness> }
/** floors and overrides keyed by project id; a project with no overrides file has no overrides key */
export interface Building { divisions: DivisionDef[]; floors: Record<string, FloorDef>; overrides: Record<string, RoomOverrides>; warnings: string[] }

export const DEFAULT_DIVISIONS: Omit<DivisionDef, 'revision'>[] = [
  { id: 'qa', name: 'QA', color: '#62c4a0', harness: {} },
  { id: 'security', name: 'Cybersecurity', color: '#ec5f5f', harness: {} },
  { id: 'uxui', name: 'UX/UI', color: '#d571d9', harness: {} },
  { id: 'frontend', name: 'Front end', color: '#5b93f5', harness: {} },
  { id: 'backend', name: 'Back end', color: '#2fb79c', harness: {} },
  { id: 'animation', name: 'Animation', color: '#b98cf2', harness: {} },
  { id: 'imagegen', name: 'Image gen', color: '#f38b3d', harness: {} },
];

export function defaultFloor(): FloorDef {
  const div = (id: string, band: 'top' | 'bottom'): RoomDef => {
    const d = DEFAULT_DIVISIONS.find((x) => x.id === id)!;
    return { id, name: d.name, division: id, band, width: 12 };
  };
  return {
    revision: 0,
    source: 'default',
    rooms: [
      div('qa', 'top'), div('security', 'top'), div('uxui', 'top'), div('frontend', 'top'),
      { id: BULLPEN, name: 'Bullpen', band: 'bottom', width: 14 },
      div('backend', 'bottom'), div('animation', 'bottom'), div('imagegen', 'bottom'),
    ],
  };
}

// Unknown divisions are deliberately not errors: they render as "Unknown division".
// `divisionIds` is accepted for call-site symmetry with callers that hold the set.
export const MAX_ROOMS = 40;
export const MAX_NAME = 40;

export function validateFloor(f: FloorDef, _divisionIds: Set<string>): string[] {
  if (!f || typeof f !== 'object' || !Array.isArray(f.rooms)) return ['rooms must be a list'];
  const errs: string[] = [];
  if (f.rooms.length > MAX_ROOMS) errs.push(`a floor can have at most ${MAX_ROOMS} rooms`);
  const seen = new Set<string>();
  let hasBullpen = false;
  for (const [i, r] of f.rooms.entries()) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errs.push(`room #${i + 1} must be a mapping`); continue; }
    if (seen.has(r.id)) errs.push(`duplicate room id "${r.id}"`);
    seen.add(r.id);
    if (typeof r.id !== 'string' || !ID_RE.test(r.id)) errs.push(`room id "${r.id}" is invalid`);
    if (!Number.isInteger(r.width) || r.width < 8 || r.width > 24) errs.push(`width of "${r.id}" must be 8–24`);
    if (r.band !== 'top' && r.band !== 'bottom') errs.push(`band "${r.band}" is invalid`);
    if (r.division !== undefined && (typeof r.division !== 'string' || !ID_RE.test(r.division))) errs.push(`division of "${r.id}" is invalid`);
    if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > MAX_NAME) errs.push(`name of "${r.id}" must be 1–${MAX_NAME} characters`);
    if (r.id === BULLPEN) {
      hasBullpen = true;
      if (r.division) errs.push('"bullpen" cannot have a division');
    }
  }
  if (!hasBullpen) errs.push('"bullpen" is missing');
  return errs;
}

export type RoomHint = { label?: string; room?: string; division?: string; assigned?: string };
/** Who put the agent in its room: the owner's label, a launch hint, Bubbles, or nobody (Bullpen). */
export type PlacedBy = 'owner' | 'launch' | 'bubbles' | 'default';

export function placeRoom(floor: FloorDef, hint: RoomHint): { id: string; by: PlacedBy } {
  const has = (id: string | undefined): id is string => !!id && floor.rooms.some((r) => r.id === id);
  if (has(hint.label)) return { id: hint.label, by: 'owner' };
  if (has(hint.room)) return { id: hint.room, by: 'launch' };
  if (hint.division) {
    const r = floor.rooms.find((x) => x.division === hint.division);
    if (r) return { id: r.id, by: 'launch' };
  }
  if (has(hint.assigned)) return { id: hint.assigned, by: 'bubbles' };
  return { id: BULLPEN, by: 'default' };
}

export function resolveRoom(floor: FloorDef, hint: RoomHint): string {
  return placeRoom(floor, hint).id;
}
