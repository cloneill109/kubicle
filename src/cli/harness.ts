// `kubicle harness resolve <room-or-division> [--project dir]`: the room's effective harness as YAML. Secrets appear as
// `secret:<name>` references only; this command never asks the secret store for a value (only whether one is set).
import { stringify } from 'yaml';
import { BULLPEN, defaultFloor, type Building, type RoomDef } from '../shared/building.ts';
import type { ProjectRow } from '../shared/protocol.ts';
import { slugFor } from '../server/building/files.ts';
import { BuildingService } from '../server/building/service.ts';
import type { Config } from '../server/config.ts';
import { HarnessError, resolveHarness } from '../server/harness/resolve.ts';
import { secretRefs } from '../server/harness/catalog.ts';
import { openSecrets } from '../server/harness/secrets.ts';
import { CliError, UsageError, expectPositionals, parseArgs } from './args.ts';
import { projectOf } from './floor.ts';

export interface Loaded { root: string; service: BuildingService; building: Building; room: RoomDef }

/** The room named by `target` on the project's floor: a room id first, else the first room with that division. */
export function loadRoom(target: string, flags: Map<string, string>, cfg: Config): Loaded {
  const root = projectOf(flags, cfg.home, false);
  const row: ProjectRow = { id: root, name: root, order: 0, slug: slugFor(root), approvals: 'off', archived: false, firstSeen: 0 };
  const service = new BuildingService(cfg.home, { claudeDir: cfg.claudeDir });
  const building = service.loadOnce([row]);
  const rooms = (building.floors[root] ?? defaultFloor()).rooms;
  const room = rooms.find((r) => r.id === target) ?? rooms.find((r) => r.division === target && r.id !== BULLPEN);
  if (!room) throw new CliError(`No room or division "${target}" on this floor (see \`kubicle floor show\`)`);
  return { root, service, building, room };
}

export function harnessCommand(argv: string[], cfg: Config): number {
  if (argv[0] !== 'resolve') throw new UsageError('expected `harness resolve <room-or-division>`');
  const p = parseArgs(argv.slice(1), ['project']);
  expectPositionals(p, 1, '`harness resolve <room-or-division>`');
  const { root, service, building, room } = loadRoom(p.positionals[0]!, p.flags, cfg);

  const problems = service.launchBlockers(root, room.id);
  const warnings: string[] = [];
  let eff;
  try { eff = resolveHarness(building, root, room.id); }
  catch (e) {
    if (e instanceof HarnessError) { for (const m of [...problems, ...e.problems]) console.error(m); return 1; }
    throw e;
  }
  const store = openSecrets(cfg.home);
  const note = (name: string, msg: string): void => { (eff.optional.has(name) ? warnings : problems).push(msg); };
  const servers: Record<string, unknown> = {};
  for (const name of eff.mcp) {
    const def = building.mcp.servers[name];
    if (!def) { note(name, `MCP server "${name}" is not in mcp.yaml`); continue; }
    servers[name] = def; // secret:<name> references, never values
    for (const s of secretRefs(def)) if (!store.has(s)) note(name, `Secret "${s}" is not set: run kubicle secret set ${s}`);
  }
  const library = new Set(building.skills.map((s) => s.name));
  for (const name of eff.skills) if (!library.has(name)) note(name, `Skill "${name}" is not in the skill library`);

  const out: Record<string, unknown> = { room: room.id };
  if (room.division) out.division = room.division;
  out.inherit = eff.inherit;
  if (eff.model !== undefined) out.model = eff.model;
  out.permission_mode = eff.permissionMode ?? building.settings?.default_permission_mode ?? 'auto';
  if (eff.prompt !== undefined) { out.prompt = eff.prompt; out.prompt_mode = eff.promptMode; }
  if (eff.tools !== undefined) out.tools = eff.tools;
  for (const k of ['allow', 'ask', 'deny', 'mcp', 'skills'] as const) if (eff[k].length > 0) out[k] = eff[k];
  if (eff.optional.size > 0) out.optional = [...eff.optional];
  if (Object.keys(servers).length > 0) out.mcp_servers = servers;
  process.stdout.write(stringify(out));
  for (const w of warnings) console.error(`warning: ${w}`);
  for (const m of problems) console.error(m);
  return problems.length > 0 ? 1 : 0;
}
