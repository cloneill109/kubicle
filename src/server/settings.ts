// Global Kubicle settings: <home>/settings.yaml (0600, atomic, revision-checked like every other Kubicle file).
//   revision: 3
//   default_permission_mode: auto   # auto | acceptEdits | manual | plan; a room's permission_mode wins
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { KubicleSettings } from '../shared/building.ts';
import { permissionModeProblem, type PermissionMode } from '../shared/harness.ts';
import { writeAtomic } from './fsutil.ts';
import { BuildingFileError, DIR_MODE, FILE_MODE, checkBase, parseFile, validRev } from './building/files.ts';

export const DEFAULT_SETTINGS: KubicleSettings = { revision: 0, default_permission_mode: 'auto' };
const KEYS = ['revision', 'default_permission_mode'];

export const settingsFile = (home: string): string => join(home, 'settings.yaml');

function problems(s: Record<string, unknown>): string[] {
  const errs: string[] = [];
  for (const k of Object.keys(s)) if (!KEYS.includes(k)) errs.push(`unknown key "${k}"`);
  if (!validRev(s.revision)) errs.push('revision must be an integer >= 1');
  if (s.default_permission_mode !== undefined) {
    const p = permissionModeProblem('default_permission_mode', s.default_permission_mode);
    if (p) errs.push(p);
  }
  return errs;
}

/** A missing file is the defaults at revision 0. A bad file throws BuildingFileError (naming the file and key). */
export function readSettings(home: string): KubicleSettings {
  const file = settingsFile(home);
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
  const data = parseFile(file);
  const errs = problems(data);
  if (errs.length > 0) throw new BuildingFileError(file, errs.join('; '));
  return { revision: data.revision as number, default_permission_mode: (data.default_permission_mode as PermissionMode | undefined) ?? 'auto' };
}

/** Applies `patch` on top of the stored settings and bumps the revision. Returns what was stored. */
export function writeSettings(home: string, patch: { default_permission_mode: PermissionMode }, baseRevision: number): KubicleSettings {
  const file = settingsFile(home);
  const p = permissionModeProblem('default_permission_mode', patch.default_permission_mode);
  if (p) throw new BuildingFileError(file, p);
  checkBase(file, baseRevision);
  const stored: KubicleSettings = { ...readSettings(home), ...patch, revision: baseRevision + 1 };
  writeAtomic(file, stringify(stored), FILE_MODE, DIR_MODE);
  return stored;
}
