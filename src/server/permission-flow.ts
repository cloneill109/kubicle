// The permission flow: hard rules -> Bubbles triage -> the owner (office if a browser tab is connected, else the
// terminal). Plus the PreToolUse guard that forces a prompt on protected-branch pushes/merges in EVERY session.
//
// Guard: synchronous, never calls the model, answers before ingest. Fails open (returns "no ask") on an internal
// error, matching the shim, which also stays silent on any failure. Only Bash and MCP tool calls can be pushes or
// merges, so every other tool call returns before any file read.
// Log ordering: every log.append here runs outside any other transaction (append opens BEGIN IMMEDIATE itself).
import type { AgentEvent } from '../shared/events.ts';
import type { AgentView } from '../shared/protocol.ts';
import type { Approvals, BubblesNote, Decision } from './approvals.ts';
import type { BubblesConfig } from './bubbles/config.ts';
import type { BubblesLog, LogEntry } from './bubbles/log.ts';
import type { Policy } from './bubbles/policy.ts';
import { branchInfo, grantMatches, protectedAction, type BranchInfo, type Protected, type RulesCtx } from './bubbles/rules.ts';
import type { Bubbles, EscalateWhy, TriageOutcome, TriageRequest } from './bubbles/triage.ts';
import { projectRoot } from './projects.ts';
import type { Registry } from './registry.ts';

/**
 * The PreToolUse guard's "ask" answer. The shim (bin/kubicle-hook) carries the same literal and
 * prints a `pre` response only when it equals this exactly (unit-tested for drift).
 */
export const GUARD_ASK = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Kubicle: pushes and merges to protected branches need the owner"}}';

export function guardResponse(): string {
  return GUARD_ASK;
}

/** How long a guard-granted tool call is remembered, so its PermissionRequest is not re-treated as protected. */
export const GRANTED_TTL_MS = 10 * 60_000;
const GRANTED_MAX = 1000;

const WHY_TEXT: Record<EscalateWhy, string> = {
  protected: 'protected action', self: 'changes Kubicle itself', script: 'runs a script (strict mode)',
  truncated: 'input too long to review', off: 'Bubbles is off', cap: 'daily call cap reached', usage: 'usage limit reached',
  failing: 'Bubbles is failing', unavailable: 'claude CLI not available', 'low-confidence': 'not confident enough',
  escalated: 'Bubbles asked the owner', error: 'triage failed',
};

export interface FlowDeps {
  registry: Registry;
  approvals: Approvals;
  policy: Policy;
  log: BubblesLog;
  bubbles: Pick<Bubbles, 'triage'>;
  config: () => BubblesConfig;
  home: string;
  /** Kubicle's TCP port: local write requests to it count as self-administration. */
  port: number;
  uiConnected: () => boolean;
  projectName: (id: string) => string;
  /** An agent view changed (thinking flag, pending): broadcast it. */
  onAgent: (a: AgentView) => void;
  now?: () => number;
  onError?: (msg: string) => void;
}

export interface DecideOpts {
  /** Only a shim run as `kubicle-hook <max> perm` can deliver a decision (I1). */
  canDeliver: boolean;
  /** The hook caller went away: nothing can receive an answer, so never start an office wait. */
  gone: () => boolean;
  /** The original (uncapped) tool_input object; parsed from e.toolInput if absent. */
  input?: unknown;
}

const keyOf = (e: AgentEvent) => (e.agentId !== undefined ? `${e.sessionId}:${e.agentId}` : e.sessionId);

function inputOf(e: AgentEvent, raw: unknown): unknown {
  if (raw !== undefined) return raw;
  if (e.toolInput === undefined || e.toolInputTruncated) return undefined;
  try { return JSON.parse(e.toolInput); } catch { return undefined; }
}

export class PermissionFlow {
  private d: FlowDeps;
  private now: () => number;
  /** toolUseId (or a call fingerprint) -> expiry: tool calls the guard let through on a grant. */
  private granted = new Map<string, number>();

  constructor(deps: FlowDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
  }

  private ctx(cwd: string | undefined): RulesCtx {
    const cfg = this.d.config();
    const branches: BranchInfo = cwd
      ? branchInfo(cwd, cfg.protectedBranches)
      : { protected: new Set(['main', 'master', ...cfg.protectedBranches]), current: null };
    return { ...(cwd ? { cwd } : {}), branches, home: this.d.home, strictScripts: cfg.strictScripts, kubiclePort: this.d.port };
  }

  private projectOf(e: AgentEvent, agent: AgentView | undefined): string {
    if (e.cwd) return projectRoot(e.cwd);
    return agent?.projectId ?? '';
  }

  /** Keys a granted call by toolUseId and by a fingerprint (in case the PermissionRequest lacks the id). */
  private grantKeys(e: AgentEvent, input: unknown): string[] {
    const keys: string[] = [];
    if (e.toolUseId) keys.push(`id\n${e.toolUseId}`);
    let json = '';
    try { json = JSON.stringify(input) ?? ''; } catch { /* unkeyable */ }
    if (json) keys.push(`fp\n${keyOf(e)}\n${e.toolName ?? ''}\n${json}`);
    return keys;
  }

  private rememberGranted(e: AgentEvent, input: unknown): void {
    const now = this.now();
    for (const [k, exp] of this.granted) if (exp <= now) this.granted.delete(k);
    while (this.granted.size >= GRANTED_MAX) this.granted.delete(this.granted.keys().next().value!);
    for (const k of this.grantKeys(e, input)) this.granted.set(k, now + GRANTED_TTL_MS);
  }

  /** True (and forgets it) when the guard already let this exact tool call through on a grant. */
  private takeGranted(e: AgentEvent, input: unknown): boolean {
    const now = this.now();
    const keys = this.grantKeys(e, input);
    const hit = keys.some((k) => (this.granted.get(k) ?? 0) > now);
    if (hit) for (const k of keys) this.granted.delete(k);
    return hit;
  }

  private append(e: Omit<LogEntry, 'seq' | 'prevHash' | 'hash'>): LogEntry | null {
    try { return this.d.log.append(e); } catch (err) {
      this.d.onError?.(`bubbles log append failed: ${String(err)}`);
      return null;
    }
  }

  private who(e: AgentEvent, projectId: string) {
    return {
      projectId, sessionId: e.sessionId, ...(e.agentId ? { agentId: e.agentId } : {}), ...(e.agentType ? { agentType: e.agentType } : {}),
      ...(e.toolUseId ? { toolUseId: e.toolUseId } : {}), ...(e.transcriptPath ? { transcriptPath: e.transcriptPath } : {}),
      request: `${e.toolName ?? ''} ${e.toolInput ?? e.activity ?? ''}`,
    };
  }

  /** PreToolUse: true = answer GUARD_ASK. Push/merge to a protected branch with no matching grant. */
  guard(e: AgentEvent, rawInput?: unknown): boolean {
    try {
      const tool = e.toolName;
      if (!tool || (tool !== 'Bash' && !tool.startsWith('mcp__'))) return false;
      const agent = this.d.registry.get(keyOf(e));
      const input = inputOf(e, rawInput);
      const p = protectedAction(tool, input, this.ctx(e.cwd ?? agent?.cwd));
      if (!p || (p.kind !== 'push' && p.kind !== 'merge')) return false;
      const projectId = this.projectOf(e, agent);
      const now = this.now();
      const g = grantMatches(p, projectId, this.d.policy.grants(now), now);
      if (g) {
        this.d.policy.useGrant(g.id);
        this.rememberGranted(e, input);
        this.append({ ts: now, kind: 'guard', ...this.who(e, projectId), outcome: 'granted', reason: p.reason, detail: `grant ${g.id}` });
        return false;
      }
      this.append({ ts: now, kind: 'guard', ...this.who(e, projectId), outcome: 'ask', reason: p.reason });
      return true;
    } catch (err) {
      this.d.onError?.(`guard failed: ${String(err)}`);
      this.append({ ts: this.now(), kind: 'error', sessionId: e.sessionId, outcome: 'guard-failed-open', detail: `guard: ${err instanceof Error ? err.message : String(err)}` });
      return false;
    }
  }

  /** PermissionRequest: 'allow' | 'deny' from Bubbles or the office, or null = the terminal prompt. */
  async decide(e: AgentEvent, opts: DecideOpts): Promise<Decision | null> {
    const id = keyOf(e);
    const agent = this.d.registry.get(id);
    if (!agent || agent.approvals === 'off' || !opts.canDeliver) return null;

    const input = inputOf(e, opts.input);
    const cwd = e.cwd ?? agent.cwd;
    let hit: Protected | null = protectedAction(e.toolName ?? '', input, this.ctx(cwd));
    if (hit && (hit.kind === 'push' || hit.kind === 'merge') && this.takeGranted(e, input)) hit = null;

    const req: TriageRequest = {
      toolName: e.toolName ?? '',
      input: e.toolInput ?? '',
      inputTruncated: e.toolInputTruncated === true,
      projectId: agent.projectId,
      projectName: this.d.projectName(agent.projectId),
      ...(agent.roomLabel ?? agent.room ? { room: agent.roomLabel ?? agent.room } : {}),
      ...(cwd ? { cwd } : {}),
      ...(e.transcriptPath ? { transcriptPath: e.transcriptPath } : {}),
      sessionId: e.sessionId,
      ...(e.agentId ? { agentId: e.agentId } : {}),
    };

    this.setThinking(id, true);
    let out: TriageOutcome | null = null;
    try {
      out = await this.d.bubbles.triage(req, hit);
    } catch (err) {
      // Only a log write failure throws out of triage: escalate.
      this.d.onError?.(`triage failed: ${String(err)}`);
    } finally {
      this.setThinking(id, false);
    }

    const now = this.d.registry.get(id);
    if (out?.approve && now && now.approvals !== 'off') {
      if (now.pending?.id === e.id) { const v = this.d.registry.answered(id); if (v) this.d.onAgent(v); }
      return 'allow';
    }

    const why: EscalateWhy = out && !out.approve ? out.why : now?.approvals === 'off' ? 'off' : 'error';
    const note: BubblesNote = {
      why,
      reason: out?.verdict?.reason ?? (why === 'protected' || why === 'self' || why === 'script' ? hit?.reason : undefined) ?? WHY_TEXT[why],
      ...(out?.verdict?.recommendation_for_owner ? { recommendation: out.verdict.recommendation_for_owner } : {}),
    };
    const esc = this.append({
      ts: this.now(), kind: 'escalation', ...this.who(e, agent.projectId), outcome: why, reason: note.reason,
      ...(out ? { ref: out.logSeq } : {}), ...(note.recommendation ? { detail: note.recommendation } : {}),
    });

    let decision: Decision | null = null;
    let detail: string;
    if (opts.gone()) detail = 'hook caller gone';
    else if (!this.d.uiConnected()) detail = 'no office open';
    else if (!now || now.approvals === 'off') detail = 'approvals off';
    else { detail = ''; decision = await this.d.approvals.request(e, note); }
    if (detail) {
      // No office wait: keep the (unanswerable) card, with why, for anyone who opens the office later.
      const cur = this.d.registry.get(id);
      if (cur?.pending?.id === e.id) {
        const v = this.d.registry.setPending(id, { ...cur.pending, answerable: false, bubbles: note });
        if (v) this.d.onAgent(v);
      }
    }
    this.append({
      ts: this.now(), kind: 'owner-answer', ...this.who(e, agent.projectId), outcome: decision ?? 'terminal',
      ...(esc ? { ref: esc.seq } : {}), ...(detail ? { detail } : decision ? { detail: 'answered in the office' } : { detail: 'fell to the terminal' }),
    });
    return decision;
  }

  private setThinking(id: string, on: boolean): void {
    const v = this.d.registry.setThinking(id, on);
    if (v) this.d.onAgent(v);
  }
}
