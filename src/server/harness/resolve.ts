// Turns (building, project, room, task) into the `claude` argv plus generated files under
// <home>/run/<launch-id>/. Secret VALUES never pass through here: the store is only asked `has`,
// generated files hold `${KUBICLE_SECRET_X}` placeholders, and `spec.secrets` maps env names to
// secret names for the launcher (Task 7) to fill in at exec time.
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BULLPEN, defaultFloor, type Building, type RoomDef } from '../../shared/building.ts';
import { PROMPT_MAX, effective, harnessProblems, mergeHarness, permissionModeProblem, type Effective, type Harness, type PermissionMode } from '../../shared/harness.ts';
import { writeAtomic } from '../fsutil.ts';
import { DIR_MODE, FILE_MODE } from '../building/files.ts';
import { TASK_MAX } from '../launcher.ts';
import { secretRefs, toClaudeMcp } from './catalog.ts';
import { copyContained, listLibrary } from './skills.ts';
import type { SecretStore } from './secrets.ts';

export interface LaunchSpec {
  id: string; cwd: string; room: string; division?: string; args: string[];
  /** env var name → secret name; values are looked up only by the launcher, at exec time */
  secrets: Record<string, string>;
  env: Record<string, string>; runDir: string; warnings: string[];
}

/** Why a room cannot launch; every problem is a user-facing sentence. */
export class HarnessError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(problems.join('; '));
    this.name = 'HarnessError';
    this.problems = problems;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SWEEP_MS = 24 * 3600_000;
const BAD_CHARS = 'The task contains characters that cannot be passed to claude.';

const secretEnv = (name: string): string => `KUBICLE_SECRET_${name.toUpperCase().replace(/-/g, '_')}`;

interface Resolved { room: RoomDef; eff: Effective; warnings: string[] }

function resolve(b: Building, projectId: string, roomId: string): Resolved {
  const floor = b.floors[projectId] ?? defaultFloor();
  const room = floor.rooms.find((r) => r.id === roomId);
  if (!room) throw new HarnessError([`No room "${roomId}" on this floor`]);
  const warnings: string[] = [];
  const override = b.overrides[projectId]?.rooms[roomId];
  const problems: string[] = [];
  if (override !== undefined) for (const p of harnessProblems(override, 'room')) problems.push(`Override for room "${roomId}": ${p}`);
  let base: Harness = {};
  if (room.division && room.id !== BULLPEN) {
    const div = b.divisions.find((d) => d.id === room.division);
    if (!div) warnings.push(`Room "${roomId}" names an unknown division "${room.division}"`);
    else {
      for (const p of harnessProblems(div.harness)) problems.push(`Division "${div.id}": ${p}`);
      base = div.harness as Harness;
    }
  }
  if (override?.tools?.some((t) => t.startsWith('-')) && !base.tools?.length) problems.push(`Room "${roomId}" removes tools but its division lists none`);
  if (problems.length > 0) throw new HarnessError(problems);
  return { room, eff: effective(mergeHarness(base, override ?? {})), warnings };
}

/** The room's effective harness: a division room is its division's harness then the override; others the override only. */
export function resolveHarness(b: Building, projectId: string, roomId: string): Effective {
  return resolve(b, projectId, roomId).eff;
}

/** Whether a process with this pid exists (EPERM: it exists but belongs to someone else). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The pid `kubicle agent` recorded for the claude it started in `dir`, or null. */
function runPid(dir: string): number | null {
  let text: string;
  try { text = readFileSync(join(dir, 'pid'), 'utf8').trim(); } catch { return null; }
  return /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : null;
}

/**
 * Removes <home>/run/<uuid> directories last modified more than 24 h before `nowMs`, except one whose `pid` file
 * names a live process (a claude session still using its settings and plugin files). Nothing else in run/ is touched.
 */
export function sweepRuns(home: string, nowMs: number, alive: (pid: number) => boolean = pidAlive): void {
  const run = join(home, 'run');
  let names: string[];
  try { names = readdirSync(run); } catch { return; }
  for (const n of names) {
    if (!UUID_RE.test(n)) continue;
    const p = join(run, n);
    try {
      const st = lstatSync(p);
      if (!st.isDirectory() || nowMs - st.mtimeMs <= SWEEP_MS) continue;
      const pid = runPid(p);
      if (pid !== null && alive(pid)) continue;
      rmSync(p, { recursive: true, force: true });
    } catch { /* raced or unreadable: leave it */ }
  }
}

/** The mode claude gets: the room's, else the global default, else auto. Kubicle's `manual` is Claude's `default`. */
function claudePermissionMode(room: PermissionMode | undefined, global: unknown): string {
  const mode = room ?? (permissionModeProblem('', global) === null ? global as PermissionMode : 'auto');
  return mode === 'manual' ? 'default' : mode;
}

/** The installed Kubicle hook groups from Claude's user settings (other hooks dropped). Null when none. */
function kubicleHooks(claudeSettings: string): Record<string, unknown[]> | null {
  let s: unknown;
  try { s = JSON.parse(readFileSync(claudeSettings, 'utf8')); } catch { return null; }
  const hooks = (s as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return null;
  const out: Record<string, unknown[]> = {};
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object' || !Array.isArray((g as { hooks?: unknown }).hooks)) continue;
      const hs = ((g as { hooks: unknown[] }).hooks).filter((h) =>
        !!h && typeof h === 'object' && typeof (h as { command?: unknown }).command === 'string' && (h as { command: string }).command.includes('kubicle-hook'));
      if (hs.length > 0) kept.push({ ...(g as object), hooks: hs });
    }
    if (kept.length > 0) out[ev] = kept;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** chmod a copied tree: dirs 0700, files keep only the owner bits (0600, or 0700 if executable). */
function tighten(dir: string): void {
  chmodSync(dir, DIR_MODE);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tighten(p);
    else if (e.isFile()) chmodSync(p, (statSync(p).mode & 0o100) ? 0o700 : FILE_MODE);
  }
}

export function buildLaunch(o: {
  home: string; claudeSettings: string; building: Building; projectId: string; roomId: string;
  task: string; briefing?: string; secrets: Pick<SecretStore, 'has'>; id?: string;
  /** Adds claude's `-p` (non-interactive print mode) before the task. */
  print?: boolean;
}): LaunchSpec {
  sweepRuns(o.home, Date.now());
  const id = o.id ?? randomUUID();
  if (!UUID_RE.test(id)) throw new Error('launch id must be a uuid');

  const task = o.task.replace(/\r\n?/g, '\n').trim();
  if (Array.from(task).length > TASK_MAX) throw new HarnessError([`The task must be at most ${TASK_MAX} characters.`]);
  const { room, eff, warnings } = resolve(o.building, o.projectId, o.roomId);

  if (o.briefing && o.briefing.length > PROMPT_MAX) throw new HarnessError([`The briefing must be at most ${PROMPT_MAX} characters.`]);
  let prompt = eff.prompt;
  if (o.briefing) prompt = (prompt === undefined ? '' : `${prompt}\n\n`) + `[Kubicle/Bubbles briefing]\n${o.briefing}`;
  if ([task, prompt ?? '', o.projectId].some((s) => s.includes('\0'))) throw new HarnessError([BAD_CHARS]);

  const problems: string[] = [];
  const miss = (name: string, msg: string) => { if (eff.optional.has(name)) warnings.push(msg); else problems.push(msg); };

  const mcpServers: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  for (const name of eff.mcp) {
    const def = o.building.mcp.servers[name];
    if (!def) { miss(name, `MCP server "${name}" is not in mcp.yaml`); continue; }
    const unset = secretRefs(def).filter((s) => !o.secrets.has(s));
    if (unset.length > 0) { for (const s of unset) miss(name, `Secret "${s}" is not set: run kubicle secret set ${s}`); continue; }
    mcpServers[name] = toClaudeMcp(def);
    for (const s of secretRefs(def)) secrets[secretEnv(s)] = s;
  }

  const library = listLibrary(o.home);
  const skills: { name: string; path: string }[] = [];
  for (const name of eff.skills) {
    const s = library.find((x) => x.name === name);
    if (!s) miss(name, `Skill "${name}" is not in the skill library`); else skills.push(s);
  }

  let hooks: Record<string, unknown[]> | null = null;
  if (!eff.inherit) {
    hooks = kubicleHooks(o.claudeSettings);
    if (!hooks) problems.push(`Kubicle's hooks are not installed in ${o.claudeSettings}: run kubicle install-hooks`);
  }
  if (problems.length > 0) throw new HarnessError(problems);

  const runRoot = join(o.home, 'run');
  const runDir = join(runRoot, id);
  mkdirSync(runRoot, { recursive: true, mode: DIR_MODE });
  chmodSync(runRoot, DIR_MODE); // an existing run/ may be looser
  mkdirSync(runDir, { mode: DIR_MODE }); // throws if it exists: never reuse or follow a planted path
  try {
    chmodSync(runDir, DIR_MODE);
    const settingsFile = join(runDir, 'settings.json');
    const settings: Record<string, unknown> = {};
    const perms: Record<string, string[]> = {};
    for (const k of ['allow', 'ask', 'deny'] as const) if (eff[k].length > 0) perms[k] = eff[k];
    if (Object.keys(perms).length > 0) settings.permissions = perms;
    if (hooks) settings.hooks = hooks;
    writeAtomic(settingsFile, JSON.stringify(settings, null, 2), FILE_MODE);

    const args = ['--settings', settingsFile];
    if (!eff.inherit) args.push('--setting-sources', '', '--strict-mcp-config');
    if (Object.keys(mcpServers).length > 0) {
      const f = join(runDir, 'mcp.json');
      writeAtomic(f, JSON.stringify({ mcpServers }, null, 2), FILE_MODE);
      args.push('--mcp-config', f);
    }
    if (skills.length > 0) {
      const plugin = join(runDir, 'plugin');
      writeAtomic(join(plugin, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: `kubicle-room-${room.id}`, description: `Skills for the Kubicle room "${room.name}"` }, null, 2), FILE_MODE, DIR_MODE);
      for (const s of skills) {
        try { copyContained(s.path, join(plugin, 'skills', s.name), s.name); }
        catch { throw new HarnessError([`Skill "${s.name}" could not be copied from the skill library`]); }
      }
      tighten(plugin);
      args.push('--plugin-dir', plugin);
    }
    if (eff.model !== undefined) args.push('--model', eff.model);
    if (prompt !== undefined) {
      const replace = eff.promptMode === 'replace' && eff.prompt !== undefined;
      args.push(replace ? '--system-prompt' : '--append-system-prompt', prompt);
    }
    if (eff.tools !== undefined) args.push('--tools', eff.tools.join(','));
    args.push('--permission-mode', claudePermissionMode(eff.permissionMode, o.building.settings?.default_permission_mode));
    if (o.print) args.push('-p');
    if (task !== '') args.push('--', task);

    const env: Record<string, string> = { KUBICLE_ROOM: room.id, KUBICLE_LAUNCH: id };
    if (room.division) env.KUBICLE_DIVISION = room.division;
    const spec: LaunchSpec = { id, cwd: o.projectId, room: room.id, args, secrets, env, runDir, warnings };
    if (room.division) spec.division = room.division;
    const { warnings: _w, ...stored } = spec;
    writeAtomic(join(runDir, 'launch.json'), JSON.stringify(stored, null, 2), FILE_MODE);
    return spec;
  } catch (e) {
    rmSync(runDir, { recursive: true, force: true });
    throw e;
  }
}
