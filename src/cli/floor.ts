import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BULLPEN, defaultFloor, type FloorDef, type RoomDef } from '../shared/building.ts';
import { MAX_WIDTH, MIN_WIDTH, addRoom, moveRoom, removeRoom, resizeRoom } from '../ui/floor-edit.ts';
import { BuildingFileError, RevisionConflict, readFloor, slugFor, writeFloor } from '../server/building/files.ts';
import { projectRoot } from '../server/projects.ts';
import { openStore, type ProjectRow } from '../server/store.ts';
import { CliError, UsageError, expectPositionals, parseArgs, table } from './args.ts';
import { loadDivisions } from './division.ts';

// KUBICLE_TEST_BUMP=1 with NODE_ENV=test is a test-only hook: it makes `edit` write the file between its read and its write.
const CONFLICT = 'This floor changed elsewhere. Reload to see the latest.';

interface Target { root: string; file: string; origin: 'home' | 'repo' }

/** Same precedence as BuildingService: repo-local file if present, else the home floor file. */
function target(home: string, root: string): Target {
  const repo = join(root, '.kubicle', 'floor.yaml');
  if (existsSync(repo)) return { root, file: repo, origin: 'repo' };
  return { root, file: join(home, 'floors', `${slugFor(root)}.yaml`), origin: 'home' };
}

/** The current floor and the revision a write must name (0 = no file yet: the default floor). */
function current(t: Target): FloorDef {
  return existsSync(t.file) ? readFloor(t.file, t.origin) : defaultFloor();
}

/** Projects the office has seen. Opens office.db without modifying it; an unreadable store counts as empty (with a warning). */
function storeProjects(home: string): ProjectRow[] {
  const db = join(home, 'office.db');
  if (!existsSync(db)) return [];
  try {
    const store = openStore(db, { readOnly: true });
    try { return store.listProjects(); } finally { store.close(); }
  } catch (e) {
    console.error(`warning: could not read ${db} (${(e as Error).message}); treating no projects as known`);
    return [];
  }
}

/**
 * The project root for a command. Rejected: a root that is neither a git repository nor a project
 * the office knows (typos must not write or show a default floor), and, for edits, archived projects.
 */
export function projectOf(flags: Map<string, string>, home: string, forEdit: boolean): string {
  const dir = flags.get('project');
  if (dir !== undefined && !(existsSync(dir) && statSync(dir).isDirectory())) throw new CliError(`--project ${dir} is not a directory`);
  const root = projectRoot(dir ?? process.cwd());
  const known = storeProjects(home).find((p) => p.id === root);
  if (!known && !existsSync(join(root, '.git'))) {
    throw new CliError('Not a known project and not inside a git repository. Run this inside a project, or pass --project <dir>.');
  }
  if (known?.archived && forEdit) throw new CliError(`Floor "${known.name}" is archived. Restore it in the Lobby first.`);
  return root;
}

const bandOf = (v: string | undefined, fallback?: 'top' | 'bottom'): 'top' | 'bottom' => {
  if (v === undefined && fallback) return fallback;
  if (v === 'top' || v === 'bottom') return v;
  throw new UsageError('--band must be top or bottom');
};

function show(home: string, root: string): number {
  const t = target(home, root);
  const f = current(t);
  const rows = [['BAND', 'ROOM', 'NAME', 'DIVISION', 'WIDTH']];
  for (const band of ['top', 'bottom'] as const) {
    for (const r of f.rooms.filter((x) => x.band === band)) rows.push([band, r.id, r.name, r.division ?? '-', String(r.width)]);
  }
  process.stdout.write(table(rows));
  return 0;
}

function list(home: string, cwdRoot: string): number {
  const projects = new Map<string, { root: string; name: string; order: number }>();
  for (const p of storeProjects(home)) if (!p.archived) projects.set(p.id, { root: p.id, name: p.name, order: p.order });
  if (!projects.has(cwdRoot)) projects.set(cwdRoot, { root: cwdRoot, name: cwdRoot.split('/').filter(Boolean).pop() ?? cwdRoot, order: Number.MAX_SAFE_INTEGER });
  const rows = [['SLUG', 'NAME', 'SOURCE', 'REVISION', 'ROOMS']];
  for (const p of [...projects.values()].sort((a, b) => a.order - b.order || (a.root < b.root ? -1 : 1))) {
    const t = target(home, p.root);
    try {
      const f = current(t);
      rows.push([slugFor(p.root), p.name, f.source, String(f.revision), String(f.rooms.length)]);
    } catch (e) {
      console.error(`warning: ${(e as Error).message}`);
      rows.push([slugFor(p.root), p.name, 'invalid', '-', '-']);
    }
  }
  process.stdout.write(table(rows));
  return 0;
}

/**
 * Read the floor, apply `change`, write with base = the revision just read. A present but
 * invalid target is never overwritten. `change` returns the new rooms (or throws CliError).
 */
function edit(home: string, root: string, change: (rooms: RoomDef[], f: FloorDef) => RoomDef[]): number {
  const t = target(home, root);
  let floor: FloorDef;
  try { floor = current(t); }
  catch (e) {
    if (e instanceof BuildingFileError) throw new CliError(`${e.message}\nfix or delete ${t.file} before editing this floor`);
    throw e;
  }
  const rooms = change(floor.rooms, floor);
  if (isDeepStrictEqual(rooms, floor.rooms)) { console.log('No change.'); return 0; }
  if (process.env.KUBICLE_TEST_BUMP === '1' && process.env.NODE_ENV === 'test') writeFloor(t.file, floor, floor.revision); // test hook: someone else wrote first
  try {
    const stored = writeFloor(t.file, { revision: 0, rooms, source: t.origin }, floor.revision);
    console.log(`Saved ${t.file} (revision ${stored.revision})`);
    return 0;
  } catch (e) {
    if (e instanceof RevisionConflict) throw new CliError(`${CONFLICT}\n${t.file} is at revision ${e.current}; nothing was written.`, 3);
    if (e instanceof BuildingFileError) throw new CliError(e.message);
    throw e;
  }
}

function needRoom(rooms: RoomDef[], id: string): void {
  if (!rooms.some((r) => r.id === id)) throw new CliError(`no room "${id}" on this floor (see \`kubicle floor show\`)`);
}

export function floorCommand(argv: string[], home: string): number {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case 'list': {
      expectPositionals(parseArgs(rest, []), 0, 'no arguments after `floor list`');
      return list(home, projectRoot(process.cwd()));
    }
    case 'show': {
      const p = parseArgs(rest, ['project']);
      expectPositionals(p, 0, 'no arguments after `floor show` (use --project <dir>)');
      return show(home, projectOf(p.flags, home, false));
    }
    case 'add-room': {
      const p = parseArgs(rest, ['project', 'band', 'custom']);
      const custom = p.flags.get('custom');
      const band = bandOf(p.flags.get('band'), 'top');
      if (custom !== undefined) {
        expectPositionals(p, 0, 'either a division id or --custom <name>, not both');
        if (custom.trim() === '') throw new UsageError('--custom needs a name');
        return edit(home, projectOf(p.flags, home, true), (rooms) => addRoom(rooms, { name: custom, band }));
      }
      expectPositionals(p, 1, '`floor add-room <division>` or `--custom <name>`');
      const id = p.positionals[0]!;
      const div = loadDivisions(home).divisions.find((d) => d.id === id);
      if (!div) throw new CliError(`unknown division ${id} (see \`kubicle division list\`)`);
      return edit(home, projectOf(p.flags, home, true), (rooms) => addRoom(rooms, { division: div.id, name: div.name, band }));
    }
    case 'remove-room': {
      const p = parseArgs(rest, ['project']);
      expectPositionals(p, 1, '`floor remove-room <room-id>`');
      const id = p.positionals[0]!;
      if (id === BULLPEN) throw new CliError('The Bullpen cannot be removed.');
      return edit(home, projectOf(p.flags, home, true), (rooms) => { needRoom(rooms, id); return removeRoom(rooms, id); });
    }
    case 'move-room': {
      const p = parseArgs(rest, ['project', 'band', 'index']);
      expectPositionals(p, 1, '`floor move-room <room-id> --band top|bottom`');
      if (!p.flags.has('band')) throw new UsageError('--band is required');
      const band = bandOf(p.flags.get('band'));
      const raw = p.flags.get('index');
      if (raw !== undefined && !/^\d+$/.test(raw)) throw new UsageError('--index must be a non-negative integer');
      const index = raw === undefined ? Number.POSITIVE_INFINITY : Number(raw);
      const id = p.positionals[0]!;
      return edit(home, projectOf(p.flags, home, true), (rooms) => { needRoom(rooms, id); return moveRoom(rooms, id, band, index); });
    }
    case 'resize-room': {
      const p = parseArgs(rest, ['project']);
      expectPositionals(p, 2, '`floor resize-room <room-id> <width>`');
      const [id, raw] = p.positionals as [string, string];
      if (!/^\d+$/.test(raw)) throw new UsageError('width must be a whole number');
      const width = Number(raw);
      return edit(home, projectOf(p.flags, home, true), (rooms) => {
        needRoom(rooms, id);
        if (width < MIN_WIDTH || width > MAX_WIDTH) {
          console.error(`Width clamped to ${Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width))} (allowed ${MIN_WIDTH}–${MAX_WIDTH}).`);
        }
        return resizeRoom(rooms, id, width);
      });
    }
    default:
      throw new UsageError('expected `floor list|show|add-room|remove-room|move-room|resize-room`');
  }
}
