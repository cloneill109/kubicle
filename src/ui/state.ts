// Client mirror of the server's office state, fed by ServerMsg. Pure (no DOM) so it is unit-tested.
// apply() reports what changed so main.ts can drive the sim, the panel and needs-you alerts.
import type { AgentView, BubblesState, BubblesStatus, FeedItem, LogEntry, PendingChange, ProjectRow, ServerMsg } from '../shared/protocol.ts';
import type { Building } from '../shared/building.ts';

export const FEED_MAX = 200;
/** Bubbles log entries kept client-side (newest first). */
export const LOG_MAX = 500;
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
  /** The building (divisions, floors) was replaced by a snapshot or building message. */
  building: boolean;
  /** currentFloor changed on its own (automatic Lobby left, or the current floor's project vanished). */
  floor: boolean;
  feed: FeedItem[];
  banner: boolean;
  snapshot: boolean;
  firstSnapshot: boolean;
  /** Bubbles' state was replaced (snapshot or bubbles message). */
  bubbles: boolean;
  /** Log entries this message added (not seen before), newest first. */
  log: LogEntry[];
}

const empty = (): Change => ({ upserted: [], removed: [], newlyWaiting: [], newlyAnswerable: [], projects: false, building: false, floor: false, feed: [], banner: false, snapshot: false, firstSnapshot: false, bubbles: false, log: [] });

export const LOBBY = 'lobby';
export interface FloorItem { id: string; name: string; agents: number; needYou: number }

export class OfficeState {
  agents = new Map<string, AgentView>();
  projects: ProjectRow[] = [];
  feed: FeedItem[] = []; // newest first
  banner: string | null = null;
  building: Building = { divisions: [], floors: {}, overrides: {}, mcp: { revision: 0, servers: {} }, skills: [], importable: [], secretsSet: [], warnings: [], settings: { revision: 0, default_permission_mode: 'auto' } };
  /** Bubbles' last state (null until the first snapshot). */
  bubbles: BubblesState | null = null;
  /** Bubbles log entries seen live or fetched, newest first (by seq), at most LOG_MAX, no duplicate seq. */
  log: LogEntry[] = [];
  /** A project id, or 'lobby'. */
  currentFloor: string = LOBBY;
  #hadSnapshot = false;
  #preferred: string | null;
  /** The Lobby is showing only because nothing else was there yet; leave it once a floor has agents. */
  #autoLobby = true;

  constructor(opts: { preferredFloor?: string | null } = {}) {
    this.#preferred = opts.preferredFloor ?? null;
  }

  /** The owner picked a floor (or the Lobby): it sticks. */
  setFloor(id: string): void {
    this.currentFloor = id;
    this.#autoLobby = false;
  }

  apply(m: ServerMsg): Change {
    const c = this.#apply(m);
    const before = this.currentFloor;
    if (c.firstSnapshot) {
      const pref = this.#preferred;
      if (pref === LOBBY || (pref && this.project(pref))) this.setFloor(pref);
      else this.currentFloor = this.pickDefaultFloor();
    } else if (this.#hadSnapshot) {
      if (this.currentFloor !== LOBBY && !this.project(this.currentFloor)) this.currentFloor = LOBBY;
      else if (this.currentFloor === LOBBY && this.#autoLobby) this.currentFloor = this.pickDefaultFloor();
    }
    if (this.currentFloor !== LOBBY) this.#autoLobby = false;
    c.floor = !c.firstSnapshot && before !== this.currentFloor;
    return c;
  }

  /** The waiting agent's floor (as the "need you" chip would pick), else the most recently active floor, else the Lobby. */
  pickDefaultFloor(): string {
    const placed = [...this.agents.values()].filter((a) => a.projectId && this.project(a.projectId));
    const w = pickNeedsYou(placed);
    if (w) return w.projectId;
    let best: AgentView | undefined;
    for (const a of placed) if (!best || a.lastSeen > best.lastSeen) best = a;
    return best?.projectId ?? LOBBY;
  }

  /** Agents and needs-you per project id ('' = unassigned). */
  floorBadges(): Map<string, { agents: number; needYou: number }> {
    const m = new Map<string, { agents: number; needYou: number }>();
    for (const a of this.agents.values()) {
      const b = m.get(a.projectId) ?? { agents: 0, needYou: 0 };
      b.agents++;
      if (a.status === 'waiting') b.needYou++;
      m.set(a.projectId, b);
    }
    return m;
  }

  /** Picker rows: the Lobby (everyone), then live floors in order. */
  floorItems(): FloorItem[] {
    const b = this.floorBadges();
    const { needYou } = this.counts();
    return [
      { id: LOBBY, name: 'Lobby', agents: this.agents.size, needYou },
      ...liveFloors(this.projects).map((p) => ({ id: p.id, name: p.name, agents: b.get(p.id)?.agents ?? 0, needYou: b.get(p.id)?.needYou ?? 0 })),
    ];
  }

  /** Agents waiting on the owner on floors other than the current one (unassigned ones are on no floor). */
  othersNeedYou(): number {
    let n = 0;
    for (const [id, b] of this.floorBadges()) if (id && id !== this.currentFloor && this.project(id)) n += b.needYou;
    return n;
  }

  #apply(m: ServerMsg): Change {
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
        this.building = m.building;
        c.building = true;
        this.feed = m.feed.slice(0, FEED_MAX);
        c.feed = this.feed;
        c.banner = this.banner !== m.banner;
        this.banner = m.banner;
        this.bubbles = m.bubbles;
        c.bubbles = true;
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
      case 'building':
        this.building = m.building;
        c.building = true;
        break;
      case 'banner':
        c.banner = this.banner !== m.text;
        this.banner = m.text;
        break;
      case 'bubbles': {
        const { t: _t, ...rest } = m;
        this.bubbles = rest;
        c.bubbles = true;
        break;
      }
      case 'log':
        c.log = this.mergeLog([m.entry]);
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

  /** Adds log entries (live or from GET /api/log) by seq; returns the ones not seen before, newest first. */
  mergeLog(entries: LogEntry[]): LogEntry[] {
    const seen = new Set(this.log.map((e) => e.seq));
    const fresh = entries.filter((e) => Number.isFinite(e?.seq) && !seen.has(e.seq) && (seen.add(e.seq), true));
    if (!fresh.length) return [];
    this.log = [...fresh, ...this.log].sort((a, b) => b.seq - a.seq).slice(0, LOG_MAX);
    const kept = new Set(this.log.map((e) => e.seq));
    return fresh.filter((e) => kept.has(e.seq)).sort((a, b) => b.seq - a.seq);
  }
}

// ---------------------------------------------------------------- Bubbles helpers (pure)

/** Log filters as GET /api/log takes them (project, session, kind, grep). Empty = any. */
export interface LogFilter { project?: string; session?: string; kind?: string; grep?: string }

/** Whether a live entry belongs in a view filtered like this (mirrors the server's query: grep is a case-insensitive substring of the entry JSON). */
export function logMatches(e: LogEntry, f: LogFilter): boolean {
  if (f.project && e.projectId !== f.project) return false;
  if (f.session && e.sessionId !== f.session) return false;
  if (f.kind && e.kind !== f.kind) return false;
  if (f.grep) {
    const { seq: _s, prevHash: _p, hash: _h, ...body } = e;
    if (!JSON.stringify(body).toLowerCase().includes(f.grep.toLowerCase())) return false;
  }
  return true;
}

const STATUS_LABEL: Record<BubblesStatus['state'], string> = { on: 'On', off: 'Off', 'off-duty': 'Off duty', failing: 'Failing', unavailable: 'Unavailable' };
export const statusLabel = (s: BubblesStatus['state']): string => STATUS_LABEL[s] ?? s;

/** 30 min, 1 h, 1 d, 90 min… */
export function durationText(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m % 1440 === 0) return `${m / 1440} d`;
  if (m % 60 === 0) return `${m / 60} h`;
  return `${m} min`;
}

// C0/C1 controls other than tab and newline, and every format character (\p{Cf}: bidi overrides/isolates/marks as in
// Trojan Source, zero-width spaces/joiners, word joiner, BOM, soft hyphen, Unicode tags U+E0000-E007F), plus variation
// selectors: all of these hide or reorder text the owner reads while Bubbles still sees it.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\u{E0000}-\u{E007F}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

/** Agent/model/CLI-writable text for display: bidi and control characters removed. */
export const cleanText = (s: unknown): string => String(s ?? '').replace(UNSAFE, '');

/** Same characters, shown as visible <U+XXXX> tokens (for verbatim views: tool input, raw JSON). */
export const revealText = (s: unknown): string =>
  String(s ?? '').replace(UNSAFE, (ch) => `<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`);

const hhmm = (ts: number): string => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const usesText = (n: number | null, left: boolean): string =>
  n === null ? 'unlimited uses' : `${n} use${n === 1 ? '' : 's'}${left ? ' left' : ''}`;

/**
 * The exact change a CLI request proposes, in words (names via `projectName`). A revoke names its target
 * from `current` (the live grants and instructions), since its id alone says nothing to the owner.
 */
export function describeChange(c: PendingChange['change'], projectName: (id: string) => string, current?: Pick<BubblesState, 'grants' | 'instructions'> | null): string {
  // Revealed, not stripped: the owner confirms exactly the text Bubbles would read, hidden characters included.
  return revealText(describe(c, projectName, current));
}
function describe(c: PendingChange['change'], projectName: (id: string) => string, current?: Pick<BubblesState, 'grants' | 'instructions'> | null): string {
  switch (c.type) {
    case 'grant': {
      // Missing fields are what the server would apply: 1 use, 1 hour.
      const uses = c.uses === undefined ? 1 : c.uses;
      const ttl = typeof c.ttlMs === 'number' && Number.isFinite(c.ttlMs) ? c.ttlMs : 3_600_000;
      return `Grant: ${c.action} to ${c.branch ?? 'any protected branch'} in ${projectName(c.projectId)}, ${usesText(uses, false)}, for ${durationText(ttl)}`;
    }
    case 'instruction':
      return `Standing instruction (${c.projectId === null ? 'all projects' : projectName(c.projectId)}): ${c.text}`;
    case 'revoke': {
      if (c.target === 'grant') {
        const g = current?.grants.find((x) => x.id === c.id);
        if (!g) return `Revoke grant ${c.id} (no longer exists)`;
        return `Revoke grant: ${g.action} to ${g.branch ?? 'any protected branch'} in ${projectName(g.projectId)}, ${usesText(g.usesLeft, true)}, until ${hhmm(g.expiresAt)}`;
      }
      const i = current?.instructions.find((x) => x.id === c.id);
      if (!i) return `Revoke instruction ${c.id} (no longer exists)`;
      return `Revoke instruction (${i.projectId === null ? 'all projects' : projectName(i.projectId)}): "${i.text}"`;
    }
    case 'toggle':
      return `Turn Bubbles ${c.enabled ? 'on' : 'off'}`;
  }
  return 'Unknown change';
}

/** One line for a log entry: outcome · reason (or detail, or the request), display-safe. */
export function logSummary(e: LogEntry): string {
  const text = e.reason || e.detail || e.request || '';
  // An intake row leads with where Bubbles put the session and how sure it was.
  const placed = e.kind === 'intake' ? [e.decision, typeof e.confidence === 'number' ? e.confidence.toFixed(2) : ''] : [];
  return cleanText([...placed, e.outcome, text].filter(Boolean).join(' · '));
}

/** Inspector text for a session Bubbles placed: only when the owner has not picked a room themselves. */
export function placedByBubblesText(v: AgentView, roomName: (id: string) => string): string {
  if (!v.bubblesRoom || v.roomLabel) return '';
  return `${cleanText(roomName(v.bubblesRoom))} · placed by Bubbles`;
}

/** Inspector lines for Bubbles' intake note: suggested subagents as `[specialty] job`, then its questions. */
export function bubblesNoteLines(v: AgentView): { suggested: string[]; asks: string[] } {
  const n = v.bubblesNote;
  return {
    suggested: (n?.subagents ?? []).map((s) => `[${cleanText(s.specialty)}] ${cleanText(s.job)}`),
    asks: (n?.questions ?? []).map((q) => cleanText(q)),
  };
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
export function liveFloors(projects: ProjectRow[]): ProjectRow[] {
  return projects.filter((p) => !p.archived).sort((a, b) => a.order - b.order);
}

/** Patch that moves a floor one place up the list (-1) or down (+1), or null at the end. */
export function moveFloor(projects: ProjectRow[], id: string, delta: -1 | 1): { order: number } | null {
  const live = liveFloors(projects);
  const i = live.findIndex((p) => p.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= live.length) return null;
  return { order: live[j].order };
}
