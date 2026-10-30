import { readFileSync, writeFileSync, renameSync, statSync, mkdirSync, copyFileSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookEventName } from '../shared/events.ts';
import { ensureIngestToken } from '../server/auth.ts';
import { loadConfig } from '../server/config.ts';

export const HOOK_EVENTS: HookEventName[] = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification',
  'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'CwdChanged',
];

const TOOL_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
const MARKER = '/bin/office-hook';

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isOurs = (h: any): boolean => isObj(h) && typeof h.command === 'string' && h.command.includes(MARKER);

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

const quote = (p: string) => (/[\s"'$`\\]/.test(p) ? `"${p.replace(/(["$`\\])/g, '\\$1')}"` : p);

export function planInstall(settings: any, shimPath: string): any {
  checkShape(settings);
  const next = structuredClone(settings);
  const hooks: Record<string, any[]> = next.hooks ?? {};
  for (const ev of HOOK_EVENTS) {
    const perm = ev === 'PermissionRequest';
    const group: any = {
      hooks: [{ type: 'command', command: `${quote(shimPath)} ${perm ? 140 : 2}`, timeout: perm ? 150 : 5 }],
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

function writeAtomic(file: string, text: string, mode: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

function countOurs(s: any): number {
  let n = 0;
  for (const groups of Object.values<any[]>(s?.hooks ?? {})) for (const g of groups) n += (g.hooks ?? []).filter(isOurs).length;
  return n;
}

function main(argv: string[]): number {
  const cmd = argv[0];
  if (cmd !== 'install' && cmd !== 'uninstall') {
    console.error('usage: install.ts install|uninstall [--settings <path>]');
    return 2;
  }
  const i = argv.indexOf('--settings');
  const file = resolve(i >= 0 && argv[i + 1] ? argv[i + 1]! : join(homedir(), '.claude', 'settings.json'));

  let raw: string | null = null;
  let mode = 0o644;
  try {
    raw = readFileSync(file, 'utf8');
    mode = statSync(file).mode & 0o777;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') { console.error(`cannot read ${file}: ${e.message}`); return 1; }
  }

  let current: any = {};
  if (raw !== null && raw.trim() !== '') {
    try { current = JSON.parse(raw); } catch (e: any) {
      console.error(`${file} is not valid JSON (${e.message}); nothing was changed.`);
      return 1;
    }
  }

  const shimPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'office-hook');
  let next: any;
  try {
    next = cmd === 'install' ? planInstall(current, shimPath) : planUninstall(current);
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
    backup = `${file}.agent-office.bak`;
    copyFileSync(file, backup);
  }
  writeAtomic(file, JSON.stringify(next, null, 2) + '\n', mode);

  if (cmd === 'install') {
    ensureIngestToken(loadConfig(process.env).home);
    console.log(`Settings: ${file}`);
    console.log(`Added ${HOOK_EVENTS.length} hook events -> ${shimPath}`);
    console.log(backup ? `Backup: ${backup}` : 'Backup: none (file did not exist)');
    console.log('Run `npm start` to open the office.');
  } else {
    console.log(`Settings: ${file}`);
    console.log(`Removed ${countOurs(current)} Agent Office hook entries.`);
    console.log(`Backup: ${backup}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
