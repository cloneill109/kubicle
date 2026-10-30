// Inspector panel: who is selected, what they are doing, the approval box and routing toggles.
// Reads OfficeState; all writes go through post() with the CSRF header and same-origin cookie.
import type { AgentView } from '../shared/protocol.ts';
import type { SimAgent } from './render/types.ts';
import { ROLE, sprite } from './render/sprite.ts';
import type { OfficeState } from './state.ts';

export const LINK_TEXT = 'Started in a terminal. You can watch it and answer approvals here when routing is on.';
const STATUS_TEXT: Record<AgentView['status'], string> = { idle: 'Idle', working: 'Working', waiting: 'Needs you', quiet: 'Quiet', lost: 'Lost contact' };

export function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'X-Office-CSRF': '1' },
    body: JSON.stringify(body),
  });
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
  #state: OfficeState;
  #simAgents: () => SimAgent[];

  constructor(state: OfficeState, simAgents: () => SimAgent[]) {
    this.#state = state;
    this.#simAgents = simAgents;
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
    this.#logKey = '';
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
      const answerable = !!p && p.answerable;
      $('iPendingBtns').hidden = !answerable;
      const st = p ? this.#answers.get(p.id) : undefined;
      for (const b of ['approve', 'deny']) $<HTMLButtonElement>(b).disabled = !!st?.busy;
      setText($('iPendingNote'), answerable ? (st?.note ?? '') : 'Answer this in the terminal');
    }

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

    // ---- recent activity ----
    const logKey = v.log.slice(0, 8).join('\n');
    if (logKey !== this.#logKey) {
      this.#logKey = logKey;
      const ol = $('iLog');
      ol.replaceChildren(...(v.log.length ? v.log.slice(0, 8) : ['Nothing yet']).map((l) => { const li = document.createElement('li'); li.textContent = l; return li; }));
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
    const st = { busy: true, note: decision === 'allow' ? 'Approving…' : 'Denying…' };
    this.#answers.set(p.id, st);
    this.render(0);
    let note: string;
    try {
      const r = await post(`/api/approvals/${encodeURIComponent(p.id)}`, { decision });
      note = r.status === 204 ? (decision === 'allow' ? 'Approved. The session continues.' : 'Denied. The session was told no.')
        : r.status === 409 ? 'Too late: this request timed out and went to the terminal.'
        : r.status === 404 ? 'This request is no longer pending.'
        : `Could not send the answer (HTTP ${r.status}).`;
      st.busy = r.status === 204; // stays disabled until the server clears the prompt
    } catch {
      note = 'Could not reach the office server.';
      st.busy = false;
    }
    st.note = note;
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
