import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { ID_RE } from '../../shared/building.ts';
import type { SkillInfo } from '../../shared/catalog.ts';

export type { SkillInfo } from '../../shared/catalog.ts';

/** A refused import; the message is user-facing as is. */
export class SkillImportError extends Error {
  constructor(message: string) { super(message); this.name = 'SkillImportError'; }
}

const MAX_FILE = 1024 * 1024;
const MAX_DEPTH = 6;
const MAX_TOTAL = 10 * 1024 * 1024;
const MAX_FILES = 500;

/** name and description from the leading --- block; simple `key: value` lines only. */
function frontMatter(skillMd: string): { name?: string; description: string } {
  let text = '';
  try { text = readFileSync(skillMd, 'utf8'); } catch { /* unreadable: no metadata */ }
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const out: { name?: string; description: string } = { description: '' };
  if (lines[0]?.trim() !== '---') return out;
  for (let i = 1; i < lines.length && lines[i]!.trim() !== '---'; i++) {
    const m = /^(name|description):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const v = m[2]!.trim().replace(/^(["'])(.*)\1$/, '$2');
    if (m[1] === 'name') out.name = v; else out.description = v;
  }
  return out;
}

const dirs = (d: string): string[] => {
  try { return readdirSync(d, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).map((e) => e.name).sort(); } catch { return []; }
};
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

function skillsIn(dir: string, source: SkillInfo['source'], byFolder: boolean): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const n of dirs(dir)) {
    const path = join(dir, n);
    const md = join(path, 'SKILL.md');
    if (!isDir(path) || !existsSync(md)) continue;
    if (!byFolder && !ID_RE.test(n)) continue; // the library could not hold it
    const fm = frontMatter(md);
    out.push({ name: n, description: fm.description, path, source });
  }
  return out;
}

export const libraryDir = (home: string): string => join(home, 'skills');

export function listLibrary(home: string): SkillInfo[] {
  return skillsIn(libraryDir(home), 'library', true);
}

/** Skills in <claudeDir>/skills and under <claudeDir>/plugins/cache (bounded depth; symlinks are not followed there). */
export function listImportable(claudeDir: string): SkillInfo[] {
  const out = skillsIn(join(claudeDir, 'skills'), 'user', false);
  const walk = (dir: string, depth: number): void => {
    if (basename(dir) === 'skills') out.push(...skillsIn(dir, 'plugin', false));
    if (depth >= MAX_DEPTH) return;
    for (const n of dirs(dir)) {
      const p = join(dir, n);
      try { if (lstatSync(p).isDirectory()) walk(p, depth + 1); } catch { /* skip */ }
    }
  };
  walk(join(claudeDir, 'plugins', 'cache'), 0);
  return out;
}

/** Copies an importable skill into <home>/skills/<folder name>. The copy is real files, never a link. */
export function importSkill(home: string, source: string, claudeDir: string): SkillInfo {
  const src = listImportable(claudeDir).find((s) => s.path === source);
  if (!src) throw new SkillImportError('not an importable skill');
  const name = basename(src.path);
  if (!ID_RE.test(name)) throw new SkillImportError(`skill name "${name}" is invalid: use lowercase letters, digits and hyphens`);
  const dst = join(libraryDir(home), name);
  if (existsSync(dst)) throw new SkillImportError(`skill "${name}" already exists`);
  mkdirSync(libraryDir(home), { recursive: true, mode: 0o700 });
  const tmp = join(libraryDir(home), `.import-${name}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  try {
    copyContained(src.path, tmp, name);
    renameSync(tmp, dst);
  } catch (e) {
    if (e instanceof SkillImportError) throw e;
    const code = (e as NodeJS.ErrnoException).code ?? 'error';
    throw new SkillImportError(`could not copy skill "${name}": ${code}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { name, description: src.description, path: dst, source: 'library' };
}

/** Copies real files only, and only entries whose real path stays inside the skill folder. */
function copyContained(srcDir: string, dest: string, name: string): void {
  const root = realpathSync(srcDir);
  const inside = (p: string): boolean => p === root || p.startsWith(root + sep);
  const seen = new Set<string>();
  let bytes = 0, files = 0;
  const tooBig = () => new SkillImportError(`skill "${name}" is too large to import (limit 10 MB / 500 files)`);
  const walk = (real: string, out: string): void => {
    if (seen.has(real)) return;
    seen.add(real);
    mkdirSync(out, { recursive: true, mode: 0o700 });
    for (const n of readdirSync(real)) {
      if (n.startsWith('.')) continue;
      let rp: string;
      try { rp = realpathSync(join(real, n)); } catch { continue; } // dangling or looping link
      if (!inside(rp)) continue;
      const st = statSync(rp);
      if (st.isDirectory()) walk(rp, join(out, n));
      else if (st.isFile() && st.size <= MAX_FILE) {
        if (++files > MAX_FILES || (bytes += st.size) > MAX_TOTAL) throw tooBig();
        copyFileSync(rp, join(out, n));
      }
    }
  };
  walk(root, dest);
}
