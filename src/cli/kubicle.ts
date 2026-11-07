import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.ts';
import { BuildingFileError } from '../server/building/files.ts';
import { CliError, USAGE, UsageError } from './args.ts';
import { bubblesCommand } from './bubbles.ts';
import { divisionCommand } from './division.ts';
import { floorCommand } from './floor.ts';
import { secretCommand } from './secret.ts';
import { main as installMain } from './install.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `kubicle start`: build the UI first if dist/ui/main.js is missing (same command as
 * `npm run build:ui`), then run the server as a child process (`node src/server/main.ts`) with
 * inherited stdio, so its login link and logs appear as with `npm start`. Signals are forwarded.
 */
function start(): Promise<number> {
  if (!existsSync(join(ROOT, 'dist', 'ui', 'main.js'))) {
    console.error('Building the UI...');
    const b = spawnSync('npm', ['run', 'build:ui'], { cwd: ROOT, stdio: 'inherit' });
    if (b.status !== 0) throw new CliError('UI build failed');
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src', 'server', 'main.ts')], { cwd: ROOT, stdio: 'inherit' });
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
    child.on('error', (e) => { console.error(`cannot start the server: ${e.message}`); resolve(1); });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function main(argv: string[]): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    const cfg = loadConfig(process.env);
    const home = cfg.home;
    switch (cmd) {
      case 'start':
        if (rest.length > 0) throw new UsageError(`unknown argument: ${rest[0]}`);
        return await start();
      case 'install-hooks':
      case 'uninstall-hooks':
        return installMain([cmd === 'install-hooks' ? 'install' : 'uninstall', ...rest]);
      case 'floor': return floorCommand(rest, home);
      case 'division': return divisionCommand(rest, home);
      case 'secret': return secretCommand(rest, home);
      case 'grant': case 'instruct': case 'revoke': case 'bubbles': case 'log':
        return await bubblesCommand(cmd, rest, cfg);
      default:
        throw new UsageError(cmd === undefined ? 'a command is required' : `unknown command: ${cmd}`);
    }
  } catch (e) {
    if (e instanceof UsageError) { console.error(`${e.message}\n${USAGE}`); return 2; }
    if (e instanceof CliError) { console.error(e.message); return e.code; }
    if (e instanceof BuildingFileError) { console.error(e.message); return 1; }
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
