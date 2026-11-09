// `kubicle run <room-or-division> [--project dir] [--print] [-- task...]`: prepare a launch exactly as the office does
// (same prepareLaunch: blockers, harness, settings default permission mode), then run it in this terminal through agentMain.
import type { Config } from '../server/config.ts';
import { HarnessError } from '../server/harness/resolve.ts';
import { prepareLaunch } from '../server/harness/prepare.ts';
import { openSecrets } from '../server/harness/secrets.ts';
import { agentMain, type AgentDeps } from './agent.ts';
import { CliError, UsageError, expectPositionals, parseMulti } from './args.ts';
import { loadRoom } from './harness.ts';

export async function runCommand(argv: string[], cfg: Config, deps: AgentDeps = {}): Promise<number> {
  const dd = argv.indexOf('--');
  const head = dd === -1 ? argv : argv.slice(0, dd);
  const task = dd === -1 ? '' : argv.slice(dd + 1).join(' ');
  const p = parseMulti(head, { valued: ['project'], bool: ['print'] });
  expectPositionals(p, 1, '`run <room-or-division> [--print] [-- <task>]`');
  const print = p.bools.has('print');
  if (print && task.trim() === '') throw new UsageError('--print needs a task: kubicle run <room> --print -- "<task>"');
  const { root, building, service, room } = loadRoom(p.positionals[0]!, p.flags, cfg);
  let spec;
  try {
    spec = prepareLaunch({
      home: cfg.home, claudeDir: cfg.claudeDir, building, blockers: service.launchBlockers(root, room.id),
      projectId: root, roomId: room.id, task, secrets: openSecrets(cfg.home), ...(print ? { print: true } : {}),
    });
  } catch (e) {
    if (e instanceof HarnessError) throw new CliError(e.problems.join('\n'));
    throw e;
  }
  for (const w of spec.warnings) console.error(`warning: ${w}`);
  return await agentMain(spec.id, cfg.home, deps);
}
