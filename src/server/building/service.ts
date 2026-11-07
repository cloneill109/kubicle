import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import {
  defaultFloor, type Building, type DivisionDef, type FloorDef, type RoomDef, type RoomOverrides,
} from '../../shared/building.ts';
import type { ProjectRow } from '../../shared/protocol.ts';
import type { Harness } from '../../shared/harness.ts';
import { readOverrides, writeOverride, OverrideNotFound } from './overrides.ts';
import { BuildingFileError, RefusedFileError, readDivision, readFloor, seedDivisions, slugFor, writeDivision, writeFloor } from './files.ts';

type Origin = 'home' | 'repo';

export class BuildingService {
  onChange: ((b: Building) => void) | null = null;

  private home: string;
  private debounceMs: number;
  private sweepMs: number;
  private projects: () => ProjectRow[] = () => [];
  private started = false;

  // last good versions, keyed by file path
  private divisions = new Map<string, DivisionDef>();
  private floors = new Map<string, FloorDef>();
  private repoFloors = new Map<string, FloorDef>();
  private overrideFiles = new Map<string, RoomOverrides>();
  private built: Building = { divisions: [], floors: {}, overrides: {}, warnings: [] };
  private builtJson = JSON.stringify(this.built);
  private sig = '';

  private watchers = new Map<string, FSWatcher>();
  private debounce: NodeJS.Timeout | null = null;
  private sweep: NodeJS.Timeout | null = null;

  constructor(home: string, opts: { debounceMs?: number; sweepMs?: number } = {}) {
    this.home = home;
    this.debounceMs = opts.debounceMs ?? 100;
    this.sweepMs = opts.sweepMs ?? 60_000;
  }

  start(projects: () => ProjectRow[]): void {
    if (this.started) return;
    this.started = true;
    this.projects = projects;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    try { seedDivisions(this.divisionsDir()); } catch { /* surfaces as a missing-divisions state */ }
    this.reload();
    this.syncWatchers();
    this.sweep = setInterval(() => {
      if (this.signature() !== this.sig) this.refresh();
    }, this.sweepMs);
    this.sweep.unref();
  }

  stop(): void {
    this.started = false;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.sweep) clearInterval(this.sweep);
    this.debounce = this.sweep = null;
    for (const w of this.watchers.values()) { try { w.close(); } catch { /* ignore */ } }
    this.watchers.clear();
  }

  snapshot(): Building { return this.built; }

  floorFile(projectId: string): { file: string; origin: Origin } {
    if (!this.projects().some((p) => p.id === projectId && !p.archived)) {
      throw new BuildingFileError(projectId, 'unknown or archived project');
    }
    const repo = this.repoFile(projectId);
    if (existsSync(repo)) return { file: repo, origin: 'repo' };
    return { file: this.homeFile(projectId), origin: 'home' };
  }

  saveFloor(projectId: string, rooms: RoomDef[], baseRevision: number): FloorDef {
    const { file, origin } = this.floorFile(projectId);
    if (existsSync(file)) {
      try { readFloor(file, origin); }
      catch { throw new BuildingFileError(file, `fix or delete ${file} before editing this floor`); }
    }
    const stored = writeFloor(file, { revision: 0, rooms, source: origin }, baseRevision);
    this.refresh();
    return stored;
  }

  /** Rewrites only the harness (and bumps the revision) of a division; id, name and color stay. */
  saveDivisionHarness(id: string, harness: Harness, baseRevision: number): DivisionDef {
    const cur = this.divisionFiles().map((f) => this.divisions.get(f)).find((d) => d?.id === id);
    if (!cur) throw new BuildingFileError(id, 'unknown division');
    const file = join(this.divisionsDir(), `${id}.yaml`);
    try { readDivision(file); }
    catch { throw new BuildingFileError(file, `fix or delete ${file} before editing this division`); }
    const stored = writeDivision(this.divisionsDir(), { ...cur, harness: harness as Record<string, unknown> }, baseRevision);
    this.refresh();
    return stored;
  }

  /** Sets or (null) removes one room's override. Only ever writes <home>/overrides, never a repo file. */
  saveOverride(projectId: string, roomId: string, harness: Harness | null, baseRevision: number): RoomOverrides {
    if (!this.projects().some((p) => p.id === projectId && !p.archived)) throw new OverrideNotFound(projectId, 'unknown project');
    const floor = this.built.floors[projectId] ?? defaultFloor();
    if (!floor.rooms.some((r) => r.id === roomId)) throw new OverrideNotFound(projectId, `no room "${roomId}" on this floor`);
    const file = this.overrideFile(projectId);
    if (existsSync(file)) {
      try { readOverrides(file); }
      catch { throw new BuildingFileError(file, `fix or delete ${file} before editing these overrides`); }
    }
    const stored = writeOverride(file, roomId, harness, baseRevision);
    this.refresh();
    return stored;
  }

  refresh(): void {
    this.reload();
    if (this.started) this.syncWatchers();
    this.emitIfChanged();
  }

  // ---- paths ----
  private divisionsDir(): string { return join(this.home, 'divisions'); }
  private homeFile(id: string): string { return join(this.home, 'floors', `${slugFor(id)}.yaml`); }
  private overrideFile(id: string): string { return join(this.home, 'overrides', `${slugFor(id)}.yaml`); }
  private repoFile(id: string): string { return join(id, '.kubicle', 'floor.yaml'); }
  private repoDir(id: string): string { return join(id, '.kubicle'); }

  private divisionFiles(): string[] {
    try {
      return readdirSync(this.divisionsDir()).filter((f) => f.endsWith('.yaml')).sort().map((f) => join(this.divisionsDir(), f));
    } catch { return []; }
  }

  // ---- loading ----
  private reload(): void {
    const warn = new Map<string, string>();
    const problem = (file: string, e: unknown) => {
      warn.set(file, e instanceof BuildingFileError ? e.message : `${file}: ${e instanceof Error ? e.message : String(e)}`);
    };

    const files = this.divisionFiles();
    const present = new Set(files);
    for (const k of [...this.divisions.keys()]) if (!present.has(k)) this.divisions.delete(k);
    for (const file of files) {
      try { this.divisions.set(file, readDivision(file)); } catch (e) { problem(file, e); }
    }

    const floors: Record<string, FloorDef> = {};
    const seenHome = new Set<string>();
    const seenRepo = new Set<string>();
    const seenOver = new Set<string>();
    const overrides: Record<string, RoomOverrides> = {};
    for (const p of this.projects()) {
      const home = this.homeFile(p.id);
      seenHome.add(home);
      if (existsSync(home)) {
        try { this.floors.set(home, readFloor(home, 'home')); } catch (e) { problem(home, e); }
      } else this.floors.delete(home);

      // A broken repo floor keeps its last good version; a refused one (non-layout keys, symlink,
      // not a regular file, too large) is dropped so the floor falls back to home/default.
      const repo = this.repoFile(p.id);
      seenRepo.add(repo);
      let present = existsSync(repo);
      try { present = present || lstatSync(repo).isSymbolicLink(); } catch { /* absent */ }
      if (present) {
        try { this.repoFloors.set(repo, readFloor(repo, 'repo')); }
        catch (e) {
          problem(repo, e);
          if (e instanceof RefusedFileError) this.repoFloors.delete(repo);
        }
      } else this.repoFloors.delete(repo);
      const floor = this.repoFloors.get(repo) ?? this.floors.get(home) ?? defaultFloor();
      if (!p.archived) floors[p.id] = floor;

      // Overrides live only in <home>/overrides. A broken file keeps its last good version.
      const ovf = this.overrideFile(p.id);
      seenOver.add(ovf);
      if (existsSync(ovf)) {
        try { this.overrideFiles.set(ovf, readOverrides(ovf)); } catch (e) { problem(ovf, e); }
      } else this.overrideFiles.delete(ovf);
      const ov = this.overrideFiles.get(ovf);
      if (ov && !p.archived) {
        const known = new Set(floor.rooms.map((r) => r.id));
        const rooms: Record<string, Harness> = {};
        for (const [id, h] of Object.entries(ov.rooms)) {
          if (known.has(id)) rooms[id] = h;
          else warn.set(`${ovf}#${id}`, `override for unknown room "${id}" (${ovf})`);
        }
        overrides[p.id] = { revision: ov.revision, rooms };
      }
    }
    for (const k of [...this.floors.keys()]) if (!seenHome.has(k)) this.floors.delete(k);
    for (const k of [...this.repoFloors.keys()]) if (!seenRepo.has(k)) this.repoFloors.delete(k);
    for (const k of [...this.overrideFiles.keys()]) if (!seenOver.has(k)) this.overrideFiles.delete(k);

    this.sig = this.signature();
    const sortedFloors: Record<string, FloorDef> = {};
    for (const k of Object.keys(floors).sort()) sortedFloors[k] = floors[k]!;
    this.built = {
      divisions: [...this.divisions.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      floors: sortedFloors,
      overrides: Object.fromEntries(Object.keys(overrides).sort().map((k) => [k, overrides[k]!])),
      warnings: [...warn.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, m]) => m),
    };
  }

  private emitIfChanged(): void {
    const json = JSON.stringify(this.built);
    if (json === this.builtJson) return;
    this.builtJson = json;
    try { this.onChange?.(this.built); } catch { /* a listener must not break the service */ }
  }

  // ---- change detection ----
  private signature(): string {
    const files = [...this.divisionFiles()];
    try { files.push(this.divisionsDir()); } catch { /* ignore */ }
    for (const p of this.projects()) { files.push(this.homeFile(p.id), this.repoFile(p.id), this.overrideFile(p.id)); }
    return files.map((f) => {
      try { return `${f}:${statSync(f).mtimeMs}`; } catch { return `${f}:-`; }
    }).join('\n');
  }

  private schedule(): void {
    if (!this.started) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; if (this.started) this.refresh(); }, this.debounceMs);
    this.debounce.unref();
  }

  /** Ignore unrelated files in home (office.db, WAL, ...). A null filename means "unknown": schedule. */
  private relevant(isHome: boolean, name: string | null): boolean {
    if (name === null) return true;
    const n = name.split('\\').join('/');
    if (!isHome) return n === 'floor.yaml';
    return n === 'divisions' || n === 'floors' || n === 'overrides' || /^(divisions|floors|overrides)\/[^/]*\.yaml$/.test(n);
  }

  private syncWatchers(): void {
    const want = new Map<string, boolean>([[this.home, true]]);
    for (const p of this.projects()) {
      const d = this.repoDir(p.id);
      if (existsSync(d)) want.set(d, false);
    }
    for (const [dir, w] of [...this.watchers]) {
      if (!want.has(dir)) { try { w.close(); } catch { /* ignore */ } this.watchers.delete(dir); }
    }
    for (const [dir, recursive] of want) {
      if (this.watchers.has(dir)) continue;
      try {
        const w = watch(dir, { recursive }, (_ev, name) => {
          if (this.relevant(recursive, name === null ? null : String(name))) this.schedule();
        });
        w.on('error', () => { try { w.close(); } catch { /* ignore */ } this.watchers.delete(dir); });
        w.unref();
        this.watchers.set(dir, w);
      } catch { /* fall back to the sweep */ }
    }
  }
}
