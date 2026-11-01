// Inspector panel: who is selected, what they are doing, the approval box and routing toggles.
// Reads OfficeState; all writes go through post() with the CSRF header and same-origin cookie.
import type { AgentView, LogEntry } from '../shared/protocol.ts';
import type { SimAgent } from './render/types.ts';
import { ROLE, sprite } from './render/sprite.ts';
import { cleanText, logSummary, revealText, type OfficeState } from './state.ts';

export const LINK_TEXT = 'Started in a terminal. You can watch it and answer approvals here when routing is on.';
export const TOO_LONG_TEXT = 'Too long to review here — answer in the terminal.';
export const PROTECTED_TEXT = 'Protected branch — only you can approve this.';
const BUB_LOG_MAX = 20;
const STATUS_TEXT: Record<AgentView['status'], string> = { idle: 'Idle', working: 'Working', waiting: 'Needs you', quiet: 'Quiet', lost: 'Lost contact' };

export function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'X-Kubicle-CSRF': '1' },
    body: JSON.stringify(body),
  });
}

/** Owner read API (GET /api/bubbles, /api/log): same-origin cookie plus the CSRF header, like the writes. */
export function getApi(path: string): Promise<Response> {
  return fetch(path, { credentials: 'same-origin', headers: { 'X-Kubicle-CSRF': '1' } });
}

export const roleLabel = (role: string) => ROLE[role]?.label ?? role;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function setText(el: HTMLElement, text: string): void { if (el.textContent !== text) el.textContent = text; }

export class Inspector {
  selectedId: string | undefined;
  #left: string | null = null; // name of the selected agent after it left
  #answers = new Map<string, { busy: boolean; note: string }>(); // per approval id
  #routeBusy = { session: false, project: false };
  #routeNote = '';
  #logKey = '';
  #roomBusy = false;
  #roomNote = '';
  #roomKey = '';
  /** Bubbles' log entries for the selected agent's session (GET /api/log?session=…, then live), newest first. */
  #bub: { session: string; entries: LogEntry[]; loaded: boolean } = { session: '', entries: [], loaded: false };
  #bubKey = '';
  #state: OfficeState;
  #simAgents: () => SimAgent[];
  #rooms: (projectId: string) => { id: string; name: string }[];

  constructor(state: OfficeState, simAgents: () => SimAgent[], rooms: (projectId: string) => { id: string; name: string }[] = () => []) {
    this.#state = state;
    this.#simAgents = simAgents;
    this.#rooms = rooms;
    $<HTMLSelectElement>('iRoom').addEventListener('change', (e) => void this.#moveRoom((e.target as HTMLSelectElement).value));
    $('approve').addEventListener('click', () => void this.#answer('allow'));
    $('deny').addEventListener('click', () => void this.#answer('deny'));
    $<HTMLInputElement>('routeSession').addEventListener('change', (e) => void this.#route('session', (e.target as HTMLInputElement).checked));
    $<HTMLInputElement>('routeProject').addEventListener('change', (e) => void this.#route('project', (e.target as HTMLInputElement).checked));
  }

  select(id: string | undefined): void {
    if (id === this.selectedId && !this.#left) return;
    this.selectedId = id;
    this.#left = null;
    this.#routeNote = '';
    this.#roomNote = '';
    this.#logKey = '';
    this.#loadBubbles();
    this.render(0);
  }

  /** Fetches the selected agent's session entries from Bubbles' log (newest 20). */
  #loadBubbles(): void {
    const v = this.selectedId ? this.#state.agents.get(this.selectedId) : undefined;
    const session = v?.sessionId ?? '';
    if (session === this.#bub.session) return;
    this.#bub = { session, entries: [], loaded: false };
    this.#bubKey = '';
    if (!session) return;
    const want = this.#bub;
    void getApi(`/api/log?session=${encodeURIComponent(session)}&limit=${BUB_LOG_MAX}`)
      .then(async (r) => (r.ok ? await r.json() as LogEntry[] : []))
      .catch(() => [] as LogEntry[])
      .then((rows) => {
        if (this.#bub !== want) return; // the selection moved on
        this.#mergeBubbles(rows);
        want.loaded = true;
        this.render(0);
      });
  }

  #mergeBubbles(rows: LogEntry[]): void {
    const seen = new Set(this.#bub.entries.map((e) => e.seq));
    const add = rows.filter((e) => e.sessionId === this.#bub.session && !seen.has(e.seq));
    if (add.length) this.#bub.entries = [...add, ...this.#bub.entries].sort((a, b) => b.seq - a.seq).slice(0, BUB_LOG_MAX * 5);
  }

  /** Live log entries: keep the selected session's Bubbles section current. */
  onLog(fresh: LogEntry[]): void {
    if (!this.#bub.session || !fresh.some((e) => e.sessionId === this.#bub.session)) return;
    this.#mergeBubbles(fresh);
    this.render(0);
  }

  /** Called when an agent leaves; the selected one turns into a short "left the office" note. */
  agentLeft(v: AgentView): void {
    if (v.id === this.selectedId) { this.#left = v.name; this.render(0); }
  }

  render(now: number): void {
    const insp = $('inspector');
    const v = this.selectedId && !this.#left ? this.#state.agents.get(this.selectedId) : undefined;
    insp.dataset.agent = v ? v.id : '';
    $('iBody').hidden = !v;
    $('iEmpty').hidden = !!v;
    if (!v) {
      setText($('iEmptyTitle'), this.#left ? `${this.#left} left the office` : 'Nobody selected');
      setText($('iEmptyText'), this.#left ? 'Their session ended. Click someone else on the floor.' : 'Click someone on the floor to see what they are doing.');
      return;
    }
    const parent = v.parentId ? this.#state.agents.get(v.parentId) : undefined;
    const project = v.projectId ? this.#state.project(v.projectId) : undefined;
    const where = project ? (project.archived ? `${project.name} (archived)` : project.name) : 'no project yet';
    setText($('iName'), v.name);
    setText($('iRole'), `${v.kind === 'subagent' ? `${roleLabel(v.role)} subagent of ${parent?.name ?? 'a session'}` : roleLabel(v.role)} · ${where}`);
    const pill = $('iStatus');
    setText(pill, STATUS_TEXT[v.status] ?? v.status);
    pill.dataset.s = v.status;

    // ---- pending approval ----
    const box = $('iPending');
    const waitingNoPending = v.status === 'waiting' && !v.pending;
    box.hidden = !v.pending && !waitingNoPending;
    if (v.pending || waitingNoPending) {
      const p = v.pending;
      setText($('iPendingCmd'), p ? (p.activity || p.toolName || 'a tool call') : (v.activity || 'a permission prompt'));
      // The whole input, exactly as the agent sent it (C1). Agent-provided: textContent only.
      const pre = $('iPendingInput');
      pre.hidden = !p?.input;
      setText(pre, revealText(p?.input)); // bidi/control characters shown as <U+XXXX>, never acted on
      const answerable = !!p && p.answerable;
      const tooLong = !!p?.inputTruncated;
      $('iPendingBtns').hidden = !answerable;
      const st = p ? this.#answers.get(p.id) : undefined;
      $<HTMLButtonElement>('approve').disabled = !!st?.busy || tooLong;
      $<HTMLButtonElement>('deny').disabled = !!st?.busy;
      setText($('iPendingNote'), !answerable ? 'Answer this in the terminal'
        : st?.note ?? (tooLong ? TOO_LONG_TEXT : ''));
      // Why Bubbles handed it over (model text: textContent only).
      const nb = p?.bubbles;
      $('iBubbles').hidden = !nb;
      setText($('iBubblesReason'), nb ? `Bubbles: ${cleanText(nb.reason)}` : '');
      $('iBubblesRec').hidden = !nb?.recommendation;
      setText($('iBubblesRec'), nb?.recommendation ? `Recommends: ${cleanText(nb.recommendation)}` : '');
      $('iBubblesProtected').hidden = nb?.why !== 'protected';
    }
    $('iBubblesThinking').hidden = !v.bubblesThinking;

    // ---- facts ----
    setText($('iTask'), v.kind === 'subagent'
      ? `${roleLabel(v.role)} subagent working for ${parent?.name ?? 'its session'}`
      : v.cwd ? `Claude Code session in ${v.cwd}` : 'Claude Code session (no folder reported yet)');
    setText($('iDoing'), v.activity || (v.status === 'idle' ? 'Waiting for a prompt' : '—'));
    setText($('iModel'), v.model ?? 'not reported yet');
    setText($('iConn'), LINK_TEXT);

    // ---- routing toggles ----
    const rs = $<HTMLInputElement>('routeSession'), rp = $<HTMLInputElement>('routeProject');
    if (!this.#routeBusy.session) rs.checked = v.approvals === 'office';
    rs.disabled = this.#routeBusy.session;
    if (!this.#routeBusy.project) rp.checked = project?.approvals === 'office';
    rp.disabled = this.#routeBusy.project || !project;
    setText($('routeNote'), this.#routeNote || (v.approvals === 'office'
      ? 'Permission prompts from this session show up here while this page is open.'
      : 'Off: permission prompts appear in the terminal as usual.'));

    // ---- move to room (sessions on a floor; subagents follow their parent) ----
    const row = $('iMoveRow');
    row.hidden = v.kind !== 'session' || !project;
    if (!row.hidden) {
      const sel = $<HTMLSelectElement>('iRoom');
      const rooms = this.#rooms(v.projectId);
      const key = v.projectId + '\n' + rooms.map((r) => `${r.id}=${r.name}`).join('\n');
      if (key !== this.#roomKey) {
        this.#roomKey = key;
        const opt = (value: string, text: string) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
        sel.replaceChildren(opt('', 'Automatic'), ...rooms.map((r) => opt(r.id, r.name)));
      }
      const want = v.roomLabel && rooms.some((r) => r.id === v.roomLabel) ? v.roomLabel : '';
      if (!this.#roomBusy && document.activeElement !== sel && sel.value !== want) sel.value = want;
      sel.disabled = this.#roomBusy;
      setText($('iRoomNote'), this.#roomNote);
    }

    // ---- recent activity ----
    const logKey = v.log.slice(0, 8).join('\n');
    if (logKey !== this.#logKey) {
      this.#logKey = logKey;
      const ol = $('iLog');
      ol.replaceChildren(...(v.log.length ? v.log.slice(0, 8) : ['Nothing yet']).map((l) => { const li = document.createElement('li'); li.textContent = l; return li; }));
    }

    // ---- Bubbles: this agent's entries in the log ----
    if (this.#bub.session !== v.sessionId) this.#loadBubbles();
    const mine = this.#bub.entries.filter((e) => (v.kind === 'subagent' ? e.agentId === v.agentId : true)).slice(0, BUB_LOG_MAX);
    const bubKey = `${this.#bub.loaded}|${mine.map((e) => e.seq).join()}`;
    if (bubKey !== this.#bubKey) {
      this.#bubKey = bubKey;
      const lines = mine.length ? mine.map((e) => `${new Date(e.ts).toLocaleTimeString([], { hour12: false })} ${e.kind}${logSummary(e) ? ` · ${logSummary(e)}` : ''}`)
        : [this.#bub.loaded ? 'Nothing from Bubbles for this agent yet' : 'Loading…'];
      $('iBubLog').replaceChildren(...lines.map((l) => { const li = document.createElement('li'); li.textContent = l; return li; }));
    }

    this.#avatar(v, now);
  }

  #avatar(v: AgentView, now: number): void {
    const c = $<HTMLCanvasElement>('avatar'), g = c.getContext('2d');
    if (!g) return;
    const agents = this.#simAgents();
    const sa = agents.find((a) => a.view.id === v.id);
    const a: SimAgent = { ...(sa ?? { x: 0, y: 0, walkPhase: 0, skin: '#e0ac85', hair: '#2b1d16', alpha: 1 }), view: v, dir: 'down', anim: 'standing', alpha: 1 };
    g.clearRect(0, 0, c.width, c.height);
    sprite(g, 6, 13, a, agents, now);
  }

  async #answer(decision: 'allow' | 'deny'): Promise<void> {
    const v = this.selectedId ? this.#state.agents.get(this.selectedId) : undefined;
    const p = v?.pending;
    if (!p || !p.answerable) return;
    if (decision === 'allow' && p.inputTruncated) return;
    const st = { busy: true, note: decision === 'allow' ? 'Approving…' : 'Denying…' };
    this.#answers.set(p.id, st);
    this.render(0);
    let note: string;
    try {
      const r = await post(`/api/approvals/${encodeURIComponent(p.id)}`, { decision });
      note = r.status === 204 ? (decision === 'allow' ? 'Approved. The session continues.' : 'Denied. The session was told no.')
        : r.status === 409 ? 'Too late: this request timed out and went to the terminal.'
        : r.status === 404 ? 'This request is no longer pending.'
        : r.status === 422 ? TOO_LONG_TEXT
        : `Could not send the answer (HTTP ${r.status}).`;
      st.busy = r.status === 204; // stays disabled until the server clears the prompt
    } catch {
      note = 'Could not reach the office server.';
      st.busy = false;
    }
    st.note = note;
    this.render(0);
  }

  async #moveRoom(room: string): Promise<void> {
    const v = this.selectedId ? this.#state.agents.get(this.selectedId) : undefined;
    if (!v || v.kind !== 'session') return;
    this.#roomBusy = true;
    this.#roomNote = '';
    this.render(0);
    try {
      const r = await post(`/api/agents/${encodeURIComponent(v.id)}/room`, { room: room || null });
      if (r.status !== 204) this.#roomNote = r.status === 400 ? 'That room is not on this floor any more.' : `Could not move them (HTTP ${r.status}).`;
    } catch {
      this.#roomNote = 'Could not reach the office server.';
    }
    this.#roomBusy = false;
    if (this.#roomNote) { const cur = this.selectedId ? this.#state.agents.get(this.selectedId) : undefined; $<HTMLSelectElement>('iRoom').value = cur?.roomLabel ?? ''; }
    this.render(0);
  }

  async #route(scope: 'session' | 'project', on: boolean): Promise<void> {
    const v = this.selectedId ? this.#state.agents.get(this.selectedId) : undefined;
    if (!v) return;
    const id = scope === 'session' ? v.sessionId : v.projectId;
    if (!id) return;
    this.#routeBusy[scope] = true;
    this.#routeNote = '';
    this.render(0);
    try {
      const r = await post('/api/approvals-mode', { scope, id, mode: on ? 'office' : 'off' });
      if (r.status !== 204) this.#routeNote = `Could not change routing (HTTP ${r.status}).`;
    } catch {
      this.#routeNote = 'Could not reach the office server.';
    }
    this.#routeBusy[scope] = false;
    this.render(0);
  }
}
