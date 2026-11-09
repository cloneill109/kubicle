// How to open a new terminal window running a command, per OS. Pure: the launcher writes the script (if any) and runs it.
// darwin is verified; win32 and linux are unit-tested by their argv only (UNVERIFIED on real machines).
import { join } from 'node:path';

export class LaunchError extends Error {}

/** POSIX single-quoting: the only character that needs care inside '...' is ' itself. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** PowerShell single-quoting: '' inside '...'. */
const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export const SCRIPT_NAME = 'kubicle-agent.command';

/** Tried in order when KUBICLE_TERMINAL is not set. */
const LINUX_TERMINALS: [string, string[]][] = [
  ['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['kitty', []], ['alacritty', ['-e']], ['xterm', ['-e']],
];

export interface TerminalCommand { file: string; args: string[]; script?: { path: string; text: string } }

/**
 * `argv` is what the new window runs (no task text: that stays in launch.json). `app` is KUBICLE_TERMINAL: an app
 * name on darwin, a `{cmd}` template on linux, unused on win32. `which` says whether a binary is on PATH.
 */
export function terminalCommand(platform: NodeJS.Platform, o: { app?: string; argv: string[]; cwd: string; scriptDir: string; which: (bin: string) => boolean }): TerminalCommand {
  if (platform === 'darwin') {
    const path = join(o.scriptDir, SCRIPT_NAME);
    const text = [
      '#!/bin/bash',
      '# One-time Kubicle launcher (deletes itself; `kubicle agent` reads the launch).',
      'rm -f -- "$0"',
      `cd -- ${shq(o.cwd)} || { echo "Kubicle: project folder is gone"; exit 1; }`,
      `exec ${o.argv.map(shq).join(' ')}`,
      '',
    ].join('\n');
    return { file: '/usr/bin/open', args: ['-a', o.app || 'Terminal', path], script: { path, text } };
  }
  if (platform === 'win32') {
    if (o.which('wt.exe')) return { file: 'wt.exe', args: ['-d', o.cwd, ...o.argv] };
    return { file: 'cmd.exe', args: ['/c', 'start', '"Kubicle"', '/D', o.cwd, 'powershell', '-NoExit', '-Command', `& ${o.argv.map(psq).join(' ')}`] };
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    const tpl = (o.app ?? '').trim();
    if (tpl !== '') {
      const [file, ...rest] = tpl.split(/\s+/);
      const args: string[] = [];
      let used = false;
      for (const t of rest) {
        if (t === '{cmd}') { args.push(...o.argv); used = true; }
        else if (t.includes('{cmd}')) { args.push(t.split('{cmd}').join(o.argv.map(shq).join(' '))); used = true; }
        else args.push(t);
      }
      if (!used) args.push(...o.argv);
      return { file: file!, args };
    }
    for (const [bin, pre] of LINUX_TERMINALS) if (o.which(bin)) return { file: bin, args: [...pre, ...o.argv] };
    throw new LaunchError('No terminal found. Set KUBICLE_TERMINAL, for example "kitty {cmd}".');
  }
  throw new LaunchError(`Starting agents from the office is not supported on ${platform}.`);
}
