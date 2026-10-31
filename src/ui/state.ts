// Client mirror of the server's office state, fed by ServerMsg. Pure (no DOM) so it is unit-tested.
// apply() reports what changed so main.ts can drive the sim, the panel and needs-you alerts.
import type { AgentView, FeedItem, ProjectRow, ServerMsg } from '../shared/protocol.ts';

export const FEED_MAX = 200;
export const BASE_TITLE = 'Kubicle';

export interface Change {
  /** Agents added or updated (in message order). */
  upserted: AgentView[];
  /** Agents gone: by an agentRemoved message, or (reason 'expired') missing from a fresh snapshot. */
  removed: { view: AgentView; reason: 'ended' | 'expired' }[];
  /** Agents that just entered `waiting` (never on the first snapshot, never while staying waiting). */
  newlyWaiting: AgentView[];
  /** Agents with an answerable approval the client has not seen before (never on the first snapshot). */
  newlyAnswerable: AgentView[];
  projects: boolean;
  feed: FeedItem[];
  banner: boolean;
  snapshot: boolean;
  firstSnapshot: boolean;
}

const empty = (): Change => ({ upserted: [], removed: [], newlyWaiting: [], newlyAnswerable: [], projects: false, feed: [], banner: false, snapshot: false, firstSnapshot: false });

export class OfficeState {
  agents = new Map<string, AgentView>();
  projects: ProjectRow[] = [];
  feed: FeedItem[] = []; // newest first
  banner: string | null = null;
  #hadSnapshot = false;

  apply(m: ServerMsg): Change {
    const c = empty();
    switch (m.t) {
      case 'snapshot': {
        c.snapshot = true;
        c.firstSnapshot = !this.#hadSnapshot;
        const next = new Map(m.agents.map((a) => [a.id, a]));
        for (const [id, v] of this.agents) if (!next.has(id)) c.removed.push({ view: v, reason: 'expired' });
        for (const a of m.agents) {
          const prev = this.agents.get(a.id);
          if (this.#hadSnapshot && a.status === 'waiting' && prev?.status !== 'waiting') c.newlyWaiting.push(a);
          if (this.#hadSnapshot && isNewAnswerable(prev, a)) c.newlyAnswerable.push(a);
          c.upserted.push(a);
        }
        this.agents = next;
        c.projects = !sameProjects(this.projects, m.projects);
        this.projects = m.projects;
        this.feed = m.feed.slice(0, FEED_MAX);
        c.feed = this.feed;
        c.banner = this.banner !== m.banner;
        this.banner = m.banner;
        this.#hadSnapshot = true;
        break;
      }
      case 'agent': {
        const prev = this.agents.get(m.agent.id);
        if (m.agent.status === 'waiting' && prev?.status !== 'waiting') c.newlyWaiting.push(m.agent);
        if (isNewAnswerable(prev, m.agent)) c.newlyAnswerable.push(m.agent);
        this.agents.set(m.agent.id, m.agent);
        c.upserted.push(m.agent);
        break;
      }
      case 'agentRemoved': {
        const v = this.agents.get(m.id);
        if (v) { this.agents.delete(m.id); c.removed.push({ view: v, reason: m.reason }); }
        break;
      }
      case 'feed':
        this.feed.unshift(m.item);
        if (this.feed.length > FEED_MAX) this.feed.length = FEED_MAX;
        c.feed = [m.item];
        break;
      case 'projects':
        c.projects = !sameProjects(this.projects, m.projects);
        this.projects = m.projects;
        break;
      case 'banner':
        c.banner = this.banner !== m.text;
        this.banner = m.text;
        break;
    }
    return c;
  }

  counts(): { sessions: number; subagents: number; needYou: number } {
    let sessions = 0, subagents = 0, needYou = 0;
    for (const a of this.agents.values()) {
      if (a.kind === 'session') sessions++; else subagents++;
      if (a.status === 'waiting') needYou++;
    }
    return { sessions, subagents, needYou };
  }

  project(id: string): ProjectRow | undefined { return this.projects.find((p) => p.id === id); }
}

const answerableId = (a: AgentView | undefined): string | undefined => (a?.pending?.answerable ? a.pending.id : undefined);
function isNewAnswerable(prev: AgentView | undefined, next: AgentView): boolean {
  const id = answerableId(next);
  return id !== undefined && id !== answerableId(prev);
}

/** The agent the "need you" chip jumps to: oldest answerable approval, else the oldest waiting agent. */
export function pickNeedsYou(agents: Iterable<AgentView>): AgentView | undefined {
  let best: AgentView | undefined;
  let bestKey: [number, number] = [2, Infinity];
  for (const a of agents) {
    if (a.status !== 'waiting') continue;
    const key: [number, number] = [a.pending?.answerable ? 0 : 1, a.pending?.since ?? a.lastSeen];
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) { best = a; bestKey = key; }
  }
  return best;
}

/** A new answerable approval takes the inspector unless the current selection has one open. */
export function shouldAutoSelect(current: AgentView | undefined, incoming: AgentView): boolean {
  if (current?.id === incoming.id) return false;
  return !current?.pending?.answerable;
}

export function sameProjects(a: ProjectRow[], b: ProjectRow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.id === b[i].id && p.name === b[i].name && p.order === b[i].order && p.archived === b[i].archived && p.approvals === b[i].approvals);
}

export function titleFor(needYou: number): string {
  return needYou > 0 ? `(${needYou}) ${BASE_TITLE}` : BASE_TITLE;
}

/** Live (non-archived) projects (floors) in floor order. */
export function liveWings(projects: ProjectRow[]): ProjectRow[] {
  return projects.filter((p) => !p.archived).sort((a, b) => a.order - b.order);
}

/** Patch that moves a wing one place left (-1) or right (+1), or null at the end of the row. */
export function moveWing(projects: ProjectRow[], id: string, delta: -1 | 1): { order: number } | null {
  const live = liveWings(projects);
  const i = live.findIndex((p) => p.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= live.length) return null;
  return { order: live[j].order };
}
