// "Start agent" from the office: opens a new terminal window that runs `kubicle agent <launch-id>`, which reads the
// launch Kubicle built (<home>/run/<id>/launch.json: argv, env, secret names) and execs claude in the project.
//
// No task text, secret value or claude flag passes through AppleScript, a shell line or a terminal's argv: the window
// only gets the launch id and the Kubicle home. Subscription only: `kubicle agent` drops every ANTHROPIC_* /
// CLAUDE_CODE_USE_* variable. No model call is made by Kubicle itself.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import type { LaunchSpec } from './harness/resolve.ts';
import { LaunchError, terminalCommand } from './terminal.ts';

export { LaunchError, shq } from './terminal.ts';

export const TASK_MAX = 4000;

export type Launch = (spec: LaunchSpec) => Promise<void>;

const KUBICLE_BIN = resolve(import.meta.dirname, '..', '..', 'bin', 'kubicle');

/** Office settings the window must share; a new terminal window does not inherit the office's env. */
const FORWARDED = ['KUBICLE_CLAUDE_BIN', 'KUBICLE_SECRETS_STORE'] as const;

/** The argv the new window runs. On POSIX, FORWARDED variables set in the office go first via /usr/bin/env. */
export function agentArgv(id: string, home: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const argv = [process.execPath, '--disable-warning=ExperimentalWarning', KUBICLE_BIN, 'agent', id, '--home', home];
  const fwd = platform === 'win32' ? [] : FORWARDED.filter((k) => env[k]).map((k) => `${k}=${env[k]}`);
  return fwd.length > 0 ? ['/usr/bin/env', ...fwd, ...argv] : argv;
}

/** Whether `bin` is an executable on PATH (PATHEXT-aware on Windows). */
export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { accessSync(join(dir, bin + ext), constants.X_OK); return true; } catch { /* next */ }
    }
  }
  return false;
}

export interface LauncherOptions {
  /** Kubicle home (passed to `kubicle agent --home`, since the new window does not inherit KUBICLE_HOME). */
  home: string;
  /** KUBICLE_TERMINAL: app name for `open -a` on darwin (default Terminal), a `{cmd}` template on linux. */
  app?: string;
  platform?: NodeJS.Platform;
  /** Test seam: runs the terminal command. */
  run?: (file: string, args: string[], cwd: string) => Promise<void>;
  /** Test seam: is a binary on PATH. */
  which?: (bin: string) => boolean;
  /** The office's env (default process.env): only FORWARDED variables are read from it. */
  env?: NodeJS.ProcessEnv;
}

/** darwin: wait for `open` (it exits at once, and reports an unknown app). Elsewhere the terminal keeps running: detach. */
function defaultRun(platform: NodeJS.Platform, app: string) {
  return (file: string, args: string[], cwd: string) => new Promise<void>((ok, fail) => {
    if (platform === 'darwin') {
      execFile(file, args, { timeout: 10_000 }, (err, _out, stderr) => (err ? fail(new LaunchError(`could not open ${app || 'Terminal'}: ${String(stderr || err.message).trim()}`)) : ok()));
      return;
    }
    const child = spawn(file, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', (e) => fail(new LaunchError(`could not open a terminal (${file}): ${e.message}`)));
    child.once('spawn', () => { child.unref(); ok(); });
  });
}

export function makeLauncher(o: LauncherOptions): Launch {
  const platform = o.platform ?? process.platform;
  const run = o.run ?? defaultRun(platform, o.app ?? '');
  const which = o.which ?? ((b: string) => onPath(b));
  return async (spec) => {
    try {
      const cmd = terminalCommand(platform, { app: o.app, argv: agentArgv(spec.id, o.home, platform, o.env ?? process.env), cwd: spec.cwd, scriptDir: spec.runDir, which });
      if (cmd.script) writeFileSync(cmd.script.path, cmd.script.text, { mode: 0o700, flag: 'wx' });
      await run(cmd.file, cmd.args, spec.cwd);
    } catch (err) {
      // Nothing will ever read this launch: remove its files now rather than in 24 h.
      rmSync(spec.runDir, { recursive: true, force: true });
      throw err instanceof LaunchError ? err : new LaunchError(String(err instanceof Error ? err.message : err));
    }
  };
}
