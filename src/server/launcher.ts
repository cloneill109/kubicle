// "Start agent" from the office: opens a new macOS Terminal window running interactive `claude`
// in the project, placed in a room (KUBICLE_ROOM), with the owner's task as the first prompt.
// Runs on the owner's subscription like any terminal session: every ANTHROPIC_* / CLAUDE_CODE_USE_*
// variable is unset first (the same rule as Bubbles). No model call is made by Kubicle itself.
//
// The task never passes through AppleScript or a shell command line built by us: it is written,
// single-quoted, into a one-time 0700 script under <home>/run that `open -a <app>` runs, and that
// script deletes itself as its first step.
import { execFile } from 'node:child_process';
import { readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ID_RE } from '../shared/building.ts';

export const TASK_MAX = 4000;
const STALE_MS = 60 * 60 * 1000;

/** `room` '' = no KUBICLE_ROOM: Bubbles' intake picks the room and briefs the agent. */
export interface LaunchRequest { cwd: string; room: string; task: string }
export type Launch = (r: LaunchRequest) => Promise<void>;

export class LaunchError extends Error {}

/** POSIX single-quoting: the only character that needs care inside '...' is ' itself. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Throws LaunchError for anything the script must not contain. */
export function checkRequest(r: LaunchRequest): void {
  if (r.room !== '' && !ID_RE.test(r.room)) throw new LaunchError('bad room');
  if (typeof r.task !== 'string' || Array.from(r.task).length > TASK_MAX) throw new LaunchError(`task must be at most ${TASK_MAX} characters`);
  if (/\0/.test(r.task) || /\0/.test(r.cwd)) throw new LaunchError('bad characters');
  if (!r.cwd.startsWith('/')) throw new LaunchError('bad project folder');
}

/** The launch script's text. Pure (tested). */
export function launchScript(r: LaunchRequest): string {
  checkRequest(r);
  const task = r.task.replace(/\r\n?/g, '\n').trim();
  return [
    '#!/bin/bash',
    '# One-time Kubicle launcher (deletes itself).',
    'rm -f -- "$0"',
    `cd -- ${shq(r.cwd)} || { echo "Kubicle: project folder is gone"; exit 1; }`,
    // Subscription only: drop API keys and provider switches, as Bubbles does.
    'for v in $(compgen -e); do case "$v" in ANTHROPIC_*|CLAUDE_CODE_USE_*) unset "$v";; esac; done',
    r.room ? `export KUBICLE_ROOM=${shq(r.room)}` : 'unset KUBICLE_ROOM KUBICLE_DIVISION',
    `printf '\\033]0;%s\\007' ${shq(`Kubicle · ${r.room || 'Bubbles picks the room'}`)}`,
    task ? `exec claude -- ${shq(task)}` : 'exec claude',
    '',
  ].join('\n');
}

/** Old scripts whose Terminal never ran them (e.g. the app failed to open). */
function sweep(dir: string, now: number): void {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!/^launch-[0-9a-f-]+\.command$/.test(n)) continue;
    try { if (now - statSync(join(dir, n)).mtimeMs > STALE_MS) unlinkSync(join(dir, n)); } catch { /* gone */ }
  }
}

export interface LauncherOptions {
  /** Directory for the one-time scripts (<home>/run, mode 0700). */
  runDir: string;
  /** Terminal app name for `open -a` (KUBICLE_TERMINAL; default Terminal). */
  app?: string;
  platform?: NodeJS.Platform;
  /** Test seam: runs `open`. */
  open?: (args: string[]) => Promise<void>;
}

export function makeLauncher(o: LauncherOptions): Launch {
  const platform = o.platform ?? process.platform;
  const app = o.app || 'Terminal';
  const open = o.open ?? ((args: string[]) => new Promise<void>((ok, fail) => {
    execFile('/usr/bin/open', args, { timeout: 10_000 }, (err, _out, stderr) => (err ? fail(new LaunchError(`could not open ${app}: ${String(stderr || err.message).trim()}`)) : ok()));
  }));
  return async (r) => {
    if (platform !== 'darwin') throw new LaunchError('Starting agents from the office needs macOS (it opens a Terminal window).');
    const text = launchScript(r);
    sweep(o.runDir, Date.now());
    const file = join(o.runDir, `launch-${randomUUID()}.command`);
    writeFileSync(file, text, { mode: 0o700, flag: 'wx' });
    try { await open(['-a', app, file]); } catch (err) {
      try { unlinkSync(file); } catch { /* already gone */ }
      throw err instanceof LaunchError ? err : new LaunchError(String(err));
    }
  };
}
