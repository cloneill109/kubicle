// Bubbles on the floor: a seated figure in the top-center coordinator room who says what he just
// decided ("Sending Wiry Otter to Front end") and draws a short-lived line to the agent he is
// delegating to. Driven by Bubbles' live log entries and the agents' `bubblesThinking` flag.
// View-only: nothing here answers or moves anything.
import type { AgentView, LogEntry } from '../shared/protocol.ts';
import type { Renderer, SimAgent, StyleId } from './render/types.ts';
import { COORDINATOR, COORDINATOR_COLOR, seatOf, type World } from './sim/world.ts';
import { describeTool } from '../shared/describe.ts';

const SAY_S = 3.5;      // how long one line stays up
const QUEUE_MAX = 3;    // older lines are dropped when decisions arrive faster than they can be read
const LINK_S = 3.5;     // delegation line lifetime
const FRESH_MS = 20_000; // ignore log rows older than this (a fetched backlog, not something happening now)

export interface Say { text: string; target?: string }

/**
 * The log row's `request` ("<Tool> <input JSON>", possibly redacted) in plain language, or '' if unreadable.
 * Ignores the agent's own `description`: what Bubbles approved is told from the command, not the label.
 */
export function requestText(request: string | undefined): string {
  const m = /^(\S+)\s+([\s\S]*)$/.exec(request ?? '');
  if (!m) return '';
  try {
    const input = JSON.parse(m[2]);
    if (input && typeof input === 'object') delete input.description;
    return describeTool(m[1], input);
  } catch { return ''; }
}

/** What Bubbles says about one log row on this floor, or null for rows he stays quiet about. Pure. */
export function sayFor(e: LogEntry, floor: string, agent: (id: string) => AgentView | undefined, roomName: (id: string) => string): Say | null {
  if (e.projectId !== floor || !e.sessionId) return null;
  const id = e.agentId ? `${e.sessionId}:${e.agentId}` : e.sessionId;
  const v = agent(id) ?? agent(e.sessionId);
  const name = v?.name ?? 'an agent';
  const target = v?.id;
  switch (e.kind) {
    case 'intake':
      if (e.outcome === 'briefed' && e.decision && e.sessionId.startsWith('launch-')) return { text: `Sending a new agent to ${roomName(e.decision)}`, target };
      if (e.outcome === 'fallback' && e.decision && e.sessionId.startsWith('launch-')) return { text: `That room can't start. The new agent goes to ${roomName(e.decision)}`, target };
      if (e.outcome === 'briefed' && e.decision) return { text: `Sending ${name} to ${roomName(e.decision)}`, target };
      return null;
    case 'triage':
      if (e.outcome === 'approved') return { text: `OK'd for ${name}: ${requestText(e.request) || 'a routine step'}`, target };
      return null; // escalations get their own 'escalation' row
    case 'escalation': return { text: `Checking ${name}'s request with you`, target };
    case 'guard': return e.outcome === 'ask' ? { text: `Holding ${name}'s push to a protected branch`, target } : null;
    default: return null;
  }
}

export class Coordinator {
  /** The figure, or null when the world has no coordinator room (edit mode). */
  agent: SimAgent | null = null;
  #queue: Say[] = [];
  #links: { target: string; until: number }[] = [];
  #thinkingShown = new Set<string>();

  place(world: World): void {
    const desk = world.furn.find((f) => f.room === COORDINATOR && f.type === 'bigdesk');
    if (!desk) { this.agent = null; this.#links = []; return; }
    const s = seatOf(desk);
    const prev = this.agent;
    this.agent = {
      view: prev?.view ?? { id: COORDINATOR, sessionId: COORDINATOR, kind: 'session', name: 'Bubbles', role: 'manager', projectId: '', status: 'working', activity: '', startedAt: 0, lastSeen: 0, approvals: 'office', log: [] },
      x: s.x, y: s.y, dir: 'up', walkPhase: 0, anim: 'seated', skin: '#e9b98f', hair: '#6b3f2a', alpha: 1,
      ...(prev?.bubble ? { bubble: prev.bubble } : {}),
    };
  }

  /** Forget queued lines and links (another floor is on screen). */
  reset(): void {
    this.#queue = []; this.#links = []; this.#thinkingShown.clear();
    if (this.agent) this.agent.bubble = undefined;
  }

  /** On duty (status 'working') or not ('quiet' draws the zzz). */
  setOnDuty(on: boolean): void {
    if (this.agent) this.agent.view = { ...this.agent.view, status: on ? 'working' : 'quiet' };
  }

  onLog(entries: LogEntry[], floor: string, agent: (id: string) => AgentView | undefined, roomName: (id: string) => string, nowMs = Date.now()): void {
    // Oldest first, so the queue reads in the order things happened.
    for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
      if (nowMs - e.ts > FRESH_MS) continue;
      const s = sayFor(e, floor, agent, roomName);
      if (s) this.#push(s);
    }
  }

  /** Per frame: start the next line when the current one is done; mention triage in progress. */
  step(now: number, floorAgents: SimAgent[]): void {
    const a = this.agent;
    if (!a) return;
    for (const x of floorAgents) {
      const id = x.view.id;
      if (x.view.bubblesThinking && !this.#thinkingShown.has(id)) { this.#thinkingShown.add(id); this.#push({ text: `Reviewing ${x.view.name}'s request…`, target: id }); }
      else if (!x.view.bubblesThinking) this.#thinkingShown.delete(id);
    }
    if (a.bubble && a.bubble.until <= now) a.bubble = undefined;
    if (!a.bubble && this.#queue.length) {
      const s = this.#queue.shift()!;
      a.bubble = { text: s.text, until: now + SAY_S };
      if (s.target) this.#links.push({ target: s.target, until: now + LINK_S });
    }
    this.#links = this.#links.filter((l) => l.until > now);
  }

  /** Dashed gold lines from Bubbles to whoever he is delegating to, with a dot running along each. */
  drawLinks(ctx: CanvasRenderingContext2D, R: Renderer, style: StyleId, floorAgents: SimAgent[], now: number): void {
    const a = this.agent;
    if (!a || !this.#links.length) return;
    const from = R.center(a);
    ctx.save();
    for (const l of this.#links) {
      const t = floorAgents.find((x) => x.view.id === l.target && x.anim !== 'leaving');
      if (!t) continue;
      const to = R.center(t), fade = Math.min(1, (l.until - now) / 0.6);
      ctx.globalAlpha = 0.85 * fade;
      ctx.strokeStyle = style === 'blueprint' ? '#ffe7a8' : COORDINATOR_COLOR;
      ctx.lineWidth = 2; ctx.setLineDash([6, 5]); ctx.lineDashOffset = -now * 30;
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      ctx.setLineDash([]);
      const k = (now * 0.8) % 1;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, 3.5, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  #push(s: Say): void {
    this.#queue.push(s);
    while (this.#queue.length > QUEUE_MAX) this.#queue.shift();
  }
}
