import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ID_RE } from '../../shared/building.ts';
import type { SkillInfo } from '../../shared/catalog.ts';

export type { SkillInfo } from '../../shared/catalog.ts';

/** A refused import; the message is user-facing as is. */
export class SkillImportError extends Error {
  constructor(message: string) { super(message); this.name = 'SkillImportError'; }
}

const MAX_FILE = 1024 * 1024;
const MAX_DEPTH = 6;

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
    const fm = frontMatter(md);
    out.push({ name: byFolder ? n : fm.name || n, description: fm.description, path, source });
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
    cpSync(src.path, tmp, {
      recursive: true, dereference: true,
      filter: (s) => {
        if (s === src.path) return true;
        if (basename(s).startsWith('.')) return false;
        try { const st = statSync(s); return st.isDirectory() || st.size <= MAX_FILE; } catch { return false; }
      },
    });
    renameSync(tmp, dst);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { name, description: src.description, path: dst, source: 'library' };
}
