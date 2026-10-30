import type { AgentEvent } from '../shared/events.ts';
import type { AgentView } from '../shared/protocol.ts';
import type { Config } from './config.ts';
import type { Registry } from './registry.ts';

export type Decision = 'allow' | 'deny';

const RESOLVED_MAX = 500;

interface Waiter {
  id: string;
  agentId: string;
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

  request(e: AgentEvent): Promise<Decision | null> {
    const agentId = e.agentId ? `${e.sessionId}:${e.agentId}` : e.sessionId;
    const agent = this.#registry.get(agentId);
    if (!agent || agent.approvals === 'off' || !this.#uiConnected()) return Promise.resolve(null);

    const prev = this.#byAgent.get(agentId);
    if (prev) this.#settle(prev, null); // superseded; new pending replaces below

    const id = globalThis.crypto.randomUUID();
    const base = {
      id,
      toolName: e.toolName ?? agent.pending?.toolName ?? '',
      activity: e.activity ?? agent.pending?.activity ?? '',
      since: agent.pending?.since ?? e.ts,
    };
    return new Promise<Decision | null>((resolve) => {
      const w: Waiter = {
        id,
        agentId,
        resolve,
        timer: setTimeout(() => {
          if (!this.#settle(w, null)) return;
          const v = this.#registry.setPending(agentId, { ...base, answerable: false });
          if (v) this.#onChange(v);
        }, this.#cfg.approvalWaitMs),
      };
      this.#waiting.set(id, w);
      this.#byAgent.set(agentId, w);
      const v = this.#registry.setPending(agentId, { ...base, answerable: true });
      if (v) this.#onChange(v);
    });
  }

  answer(approvalId: string, d: Decision): 'ok' | 'not-found' | 'expired' {
    const w = this.#waiting.get(approvalId);
    if (!w) return this.#resolved.has(approvalId) ? 'expired' : 'not-found';
    this.#settle(w, d);
    const v = this.#registry.setPending(w.agentId, undefined);
    if (v) this.#onChange(v);
    return 'ok';
  }

  cancelFor(agentId: string): void {
    const w = this.#byAgent.get(agentId);
    if (!w) return;
    this.#settle(w, null);
    const v = this.#registry.setPending(agentId, undefined);
    if (v) this.#onChange(v);
  }
}
