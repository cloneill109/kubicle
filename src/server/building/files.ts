import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { writeAtomic } from '../fsutil.ts';
import {
  ID_RE, DEFAULT_DIVISIONS, validateFloor,
  type DivisionDef, type FloorDef, type RoomDef,
} from '../../shared/building.ts';

export class BuildingFileError extends Error {
  file: string;
  line?: number;
  constructor(file: string, reason: string, line?: number) {
    super(line === undefined ? `${file}: ${reason}` : `${file}:${line}: ${reason}`);
    this.name = 'BuildingFileError';
    this.file = file;
    this.line = line;
  }
}

export class RevisionConflict extends Error {
  file: string;
  current: number;
  constructor(file: string, current: number) {
    super(`${file} changed elsewhere (current revision ${current})`);
    this.name = 'RevisionConflict';
    this.file = file;
    this.current = current;
  }
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const COLOR_RE = /^#[0-9a-f]{6}$/;
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validRev = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;

export function slugFor(root: string): string {
  const base = basename(root).toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 6);
  return base ? `${base}-${hash}` : hash;
}

function parseFile(file: string): Record<string, unknown> {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (e) { throw new BuildingFileError(file, `cannot read file (${(e as NodeJS.ErrnoException).code ?? 'error'})`); }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const err = doc.errors[0]!;
    throw new BuildingFileError(file, err.message.split('\n')[0]!, err.linePos?.[0]?.line);
  }
  const data = doc.toJS();
  if (!isMap(data)) throw new BuildingFileError(file, 'top level must be a mapping');
  return data;
}

function divisionProblems(d: any): string[] {
  const errs: string[] = [];
  if (typeof d.id !== 'string' || !ID_RE.test(d.id)) errs.push(`division id "${d.id}" is invalid`);
  if (typeof d.name !== 'string' || d.name.length === 0 || d.name.length > 40) errs.push('name must be a non-empty string of at most 40 characters');
  if (typeof d.color !== 'string' || !COLOR_RE.test(d.color)) errs.push(`color "${d.color}" must look like #rrggbb`);
  if (!isMap(d.harness)) errs.push('harness must be a mapping');
  if (!validRev(d.revision)) errs.push('revision must be an integer >= 1');
  return errs;
}

function floorProblems(f: FloorDef): string[] {
  const errs = validateFloor(f, new Set());
  if (Array.isArray(f?.rooms)) {
    for (const r of f.rooms) {
      if (isMap(r) && (typeof r.name !== 'string' || r.name.length === 0)) errs.push(`room "${r.id}" needs a name`);
    }
  }
  if (!validRev(f?.revision)) errs.push('revision must be an integer >= 1');
  return errs;
}

export function readDivision(file: string): DivisionDef {
  const data = parseFile(file);
  const d: DivisionDef = {
    id: data.id as string, name: data.name as string, color: data.color as string,
    harness: data.harness as Record<string, unknown>, revision: data.revision as number,
  };
  const errs = divisionProblems(d);
  if (errs.length === 0 && basename(file) !== `${d.id}.yaml`) errs.push(`file name must equal "${d.id}.yaml"`);
  if (errs.length > 0) throw new BuildingFileError(file, errs.join('; '));
  return d;
}

const ROOM_KEYS = new Set(['id', 'name', 'division', 'band', 'width']);

function checkLayoutOnly(file: string, data: Record<string, unknown>): void {
  const bad = (key: string, path: string): never => {
    throw new BuildingFileError(file, `Repo floor files may only set layout: ${key} is not allowed (${path})`);
  };
  for (const k of Object.keys(data)) if (k !== 'revision' && k !== 'rooms') bad(k, k);
  if (Array.isArray(data.rooms)) {
    data.rooms.forEach((r, i) => {
      if (isMap(r)) for (const k of Object.keys(r)) if (!ROOM_KEYS.has(k)) bad(k, `rooms[${i}].${k}`);
    });
  }
}

export function readFloor(file: string, origin: 'home' | 'repo'): FloorDef {
  const data = parseFile(file);
  if (origin === 'repo') checkLayoutOnly(file, data);
  const rooms = Array.isArray(data.rooms)
    ? data.rooms.map((r): any => (isMap(r)
        ? { id: r.id, name: r.name, ...(r.division === undefined || r.division === null ? {} : { division: r.division }), band: r.band, width: r.width }
        : r))
    : data.rooms;
  const f = { revision: data.revision, rooms, source: origin } as FloorDef;
  const errs = floorProblems(f);
  if (errs.length > 0) throw new BuildingFileError(file, errs.join('; '));
  return f;
}

/**
 * Re-read the current revision immediately before writing. A tiny window remains between this
 * check and the rename (no cross-process lock); acceptable for a single-owner tool.
 * A present-but-unreadable file is never overwritten.
 */
function currentRevision(file: string): number {
  if (!existsSync(file)) return 0;
  const rev = parseFile(file).revision;
  if (!validRev(rev)) throw new BuildingFileError(file, 'revision must be an integer >= 1');
  return rev;
}

function checkBase(file: string, baseRevision: number): void {
  if (!Number.isInteger(baseRevision) || baseRevision < 0) throw new BuildingFileError(file, 'base revision must be an integer >= 0');
  const cur = currentRevision(file);
  if (cur !== baseRevision) throw new RevisionConflict(file, cur);
}

export function writeDivision(dir: string, d: DivisionDef, baseRevision: number): DivisionDef {
  const stored: DivisionDef = { id: d.id, name: d.name, color: d.color, harness: d.harness, revision: baseRevision + 1 };
  const errs = divisionProblems(stored);
  if (errs.length > 0) throw new BuildingFileError(join(dir, `${String(d.id)}.yaml`), errs.join('; '));
  const file = join(dir, `${stored.id}.yaml`); // id is ID_RE-validated: no path separators
  checkBase(file, baseRevision);
  writeAtomic(file, stringify(stored), FILE_MODE, DIR_MODE);
  return stored;
}

export function writeFloor(file: string, f: FloorDef, baseRevision: number): FloorDef {
  const stored: FloorDef = { revision: baseRevision + 1, rooms: f.rooms, source: f.source };
  const errs = floorProblems(stored);
  if (errs.length > 0) throw new BuildingFileError(file, errs.join('; '));
  const rooms = f.rooms.map((r: RoomDef) => ({
    id: r.id, name: r.name, ...(r.division ? { division: r.division } : {}), band: r.band, width: r.width,
  }));
  checkBase(file, baseRevision);
  writeAtomic(file, stringify({ revision: stored.revision, rooms }), FILE_MODE, DIR_MODE);
  return { ...stored, rooms };
}

export function seedDivisions(dir: string): boolean {
  if (existsSync(dir) && readdirSync(dir).length > 0) return false;
  for (const d of DEFAULT_DIVISIONS) writeDivision(dir, { ...d, revision: 0 }, 0);
  return true;
}
