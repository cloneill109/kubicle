import type { AgentEvent } from '../shared/events.ts';
import type { AgentView } from '../shared/protocol.ts';
import type { Config } from './config.ts';
import type { Registry } from './registry.ts';

export type Decision = 'allow' | 'deny';

const RESOLVED_MAX = 500;

interface PendingBase { id: string; toolName: string; activity: string; since: number; input?: string; inputTruncated?: boolean }

interface Waiter {
  id: string;
  agentId: string;
  base: PendingBase;
  timer: ReturnType<typeof setTimeout>;
  resolve: (d: Decision | null) => void;
}

export function hookResponse(d: Decision | null): string {
  if (d === null) return '';
  const decision = d === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from Agent Office' };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

export class Approvals {
  #registry: Registry;
  #cfg: Config;
  #uiConnected: () => boolean;
  #onChange: (a: AgentView) => void;
  #waiting = new Map<string, Waiter>(); // approval id -> waiter
  #byAgent = new Map<string, Waiter>();
  #resolved = new Set<string>();

  constructor(registry: Registry, cfg: Config, uiConnected: () => boolean, onChange: (a: AgentView) => void) {
    this.#registry = registry;
    this.#cfg = cfg;
    this.#uiConnected = uiConnected;
    this.#onChange = onChange;
  }

  #remember(id: string): void {
    this.#resolved.add(id);
    if (this.#resolved.size > RESOLVED_MAX) {
      const oldest = this.#resolved.values().next().value;
      if (oldest !== undefined) this.#resolved.delete(oldest);
    }
  }

  // Remove a waiter and settle it. Returns false if it was already settled.
  #settle(w: Waiter, d: Decision | null): boolean {
    if (this.#waiting.get(w.id) !== w) return false;
    clearTimeout(w.timer);
    this.#waiting.delete(w.id);
    if (this.#byAgent.get(w.agentId) === w) this.#byAgent.delete(w.agentId);
    this.#remember(w.id);
    w.resolve(d);
    return true;
  }

  // Hand the prompt to the terminal: resolve null, keep pending but unanswerable.
  #release(w: Waiter): void {
    if (!this.#settle(w, null)) return;
    const v = this.#registry.setPending(w.agentId, { ...w.base, answerable: false });
    if (v) this.#onChange(v);
  }

  /** Hand one agent's in-flight wait (if any) to the terminal; pending stays, unanswerable. */
  release(agentId: string): void {
    const w = this.#byAgent.get(agentId);
    if (w) this.#release(w);
  }

  releaseAll(): void {
    for (const w of [...this.#waiting.values()]) this.#release(w);
  }

  request(e: AgentEvent): Promise<Decision | null> {
    const agentId = e.agentId ? `${e.sessionId}:${e.agentId}` : e.sessionId;
    const agent = this.#registry.get(agentId);
    if (!agent || agent.approvals === 'off' || !this.#uiConnected()) return Promise.resolve(null);

    const prev = this.#byAgent.get(agentId);
    if (prev) this.#settle(prev, null); // superseded; new pending replaces below

    const id = globalThis.crypto.randomUUID();
    const base: PendingBase = {
      id,
      toolName: e.toolName ?? agent.pending?.toolName ?? '',
      activity: e.activity ?? agent.pending?.activity ?? '',
      since: agent.pending?.since ?? e.ts,
    };
    if (e.toolInput !== undefined) base.input = e.toolInput;
    if (e.toolInputTruncated) base.inputTruncated = true;
    return new Promise<Decision | null>((resolve) => {
      const w: Waiter = {
        id,
        agentId,
        base,
        resolve,
        timer: setTimeout(() => this.#release(w), this.#cfg.approvalWaitMs),
      };
      this.#waiting.set(id, w);
      this.#byAgent.set(agentId, w);
      const v = this.#registry.setPending(agentId, { ...base, answerable: true });
      if (v) this.#onChange(v);
    });
  }

  answer(approvalId: string, d: Decision): 'ok' | 'not-found' | 'expired' | 'not-reviewable' {
    const w = this.#waiting.get(approvalId);
    if (!w) return this.#resolved.has(approvalId) ? 'expired' : 'not-found';
    // The owner could not see all of it here, so the office never approves it (C1). Deny is fine.
    if (d === 'allow' && w.base.inputTruncated) return 'not-reviewable';
    this.#settle(w, d);
    const v = this.#registry.answered(w.agentId);
    if (v) this.#onChange(v);
    return 'ok';
  }

  cancelFor(agentId: string, toolName?: string): void {
    const w = this.#byAgent.get(agentId);
    if (!w) return;
    if (toolName !== undefined && toolName !== w.base.toolName) return;
    this.#settle(w, null);
    const v = this.#registry.setPending(agentId, undefined);
    if (v) this.#onChange(v);
  }
}
