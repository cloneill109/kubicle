import { existsSync } from 'node:fs';
import { stringify } from 'yaml';
import { writeAtomic } from '../fsutil.ts';
import { harnessProblems, type Harness } from '../../shared/harness.ts';
import { ID_RE, type RoomOverrides } from '../../shared/building.ts';
import {
  BuildingFileError, DIR_MODE, FILE_MODE, checkBase, isMap, parseFile, validRev,
} from './files.ts';

/** Thrown for a project or room the office does not know; the message is user-facing as is. */
export class OverrideNotFound extends BuildingFileError {
  constructor(file: string, reason: string) {
    super(file, reason);
    this.name = 'OverrideNotFound';
    this.message = reason;
  }
}

/** A setup the room could not launch with; the message is user-facing as is. */
export class OverrideRefused extends BuildingFileError {
  constructor(file: string, reason: string) {
    super(file, reason);
    this.name = 'OverrideRefused';
    this.message = reason;
  }
}

function problems(rooms: unknown, revision: unknown): string[] {
  const errs: string[] = [];
  if (!validRev(revision)) errs.push('revision must be an integer >= 1');
  if (!isMap(rooms)) { errs.push('rooms must be a mapping'); return errs; }
  for (const [id, h] of Object.entries(rooms)) {
    if (!ID_RE.test(id)) { errs.push(`rooms.${id}: room id is invalid`); continue; }
    for (const p of harnessProblems(h, 'room')) errs.push(`rooms.${id}: ${p}`);
  }
  return errs;
}

export function readOverrides(file: string): RoomOverrides {
  const data = parseFile(file);
  const rooms = data.rooms === undefined || data.rooms === null ? {} : data.rooms;
  const errs = problems(rooms, data.revision);
  for (const k of Object.keys(data)) if (k !== 'revision' && k !== 'rooms') errs.push(`unknown key "${k}"`);
  if (errs.length > 0) throw new BuildingFileError(file, errs.join('; '));
  return { revision: data.revision as number, rooms: rooms as Record<string, Harness> };
}

/** Sets (or, with null, removes) one room's override and bumps the revision. Returns what was stored. */
export function writeOverride(file: string, roomId: string, harness: Harness | null, baseRevision: number): RoomOverrides {
  checkBase(file, baseRevision);
  const rooms: Record<string, Harness> = existsSync(file) ? { ...readOverrides(file).rooms } : {};
  if (harness === null) delete rooms[roomId]; else rooms[roomId] = harness;
  const stored: RoomOverrides = { revision: baseRevision + 1, rooms };
  const errs = problems(stored.rooms, stored.revision);
  if (errs.length > 0) throw new BuildingFileError(file, errs.join('; '));
  writeAtomic(file, stringify(stored), FILE_MODE, DIR_MODE);
  return stored;
}
