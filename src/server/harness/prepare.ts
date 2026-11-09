// The one way a launch is prepared, for the office (server/main.ts) and `kubicle run`: refuse when a file the harness
// comes from is broken, then buildLaunch with the global default permission mode taken from the building's settings.
import { join } from 'node:path';
import type { Building } from '../../shared/building.ts';
import { HarnessError, buildLaunch, type LaunchSpec } from './resolve.ts';
import type { SecretStore } from './secrets.ts';

export function prepareLaunch(o: {
  home: string; claudeDir: string; building: Building;
  /** building.launchBlockers(projectId, roomId): files whose last good version is in use */
  blockers: string[];
  projectId: string; roomId: string; task: string; briefing?: string; id?: string; print?: boolean;
  /** Only `has` is ever asked: values are read by `kubicle agent`. */
  secrets: Pick<SecretStore, 'has'>;
}): LaunchSpec {
  if (o.blockers.length > 0) throw new HarnessError(o.blockers);
  return buildLaunch({
    home: o.home, claudeSettings: join(o.claudeDir, 'settings.json'), building: o.building,
    projectId: o.projectId, roomId: o.roomId, task: o.task, secrets: o.secrets,
    ...(o.briefing ? { briefing: o.briefing } : {}), ...(o.id ? { id: o.id } : {}), ...(o.print ? { print: true } : {}),
  });
}
