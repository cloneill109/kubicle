/**
 * The PreToolUse guard's "ask" answer. The shim (bin/kubicle-hook) carries the same literal and
 * prints a `pre` response only when it equals this exactly (unit-tested for drift).
 */
export const GUARD_ASK = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Kubicle: pushes and merges to protected branches need the owner"}}';

export function guardResponse(): string {
  return GUARD_ASK;
}
