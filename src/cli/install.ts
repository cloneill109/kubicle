import { readFileSync, writeFileSync, renameSync, statSync, lstatSync, realpathSync, mkdirSync, copyFileSync, chmodSync, unlinkSync, constants } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookEventName } from '../shared/events.ts';
import { ensureIngestToken } from '../server/auth.ts';
import { loadConfig } from '../server/config.ts';
import { writeAtomic } from '../server/fsutil.ts';

export const HOOK_EVENTS: HookEventName[] = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification',
  'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'CwdChanged',
];

const TOOL_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
const MARKER = '/bin/kubicle-hook';
const LEGACY_MARKER = '/bin/office-hook'; // pre-rename entries: still recognised so uninstall/install clean them up

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isOurs = (h: any): boolean => isObj(h) && typeof h.command === 'string' && (h.command.includes(MARKER) || h.command.includes(LEGACY_MARKER));

function checkShape(settings: any): void {
  if (!isObj(settings)) throw new Error('settings must be a JSON object');
  if (settings.hooks === undefined) return;
  if (!isObj(settings.hooks)) throw new Error('"hooks" must be an object');
  for (const [ev, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${ev} must be an array`);
    for (const g of groups) {
      if (!isObj(g)) throw new Error(`hooks.${ev} contains a non-object group`);
      if (g.hooks !== undefined && !Array.isArray(g.hooks)) throw new Error(`hooks.${ev}[].hooks must be an array`);
    }
  }
}

// Remove our hook entries; drop groups that become empty because of that.
function stripOurs(groups: any[]): any[] {
  const out: any[] = [];
  for (const g of groups) {
    if (!Array.isArray(g.hooks) || !g.hooks.some(isOurs)) { out.push(g); continue; }
    const rest = g.hooks.filter((h: any) => !isOurs(h));
    if (rest.length > 0) out.push({ ...g, hooks: rest });
  }
  return out;
}

export const quote = (p: string): string => (/^[A-Za-z0-9_./+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

export interface HookEnv { home: string }

/**
 * Our entries carry the home the installer saw (I4), so a session started from a shell
 * without KUBICLE_HOME set still reaches the same office socket and reads the same token.
 * Recognised by MARKER, so older forms (no env prefix, `kubicle-hook 2` / `140`) are replaced too.
 */
export function planInstall(settings: any, shimPath: string, env: HookEnv): any {
  checkShape(settings);
  const next = structuredClone(settings);
  const hooks: Record<string, any[]> = next.hooks ?? {};
  const prefix = `KUBICLE_HOME=${quote(env.home)}`;
  for (const ev of HOOK_EVENTS) {
    // pre: the guard may answer "ask"; prompt: Bubbles intake may add a briefing (waits up to 8 s).
    const [args, timeout] = ev === 'PermissionRequest' ? ['140 perm', 150] : ev === 'PreToolUse' ? ['2 pre', 5]
      : ev === 'UserPromptSubmit' ? ['10 prompt', 12] : ['1', 5];
    const group: any = {
      hooks: [{ type: 'command', command: `${prefix} ${quote(shimPath)} ${args}`, timeout }],
    };
    if (TOOL_EVENTS.has(ev)) group.matcher = '*';
    hooks[ev] = [...stripOurs(hooks[ev] ?? []), group];
  }
  next.hooks = hooks;
  return next;
}

export function planUninstall(settings: any): any {
  checkShape(settings);
  const next = structuredClone(settings);
  if (!next.hooks) return next;
  for (const ev of Object.keys(next.hooks)) {
    const kept = stripOurs(next.hooks[ev]);
    if (kept.length > 0) next.hooks[ev] = kept;
    else delete next.hooks[ev];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

function countOurs(s: any): number {
  let n = 0;
  for (const groups of Object.values<any[]>(s?.hooks ?? {})) for (const g of groups) n += (g.hooks ?? []).filter(isOurs).length;
  return n;
}

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (cmd !== 'install' && cmd !== 'uninstall') {
    console.error('usage: install.ts install|uninstall [--settings <path>]');
    return 2;
  }
  const usage = 'usage: install.ts install|uninstall [--settings <path> | --settings=<path>]';
  let settingsArg: string | undefined;
  const rest = argv.slice(1);
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (a === '--settings') {
      const v = rest[++k];
      if (v === undefined || v === '' || v.startsWith('-')) { console.error(`--settings needs a path\n${usage}`); return 2; }
      settingsArg = v;
    } else if (a.startsWith('--settings=')) {
      const v = a.slice('--settings='.length);
      if (v === '' || v.startsWith('-')) { console.error(`--settings needs a path\n${usage}`); return 2; }
      settingsArg = v;
    } else {
      console.error(`unknown argument: ${a}\n${usage}`);
      return 2;
    }
  }
  const given = resolve(settingsArg ?? join(homedir(), '.claude', 'settings.json'));

  // Follow symlinks (stow/chezmoi): read, back up and write the real target.
  let file = given;
  let raw: string | null = null;
  let mode = 0o644;
  try {
    file = realpathSync(given);
    raw = readFileSync(file, 'utf8');
    mode = statSync(file).mode & 0o777;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') { console.error(`cannot read ${given}: ${e.message}`); return 1; }
    let dangling = false;
    try { dangling = lstatSync(given).isSymbolicLink(); } catch { /* not there at all */ }
    if (dangling) { console.error(`${given} is a dangling symlink; nothing was changed.`); return 1; }
  }

  let current: any = {};
  if (raw !== null && raw.trim() !== '') {
    try { current = JSON.parse(raw); } catch (e: any) {
      console.error(`${file} is not valid JSON (${e.message}); nothing was changed.`);
      return 1;
    }
  }

  const shimPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'kubicle-hook');
  let next: any;
  try {
    const { home } = loadConfig(process.env);
    next = cmd === 'install' ? planInstall(current, shimPath, { home: resolve(home) }) : planUninstall(current);
  } catch (e: any) {
    console.error(`${file} has an unexpected structure (${e.message}); nothing was changed.`);
    return 1;
  }

  if (cmd === 'uninstall' && raw === null) {
    console.log(`${file} does not exist; nothing to remove.`);
    return 0;
  }

  let backup = '';
  if (raw !== null) {
    if (isDeepStrictEqual(next, current)) {
      console.log(`Settings: ${file}`);
      console.log(cmd === 'install' ? 'Hooks already installed; nothing changed.' : 'No Kubicle hooks found; nothing changed.');
      if (cmd === 'install') ensureIngestToken(loadConfig(process.env).home);
      return 0;
    }
    backup = `${file}.kubicle.bak`;
    try { copyFileSync(file, backup, constants.COPYFILE_EXCL); } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e; // keep the first (original) backup
    }
  }
  writeAtomic(file, JSON.stringify(next, null, 2) + '\n', mode);

  if (cmd === 'install') {
    ensureIngestToken(loadConfig(process.env).home);
    console.log(`Settings: ${file}`);
    console.log(`Added ${HOOK_EVENTS.length} hook events -> ${shimPath}`);
    console.log(backup ? `Backup: ${backup}` : 'Backup: none (file did not exist)');
    console.log('Run `npm start` (or `./bin/kubicle start`) to open the office.');
  } else {
    console.log(`Settings: ${file}`);
    console.log(`Removed ${countOurs(current)} Kubicle hook entries.`);
    console.log(`Backup: ${backup}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
