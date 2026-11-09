// What Kubicle needs to know from Claude's own user settings (<claudeDir>/settings.json). The launch and both previews
// (`kubicle harness resolve`, the room panel through Building.hooksProblem) use these, so they cannot disagree.
// Environment values in that file are never kept, returned or printed: only the variable names are looked at.
import { readFileSync } from 'node:fs';
import { STRIPPED_ENV } from '../bubbles/runner.ts';

function readSettings(file: string): Record<string, unknown> | null {
  let s: unknown;
  try { s = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  return s && typeof s === 'object' && !Array.isArray(s) ? s as Record<string, unknown> : null;
}

/** The installed Kubicle hook groups (other hooks dropped). Null when none. */
function kubicleHooks(claudeSettings: string): Record<string, unknown[]> | null {
  const hooks = readSettings(claudeSettings)?.hooks;
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

/** A clean room (inherit: false) needs Kubicle's hooks injected: them, or the reason the room cannot start. */
export function cleanRoomHooks(claudeSettings: string): { hooks: Record<string, unknown[]> | null; problem: string | null } {
  const hooks = kubicleHooks(claudeSettings);
  return { hooks, problem: hooks ? null : `Kubicle's hooks are not installed in ${claudeSettings}: run kubicle install-hooks` };
}

/**
 * An inherit: true session reads this file itself, so its `env` block is applied after Kubicle strips the environment.
 * The warning for one that could take the session off the subscription, or null. Names only.
 */
export function subscriptionWarning(claudeSettings: string): string | null {
  const env = readSettings(claudeSettings)?.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  const names = Object.keys(env).filter((k) => STRIPPED_ENV.test(k) && /^\w+$/.test(k));
  return names.length > 0 ? `Your Claude settings set ${names.join(', ')}, so this agent may not use your subscription.` : null;
}
