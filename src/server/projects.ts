import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve as resolvePath } from 'node:path';
import type { Store, ProjectRow } from './store.ts';

const rootCache = new Map<string, string>();

function real(p: string): string {
  try { return realpathSync(p); } catch { return resolvePath(p); }
}

/** For a `.git` file, return the main repo dir if it is a linked worktree, else null. */
function worktreeMain(gitFile: string, dir: string): string | null {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitFile, 'utf8'));
    if (!m) return null;
    const gitdir = real(resolvePath(dir, m[1]));
    const parent = dirname(dirname(gitdir)); // <main>/.git
    if (basename(dirname(gitdir)) === 'worktrees' && basename(parent) === '.git') return dirname(parent);
  } catch { /* fall through */ }
  return null;
}

/** Walk up from cwd to the nearest dir containing `.git` (dir or file). Falls back to cwd. */
export function projectRoot(cwd: string): string {
  const start = real(cwd);
  const hit = rootCache.get(start);
  if (hit !== undefined) return hit;
  let dir = start;
  let root = start;
  for (;;) {
    const g = resolvePath(dir, '.git');
    if (existsSync(g)) {
      root = dir;
      try { if (statSync(g).isFile()) root = worktreeMain(g, dir) ?? dir; } catch { /* keep dir */ }
      break;
    }
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
