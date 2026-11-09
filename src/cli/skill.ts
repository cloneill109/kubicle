// `kubicle skill list|importable|import|remove`: the library at <home>/skills.
import { existsSync, lstatSync, rmSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { ID_RE } from '../shared/building.ts';
import type { Config } from '../server/config.ts';
import { SkillImportError, importSkill, libraryDir, listImportable, listLibrary } from '../server/harness/skills.ts';
import { CliError, UsageError, expectPositionals, parseMulti, table } from './args.ts';

export function skillCommand(argv: string[], cfg: Config): number {
  const sub = argv[0];
  const p = parseMulti(argv.slice(1), {});
  if (sub === 'list') {
    expectPositionals(p, 0, 'no arguments after `skill list`');
    process.stdout.write(table([['NAME', 'DESCRIPTION'], ...listLibrary(cfg.home).map((s) => [s.name, s.description || '-'])]));
    return 0;
  }
  if (sub === 'importable') {
    expectPositionals(p, 0, 'no arguments after `skill importable`');
    const rows = listImportable(cfg.claudeDir).map((s) => [s.name, s.source, s.path]);
    process.stdout.write(table([['NAME', 'SOURCE', 'PATH'], ...rows]));
    return 0;
  }
  if (sub === 'import') {
    expectPositionals(p, 1, '`skill import <name-or-path>`');
    const arg = p.positionals[0]!;
    const all = listImportable(cfg.claudeDir);
    let path: string;
    if (isAbsolute(arg) || arg.includes('/') || arg.includes(sep)) path = resolve(arg);
    else {
      const hits = all.filter((s) => s.name === arg);
      if (hits.length === 0) throw new CliError(`No importable skill named "${arg}" (see \`kubicle skill importable\`).`);
      if (hits.length > 1) throw new CliError(`More than one skill is named "${arg}"; pass one of these paths:\n${hits.map((h) => h.path).join('\n')}`);
      path = hits[0]!.path;
    }
    try {
      const info = importSkill(cfg.home, path, cfg.claudeDir);
      console.log(`Imported skill "${info.name}" into ${info.path}`);
      return 0;
    } catch (e) {
      if (e instanceof SkillImportError) throw new CliError(e.message);
      throw e;
    }
  }
  if (sub === 'remove') {
    expectPositionals(p, 1, '`skill remove <name>`');
    const name = p.positionals[0]!;
    // ID_RE allows no separators, dots or leading dash; the containment check is a second guard.
    if (!ID_RE.test(name)) throw new UsageError('Skill names use lowercase letters, digits and dashes (max 32).');
    const lib = resolve(libraryDir(cfg.home));
    const target = resolve(lib, name);
    if (!target.startsWith(lib + sep)) throw new CliError('That is not inside the skill library.');
    let link = false, exists = existsSync(target);
    try { link = lstatSync(target).isSymbolicLink(); exists = exists || link; } catch { /* absent */ }
    if (!exists) throw new CliError(`No skill named "${name}" in the library.`);
    if (link) unlinkSync(target); // a symlink (even a dangling one) is unlinked, never followed
    else rmSync(target, { recursive: true });
    console.log(`Removed skill "${name}".`);
    return 0;
  }
  throw new UsageError('expected `skill list`, `skill importable`, `skill import <name-or-path>` or `skill remove <name>`');
}
