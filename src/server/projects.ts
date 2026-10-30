import { existsSync } from 'node:fs';
import { basename, dirname, resolve as resolvePath } from 'node:path';
import type { Store, ProjectRow } from './store.ts';

const rootCache = new Map<string, string>();

/** Walk up from cwd to the nearest dir containing `.git` (dir or file). Falls back to cwd. */
export function projectRoot(cwd: string): string {
  const start = resolvePath(cwd);
  const hit = rootCache.get(start);
  if (hit !== undefined) return hit;
  let dir = start;
  let root = start;
  for (;;) {
    if (existsSync(resolvePath(dir, '.git'))) { root = dir; break; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  rootCache.set(start, root);
  return root;
}

export class Projects {
  #store: Store;
  constructor(store: Store) { this.#store = store; }

  resolve(cwd: string, now: number): ProjectRow {
    const root = projectRoot(cwd);
    const rows = this.#store.listProjects();
    const existing = rows.find((r) => r.id === root);
    if (existing) return existing;
    let name = basename(root) || root;
    if (rows.some((r) => r.name === name)) name = `${name} (${basename(dirname(root))})`;
    const wing = rows.reduce((m, r) => Math.max(m, r.wing), -1) + 1;
    const row: ProjectRow = { id: root, name, wing, approvals: 'off', archived: false, firstSeen: now };
    this.#store.upsertProject(row);
    return row;
  }

  list(): ProjectRow[] { return this.#store.listProjects(); }

  setApprovals(id: string, mode: 'off' | 'office'): ProjectRow {
    const cur = this.#store.listProjects().find((r) => r.id === id);
    if (!cur) throw new Error(`unknown project: ${id}`);
    const next = { ...cur, approvals: mode };
    this.#store.upsertProject(next); // carries original firstSeen
    return next;
  }
}
