import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DIVISIONS, type DivisionDef } from '../shared/building.ts';
import { BuildingFileError, readDivision } from '../server/building/files.ts';
import { CliError, UsageError, expectPositionals, parseArgs, table } from './args.ts';

/**
 * The divisions the office would show: the files in `<home>/divisions`, or, when that directory is
 * missing or empty (the server seeds it on first start), the defaults at the revision seeding gives them.
 * Broken files are reported in `warnings` and skipped.
 */
export function loadDivisions(home: string): { divisions: DivisionDef[]; warnings: string[] } {
  const dir = join(home, 'divisions');
  let names: string[] = [];
  try { if (existsSync(dir)) names = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort(); } catch { /* treated as empty */ }
  const byId = (a: DivisionDef, b: DivisionDef) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (names.length === 0) {
    return { divisions: DEFAULT_DIVISIONS.map((d) => ({ ...d, revision: 1 })).sort(byId), warnings: [] };
  }
  const divisions: DivisionDef[] = [];
  const warnings: string[] = [];
  for (const n of names) {
    try { divisions.push(readDivision(join(dir, n))); }
    catch (e) { warnings.push(e instanceof BuildingFileError ? e.message : `${join(dir, n)}: ${(e as Error).message}`); }
  }
  divisions.sort(byId);
  return { divisions, warnings };
}

export function divisionCommand(argv: string[], home: string): number {
  const sub = argv[0];
  const p = parseArgs(argv.slice(1), []);
  if (sub === 'list') {
    expectPositionals(p, 0, 'no arguments after `division list`');
    const { divisions, warnings } = loadDivisions(home);
    for (const w of warnings) console.error(`warning: ${w}`);
    process.stdout.write(table([['ID', 'NAME', 'COLOR', 'REVISION'], ...divisions.map((d) => [d.id, d.name, d.color, String(d.revision)])]));
    return 0;
  }
  if (sub === 'show') {
    expectPositionals(p, 1, '`division show <id>`');
    const { divisions } = loadDivisions(home);
    const d = divisions.find((x) => x.id === p.positionals[0]);
    if (!d) throw new CliError(`unknown division ${p.positionals[0]} (see \`kubicle division list\`)`);
    console.log(`id:       ${d.id}\nname:     ${d.name}\ncolor:    ${d.color}\nrevision: ${d.revision}\nharness:  ${JSON.stringify(d.harness)}`);
    return 0;
  }
  throw new UsageError('expected `division list` or `division show <id>`');
}
