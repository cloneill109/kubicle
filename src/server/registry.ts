import { statSync } from 'node:fs';
import type { AgentEvent } from '../shared/events.ts';
import type { AgentStatus, AgentView, FeedItem, PendingApproval } from '../shared/protocol.ts';
import type { Config } from './config.ts';
import type { Projects } from './projects.ts';
import type { Store } from './store.ts';
import { nameFor } from './names.ts';

const BANNER = 'No hook events for 10 min. Are the hooks installed?';
const LOG_MAX = 20;
const DETAIL_MAX = 120;

const SHORT: Record<string, string> = {
  SessionStart: 'Session started',
  SessionEnd: 'Session ended',
  UserPromptSubmit: 'Prompt submitted',
  PreToolUse: 'Using a tool',
  PostToolUse: 'Tool finished',
  PostToolUseFailure: 'Tool failed',
  PermissionRequest: 'Needs permission',
  PermissionDenied: 'Permission denied',
  Notification: 'Notification',
  SubagentStart: 'Subagent started',
  SubagentStop: 'Subagent finished',
  Stop: 'Finished responding',
  StopFailure: 'Stopped with an error',
  CwdChanged: 'Changed directory',
};

function clip(s: string, max = DETAIL_MAX): string {
  const chars = Array.from(s.replace(/\s+/g, ' ').trim());
  return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('') + '…';
}

function defaultStat(p: string): number | null {
  try { return statSync(p).mtimeMs; } catch { return null; }
}

function snap(a: AgentView): AgentView {
  const c: AgentView = { ...a, log: [...a.log] };
  if (a.pending) c.pending = { ...a.pending };
  return c;
}

export class Registry {
  #projects: Projects;
  #store: Store;
  #cfg: Config;
  #stat: (p: string) => number | null;
  #agents = new Map<string, AgentView>();
  #transcripts = new Map<string, string>();
  #quietMtime = new Map<string, number | null>();
  #lastEventTs = 0;

  constructor(projects: Projects, store: Store, cfg: Config, statMtime?: (p: string) => number | null) {
    this.#projects = projects;
    this.#store = store;
    this.#cfg = cfg;
    this.#stat = statMtime ?? defaultStat;
  }

  get(id: string): AgentView | undefined {
    const a = this.#agents.get(id);
    return a && snap(a);
  }

  list(): AgentView[] {
    return [...this.#agents.values()].map(snap);
  }

  #effective(a: AgentView): 'off' | 'office' {
    const s = this.#store.getSessionApprovals(a.sessionId);
    if (s) return s;
    if (!a.projectId) return 'off';
    return this.#projects.list().find((p) => p.id === a.projectId)?.approvals ?? 'off';
  }

  #setCwd(a: AgentView, cwd: string, ts: number, touched: Set<AgentView>): void {
    a.cwd = cwd;
    const prev = a.projectId;
    a.projectId = this.#projects.resolve(cwd, ts).id;
    if (a.kind === 'session') {
      // Children that were unassigned (or followed the old project) follow the parent.
      for (const c of this.#agents.values()) {
        if (c.parentId === a.id && (c.projectId === '' || c.projectId === prev) && !c.cwd) {
          c.projectId = a.projectId;
          c.approvals = this.#effective(c);
          touched.add(c);
        }
      }
    }
    a.approvals = this.#effective(a);
  }

  #newAgent(e: AgentEvent, id: string, kind: 'session' | 'subagent', parent?: AgentView): AgentView {
    const a: AgentView = {
      id,
      sessionId: e.sessionId,
      kind,
      name: nameFor(id),
      role: kind === 'subagent' ? (e.agentType ?? 'general') : 'general',
      projectId: parent?.projectId ?? '',
      status: 'idle',
      activity: '',
      startedAt: e.ts,
      lastSeen: e.ts,
      approvals: 'off',
      log: [],
    };
    if (kind === 'subagent') {
      a.agentId = e.agentId!;
      a.parentId = parent!.id;
      if (parent!.cwd) a.cwd = parent!.cwd;
    }
    this.#agents.set(id, a);
    return a;
  }

  #pushLog(a: AgentView, line: string): void {
    if (!line || a.log[0] === line) return;
    a.log.unshift(line);
    if (a.log.length > LOG_MAX) a.log.length = LOG_MAX;
  }

  apply(e: AgentEvent): { changed: AgentView[]; removed: { id: string; reason: 'ended' }[]; feed: FeedItem | null } {
    if (e.ts > this.#lastEventTs) this.#lastEventTs = e.ts;
    const touched = new Set<AgentView>();
    const removed: { id: string; reason: 'ended' }[] = [];

    let session = this.#agents.get(e.sessionId);
    const sessionKnown = !!session;
    const isSubTarget = e.agentId !== undefined;

    // SessionEnd for an unknown session / SubagentStop for an unknown subagent: nothing to create.
    const subId = isSubTarget ? `${e.sessionId}:${e.agentId}` : undefined;
    const skipCreate =
      (e.event === 'SessionEnd' && !sessionKnown) ||
      (e.event === 'SubagentStop' && !(subId && this.#agents.has(subId)));

    if (!session && !skipCreate) {
      session = this.#newAgent(e, e.sessionId, 'session');
      touched.add(session);
    }

    let target: AgentView | undefined = session;
    if (subId && !skipCreate) {
      target = this.#agents.get(subId);
      if (!target) {
        // Subagent's own cwd (if any) is resolved below via the generic cwd handling.
        target = this.#newAgent(e, subId, 'subagent', session!);
        touched.add(target);
      }
    } else if (subId) {
      target = this.#agents.get(subId);
    }

    const feedName = target ? target.name : nameFor(subId ?? e.sessionId);

    if (target) {
      target.lastSeen = Math.max(target.lastSeen, e.ts);
      this.#quietMtime.delete(target.id);
      if (session && session !== target) session.lastSeen = Math.max(session.lastSeen, e.ts);
      if (e.model) target.model = e.model;
      if (e.transcriptPath) this.#transcripts.set(target.id, e.transcriptPath);
      if (e.cwd && (e.event === 'CwdChanged' || e.event === 'SessionStart' || !target.cwd || target.projectId === '')) {
        this.#setCwd(target, e.cwd, e.ts, touched);
      }
      touched.add(target);
    }

    const setStatus = (a: AgentView, s: AgentStatus) => { a.status = s; };

    if (target) {
      const t = target;
      const wasStale = t.status === 'quiet' || t.status === 'lost';
      switch (e.event) {
        case 'SessionStart':
          setStatus(t, 'idle');
          t.pending = undefined;
          break;
        case 'UserPromptSubmit':
          setStatus(t, 'working');
          t.pending = undefined;
          break;
        case 'PreToolUse':
          setStatus(t, 'working');
          t.activity = e.activity ?? e.toolName ?? '';
          this.#pushLog(t, t.activity);
          break;
        case 'PostToolUse':
        case 'PostToolUseFailure':
        case 'PermissionDenied':
          setStatus(t, 'working');
          if (t.pending && t.pending.toolName === (e.toolName ?? '')) t.pending = undefined;
          break;
        case 'PermissionRequest':
          // Always the newest request (M2): an earlier pending would show stale text. Approvals
          // upgrades this one to answerable when it actually waits for the owner.
          setStatus(t, 'waiting');
          t.pending = {
            id: e.id,
            toolName: e.toolName ?? '',
            activity: e.activity ?? e.toolName ?? '',
            since: e.ts,
            answerable: false,
          };
          if (e.toolInput !== undefined) t.pending.input = e.toolInput;
          if (e.toolInputTruncated) t.pending.inputTruncated = true;
          break;
        case 'Notification':
          if (e.notificationType === 'permission_prompt') {
            if (!t.pending) setStatus(t, 'waiting');
          } else if (e.notificationType === 'idle_prompt') {
            setStatus(t, 'idle');
            t.pending = undefined;
          } else if (wasStale) setStatus(t, 'idle');
          break;
        case 'Stop':
        case 'StopFailure':
          setStatus(t, 'idle');
          t.pending = undefined;
          break;
        case 'SubagentStart':
          if (t.kind === 'subagent') {
            setStatus(t, 'working');
            if (e.agentType) t.role = e.agentType;
            if (session && session !== t) {
              this.#pushLog(session, `Spawned ${e.agentType ?? 'general'}`);
              touched.add(session);
            }
          }
          break;
        case 'SubagentStop':
          if (t.kind === 'subagent') {
            this.#agents.delete(t.id);
            this.#transcripts.delete(t.id); this.#quietMtime.delete(t.id);
            touched.delete(t);
            removed.push({ id: t.id, reason: 'ended' });
          }
          break;
        case 'SessionEnd':
          for (const [id, a] of [...this.#agents]) {
            if (a.sessionId === e.sessionId) {
              this.#agents.delete(id);
              this.#transcripts.delete(id); this.#quietMtime.delete(id);
              touched.delete(a);
              removed.push({ id, reason: 'ended' });
            }
          }
          break;
        case 'CwdChanged':
          if (wasStale) setStatus(t, 'idle');
          break;
        default:
          if (wasStale) setStatus(t, 'idle');
      }
    }

    // Entering/staying in `waiting`: remember the transcript mtime so tick() can tell a prompt
    // still on screen (transcript unchanged, but events keep coming) from a closed terminal (R17).
    if (target && target.status === 'waiting' && this.#agents.has(target.id)) {
      this.#quietMtime.set(target.id, this.#mtime(target));
    }

    if (e.event === 'SessionEnd') {
      // Put the session itself first, matching the brief's expectation.
      removed.sort((a, b) => (a.id === e.sessionId ? -1 : b.id === e.sessionId ? 1 : 0));
    }

    for (const a of touched) a.approvals = this.#effective(a);

    let feed: FeedItem | null = null;
    if (e.event !== 'PostToolUse') {
      const detail = clip(e.activity ?? e.message ?? SHORT[e.event] ?? e.event);
      feed = { ts: e.ts, event: e.event, agentName: feedName, detail };
    }
    return { changed: [...touched].map(snap), removed, feed };
  }

  tick(now: number): { changed: AgentView[]; removed: { id: string; reason: 'expired' }[]; banner: string | null } {
    const changed: AgentView[] = [];
    const removed: { id: string; reason: 'expired' }[] = [];

    for (const a of [...this.#agents.values()]) {
      if (!this.#agents.has(a.id)) continue; // already cascaded
      const idle = now - a.lastSeen;
      if (idle > this.#cfg.expireMs) {
        for (const [id, x] of [...this.#agents]) {
          if (id === a.id || (a.kind === 'session' && x.parentId === a.id)) {
            this.#agents.delete(id);
            this.#transcripts.delete(id); this.#quietMtime.delete(id);
            removed.push({ id, reason: 'expired' });
          }
        }
        continue;
      }
      let next: AgentStatus = a.status;
      if ((a.status === 'quiet' || a.status === 'waiting') && idle > this.#cfg.lostMs) {
        // waiting ages like quiet (R17): a terminal closed at a permission prompt sends nothing more.
        const cur = this.#mtime(a);
        if (cur === null || (this.#quietMtime.has(a.id) && cur === this.#quietMtime.get(a.id))) next = 'lost';
        else this.#quietMtime.set(a.id, cur); // transcript still changing: alive
      } else if (a.status === 'working' && idle > this.#cfg.quietMs) {
        const cur = this.#mtime(a);
        if (idle > this.#cfg.lostMs && cur === null) next = 'lost';
        else { next = 'quiet'; this.#quietMtime.set(a.id, cur); }
      }
      if (next !== a.status) {
        a.status = next;
        if (next === 'lost') a.pending = undefined;
        changed.push(snap(a));
      }
    }

    const active = [...this.#agents.values()].some((a) => a.status === 'working' || a.status === 'quiet');
    const banner = active && now - this.#lastEventTs > this.#cfg.bannerMs ? BANNER : null;
    return { changed, removed, banner };
  }

  #mtime(a: AgentView): number | null {
    const p = this.#transcripts.get(a.id) ?? (a.parentId ? this.#transcripts.get(a.parentId) : undefined);
    return p ? this.#stat(p) : null;
  }

  setPending(agentId: string, p: PendingApproval | undefined): AgentView | undefined {
    const a = this.#agents.get(agentId);
    if (!a) return undefined;
    a.pending = p ? { ...p } : undefined;
    return snap(a);
  }

  /** The owner answered from the office: the prompt is gone and the agent carries on. */
  answered(agentId: string): AgentView | undefined {
    const a = this.#agents.get(agentId);
    if (!a) return undefined;
    a.pending = undefined;
    if (a.status === 'waiting') a.status = 'working';
    return snap(a);
  }

  refreshApprovals(): AgentView[] {
    const out: AgentView[] = [];
    for (const a of this.#agents.values()) {
      const m = this.#effective(a);
      if (m !== a.approvals) {
        a.approvals = m;
        out.push(snap(a));
      }
    }
    return out;
  }

  rebuild(events: AgentEvent[]): void {
    this.#agents.clear();
    this.#transcripts.clear();
    this.#quietMtime.clear();
    this.#lastEventTs = 0;
    const sorted = events.map((e, i) => ({ e, i })).sort((x, y) => x.e.ts - y.e.ts || x.i - y.i);
    for (const { e } of sorted) this.apply(e);
    for (const a of this.#agents.values()) {
      if (a.status === 'working') a.status = 'quiet';
      if (a.status === 'quiet') this.#quietMtime.set(a.id, this.#mtime(a));
    }
  }
}
