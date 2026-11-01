// Bubbles in the office: the Lobby card, the header status dot, and the Bubbles panel (#bubblesPanel,
// also opened by #bubbles): CLI requests waiting for the owner, standing instructions, grants, recent
// decisions and the on/off switch. Everything Bubbles, agents or the CLI wrote is set with textContent only.
import type { BubblesState, Grant, Instruction, LogEntry, PendingChange } from '../shared/protocol.ts';
import { sprite } from './render/sprite.ts';
import type { SimAgent } from './render/types.ts';
import { LOBBY, describeChange, liveFloors, logSummary, statusLabel, type OfficeState } from './state.ts';
import { getApi, post } from './panel.ts';

const RECENT = 20;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export const timeText = (ts: number): string => {
  const d = new Date(ts), today = new Date().toDateString() === d.toDateString();
  const t = d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return today ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
};
const untilText = (ts: number): string => {
  const d = new Date(ts), t = d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
  return new Date().toDateString() === d.toDateString() ? `until ${t}` : `until ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
};

/** Bubbles as a tiny pixel figure in coordinator gold, with a speech bubble. */
export function drawBubblesAvatar(c: HTMLCanvasElement): void {
  const g = c.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, c.width, c.height);
  const a = {
    view: { id: 'bubbles', sessionId: 'bubbles', kind: 'session', name: 'Bubbles', role: 'manager', projectId: '', status: 'working', activity: '', startedAt: 0, lastSeen: 0, approvals: 'office', log: [] },
    x: 0, y: 0, dir: 'down', walkPhase: 0, anim: 'standing', skin: '#e9b98f', hair: '#6b3f2a', alpha: 1,
  } as SimAgent;
  sprite(g, 4, 13, a, [a], 0);
  // speech bubble, top right
  g.fillStyle = '#fffdf6'; g.fillRect(9, 0, 5, 3); g.fillRect(9, 3, 1, 1);
  g.fillStyle = '#1d1b26'; g.fillRect(10, 1, 1, 1); g.fillRect(12, 1, 1, 1);
}

export interface BubblesUiOptions {
  projectName: (id: string) => string;
  onOpenLog: () => void;
}

type ItemState = { busy: boolean; msg: string };

export class BubblesUi {
  /** The Lobby card (placed by renderLobby above the floor list). */
  readonly card: HTMLButtonElement;
  #state: OfficeState;
  #o: BubblesUiOptions;
  #dlg: HTMLDialogElement;
  #opener: HTMLElement | null = null;
  #items = new Map<string, ItemState>(); // pending ids, grant/instruction ids
  #enabledBusy = false;
  #keys = { pending: '', instr: '', grants: '', recent: '', projects: '' };
  #tick: ReturnType<typeof setInterval> | null = null;

  constructor(state: OfficeState, o: BubblesUiOptions) {
    this.#state = state;
    this.#o = o;
    this.#dlg = $<HTMLDialogElement>('bubblesPanel');
    this.card = this.#makeCard();
    drawBubblesAvatar(this.#dlg.querySelector('canvas')!);
    $('bubblesDot').addEventListener('click', (e) => this.open(e.currentTarget as HTMLElement));
    $('bubblesClose').addEventListener('click', () => this.close());
    $('bubblesOpenLog').addEventListener('click', () => { this.close(false); this.#o.onOpenLog(); });
    this.#dlg.addEventListener('close', () => this.#closed());
    // A click on the backdrop (outside the panel box) closes it.
    this.#dlg.addEventListener('mousedown', (e) => { if (e.target === this.#dlg) { const r = this.#dlg.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) this.close(); } });
    $<HTMLInputElement>('bubblesEnabled').addEventListener('change', (e) => void this.#setEnabled((e.target as HTMLInputElement).checked));
    $('instrForm').addEventListener('submit', (e) => { e.preventDefault(); void this.#addInstruction(); });
    $('grantForm').addEventListener('submit', (e) => { e.preventDefault(); void this.#addGrant(); });
    this.render();
  }

  get isOpen(): boolean { return this.#dlg.open; }

  open(opener?: HTMLElement | null): void {
    if (this.#dlg.open) return;
    this.#opener = opener ?? (document.activeElement as HTMLElement | null);
    this.#keys = { pending: '', instr: '', grants: '', recent: '', projects: '' }; // fresh lists; forms default to the current floor
    this.#dlg.showModal();
    this.render();
    $('bubblesClose').focus();
    this.#tick = setInterval(() => this.render(), 30_000); // grants and CLI requests expire
    void this.#loadRecent();
  }

  close(restoreFocus = true): void {
    if (!this.#dlg.open) return;
    if (!restoreFocus) this.#opener = null;
    this.#dlg.close();
  }

  #closed(): void {
    if (this.#tick) clearInterval(this.#tick);
    this.#tick = null;
    if (location.hash === '#bubbles') history.replaceState(null, '', location.pathname + location.search);
    const o = this.#opener;
    this.#opener = null;
    if (o?.isConnected) o.focus();
    else if (o) $('bubblesDot').focus();
  }

  /** New log entries arrived: refresh the recent list. */
  onLog(_fresh: LogEntry[]): void { if (this.#dlg.open) this.#renderRecent(); }

  async #loadRecent(): Promise<void> {
    try {
      const r = await getApi(`/api/log?limit=${RECENT}`);
      if (!r.ok) return;
      this.#state.mergeLog(await r.json() as LogEntry[]);
      this.#renderRecent();
    } catch { /* offline: the live list stays */ }
  }

  // ---------------------------------------------------------------- render
  render(): void {
    const b = this.#state.bubbles;
    const st = b?.status;
    const label = st ? statusLabel(st.state) : 'Connecting…';
    const pending = b?.pending.length ?? 0;
    // header dot
    const dot = $('bubblesDot');
    dot.dataset.state = st?.state ?? '';
    const glow = dot.querySelector<HTMLElement>('.glow')!;
    glow.hidden = pending === 0;
    glow.textContent = String(pending);
    dot.setAttribute('aria-label', `Bubbles: ${label}${pending ? `, ${pending} waiting for you` : ''}. Open the Bubbles panel`);
    dot.title = st ? `Bubbles: ${label}. ${st.detail}` : 'Bubbles';
    // Lobby card
    this.card.dataset.state = st?.state ?? '';
    this.#set(this.card, '.bub-state', label);
    this.#set(this.card, '.bub-detail', st?.detail ?? 'Waiting for the office server.');
    this.#set(this.card, '.bub-calls', st ? `calls today ${st.callsToday} / ${st.cap}` : '');
    const cb = this.card.querySelector<HTMLElement>('.needbadge')!;
    cb.hidden = pending === 0;
    cb.textContent = `${pending} waiting for you`;
    this.card.setAttribute('aria-label', `Bubbles, ${label}. ${st?.detail ?? ''}${pending ? ` ${pending} waiting for you.` : ''} Open the Bubbles panel`);
    if (!this.#dlg.open) return;
    // panel
    $('bubStatus').dataset.state = st?.state ?? '';
    $('bubState').textContent = label;
    $('bubCalls').textContent = st ? `calls today ${st.callsToday} / ${st.cap}${st.thinking ? ` · looking at ${st.thinking} now` : ''}` : '';
    $('bubDetail').textContent = st?.detail ?? '';
    const sw = $<HTMLInputElement>('bubblesEnabled');
    if (!this.#enabledBusy) sw.checked = !!st && st.state !== 'off';
    sw.disabled = this.#enabledBusy || !st;
    this.#renderProjects();
    if (b) { this.#renderPending(b); this.#renderInstructions(b.instructions); this.#renderGrants(b.grants); }
    this.#renderRecent();
  }

  #set(root: HTMLElement, sel: string, text: string): void {
    const e = root.querySelector<HTMLElement>(sel)!;
    if (e.textContent !== text) e.textContent = text;
  }

  #makeCard(): HTMLButtonElement {
    const c = el('button', 'bub-card');
    c.type = 'button'; c.id = 'bubblesCard';
    c.setAttribute('aria-haspopup', 'dialog');
    const av = el('canvas', 'bub-avatar'); av.width = 14; av.height = 14; av.setAttribute('aria-hidden', 'true');
    drawBubblesAvatar(av);
    const main = el('span', 'bub-main');
    const name = el('span', 'bub-name', 'Bubbles');
    name.append(el('span', 'bub-role', 'Coordinator'));
    main.append(name, el('span', 'bub-detail'));
    const side = el('span', 'bub-side');
    const status = el('span', 'bub-status');
    const dot = el('i', 'dot'); dot.setAttribute('aria-hidden', 'true');
    status.append(dot, el('span', 'bub-state'));
    const badge = el('span', 'needbadge'); badge.hidden = true;
    side.append(status, el('span', 'bub-calls'), badge);
    c.append(av, main, side);
    c.addEventListener('click', () => this.open(c));
    return c;
  }

  /** Keeps focus on the same control (by data-key + class) across a list re-render. */
  #keepFocus(list: HTMLElement, draw: () => void): void {
    const f = document.activeElement as HTMLElement | null;
    const keep = f && list.contains(f) ? { key: f.closest<HTMLElement>('li')?.dataset.key, cls: f.className } : null;
    draw();
    if (!keep?.key) return;
    const li = [...list.querySelectorAll<HTMLElement>('li')].find((x) => x.dataset.key === keep.key);
    (li?.querySelector<HTMLElement>(`[class="${keep.cls}"]`) ?? list.closest('section')?.querySelector<HTMLElement>('h3'))?.focus();
  }

  #itemKey(id: string): string { const s = this.#items.get(id); return s ? `${s.busy}|${s.msg}` : ''; }

  #renderPending(b: BubblesState): void {
    const list = $('bubblesPending');
    const live = b.pending.filter((p) => p.createdAt + 15 * 60_000 > Date.now());
    const key = JSON.stringify([live.map((p) => [p.id, p.change, this.#itemKey(p.id)]), this.#state.projects.map((p) => p.name)]);
    if (key === this.#keys.pending) return;
    this.#keys.pending = key;
    this.#keepFocus(list, () => {
      if (!live.length) { list.replaceChildren(el('li', 'empty', 'Nothing waiting.')); return; }
      list.replaceChildren(...live.map((p) => this.#pendingLi(p)));
    });
  }

  #pendingLi(p: PendingChange): HTMLLIElement {
    const li = el('li', 'change'); li.dataset.key = p.id;
    const what = describeChange(p.change, this.#o.projectName);
    const st = this.#items.get(p.id);
    const mins = Math.max(1, Math.ceil((p.createdAt + 15 * 60_000 - Date.now()) / 60_000));
    li.append(el('p', 'what', what), el('p', 'meta', `From the command line at ${timeText(p.createdAt)} · expires in ${mins} min`));
    const row = el('div', 'btns');
    const yes = el('button', 'btn primary confirm', 'Confirm'); yes.type = 'button';
    yes.setAttribute('aria-label', `Confirm: ${what}`);
    const no = el('button', 'btn reject', 'Reject'); no.type = 'button';
    no.setAttribute('aria-label', `Reject: ${what}`);
    yes.disabled = no.disabled = !!st?.busy;
    yes.addEventListener('click', () => void this.#act(p.id, `/api/bubbles/pending/${encodeURIComponent(p.id)}`, { confirm: true }));
    no.addEventListener('click', () => void this.#act(p.id, `/api/bubbles/pending/${encodeURIComponent(p.id)}`, { confirm: false }));
    row.append(yes, no);
    li.append(row);
    if (st?.msg) { const m = el('p', 'bub-err', st.msg); m.setAttribute('role', 'alert'); li.append(m); }
    return li;
  }

  #renderInstructions(list0: Instruction[]): void {
    const list = $('bubblesInstructions');
    const key = JSON.stringify([list0.map((i) => [i.id, i.version, i.text, i.projectId, this.#itemKey(i.id)]), this.#state.projects.map((p) => p.name)]);
    if (key === this.#keys.instr) return;
    this.#keys.instr = key;
    this.#keepFocus(list, () => {
      if (!list0.length) { list.replaceChildren(el('li', 'empty', 'No standing instructions.')); return; }
      list.replaceChildren(...list0.map((i) => {
        const li = el('li', 'instr'); li.dataset.key = i.id;
        const scope = i.projectId === null ? 'All projects' : this.#o.projectName(i.projectId);
        const body = el('div', 'body');
        body.append(el('p', 'text', i.text), el('p', 'meta', `${scope} · v${i.version} · added ${timeText(i.createdAt)}`));
        li.append(body, this.#revokeBtn('instruction', i.id, `Revoke instruction: ${i.text.slice(0, 80)}`));
        const st = this.#items.get(i.id);
        if (st?.msg) { const m = el('p', 'bub-err', st.msg); m.setAttribute('role', 'alert'); li.append(m); }
        return li;
      }));
    });
  }

  #renderGrants(all: Grant[]): void {
    const list = $('bubblesGrants');
    const now = Date.now();
    const grants = all.filter((g) => g.revokedAt === null && g.expiresAt > now && (g.usesLeft === null || g.usesLeft > 0));
    const key = JSON.stringify([grants.map((g) => [g.id, g.usesLeft, g.expiresAt, this.#itemKey(g.id)]), this.#state.projects.map((p) => p.name)]);
    if (key === this.#keys.grants) return;
    this.#keys.grants = key;
    this.#keepFocus(list, () => {
      if (!grants.length) { list.replaceChildren(el('li', 'empty', 'No active grants. Protected pushes and merges always ask you.')); return; }
      list.replaceChildren(...grants.map((g) => {
        const li = el('li', 'grant'); li.dataset.key = g.id;
        const body = el('div', 'body');
        const what = el('p', 'text');
        what.append(el('b', '', g.action), ` to ${g.branch ?? 'any protected branch'} · ${this.#o.projectName(g.projectId)}`);
        const uses = g.usesLeft === null ? 'unlimited uses' : `${g.usesLeft} use${g.usesLeft === 1 ? '' : 's'} left`;
        body.append(what, el('p', 'meta', `${uses} · ${untilText(g.expiresAt)}`));
        li.append(body, this.#revokeBtn('grant', g.id, `Revoke grant: ${g.action} to ${g.branch ?? 'any protected branch'} in ${this.#o.projectName(g.projectId)}`));
        const st = this.#items.get(g.id);
        if (st?.msg) { const m = el('p', 'bub-err', st.msg); m.setAttribute('role', 'alert'); li.append(m); }
        return li;
      }));
    });
  }

  #revokeBtn(target: 'grant' | 'instruction', id: string, label: string): HTMLButtonElement {
    const b = el('button', 'btn revoke', 'Revoke'); b.type = 'button';
    b.setAttribute('aria-label', label);
    b.disabled = !!this.#items.get(id)?.busy;
    b.addEventListener('click', () => void this.#act(id, '/api/bubbles/revoke', { target, id }));
    return b;
  }

  #renderRecent(): void {
    const list = $('bubblesRecent');
    const recent = this.#state.log.slice(0, RECENT);
    const key = recent.map((e) => e.seq).join() + '|' + this.#state.projects.map((p) => p.name).join();
    if (key === this.#keys.recent) return;
    this.#keys.recent = key;
    if (!recent.length) { list.replaceChildren(el('li', 'empty', 'Nothing yet.')); return; }
    list.replaceChildren(...recent.map((e) => {
      const li = el('li');
      li.append(el('span', 't', timeText(e.ts)), el('span', 'k', e.kind), el('span', 'd', logSummary(e) || '—'));
      li.querySelector<HTMLElement>('.k')!.dataset.k = e.kind;
      return li;
    }));
  }

  /** Project selects in both forms: live floors; defaults to the current floor when the panel opens. */
  #renderProjects(): void {
    const floors = liveFloors(this.#state.projects);
    const key = JSON.stringify(floors.map((p) => [p.id, p.name]));
    if (key === this.#keys.projects) return;
    const first = !this.#keys.projects;
    this.#keys.projects = key;
    const here = this.#state.currentFloor !== LOBBY && floors.some((p) => p.id === this.#state.currentFloor) ? this.#state.currentFloor : '';
    const fill = (sel: HTMLSelectElement, opts: [string, string][], dflt: string) => {
      const prev = sel.value;
      sel.replaceChildren(...opts.map(([v, t]) => { const o = el('option', '', t); o.value = v; return o; }));
      sel.value = !first && opts.some(([v]) => v === prev) ? prev : dflt;
      if (sel.selectedIndex < 0 && opts.length) sel.selectedIndex = 0;
    };
    const proj = floors.map((p) => [p.id, p.name] as [string, string]);
    fill($<HTMLSelectElement>('instrScope'), [['', 'All projects'], ...proj], here);
    fill($<HTMLSelectElement>('grantProject'), proj, here || (proj[0]?.[0] ?? ''));
    const noFloors = !floors.length;
    for (const id of ['grantProject', 'grantAction', 'grantBranch', 'grantUses', 'grantTtl', 'grantAdd']) $<HTMLInputElement>(id).disabled = noFloors;
    if (noFloors) this.#formMsg('grantMsg', 'Grants need a project. One appears once a Claude Code session reports in.');
    else if ($('grantMsg').dataset.auto) this.#formMsg('grantMsg', '');
    $('grantMsg').dataset.auto = noFloors ? '1' : '';
  }

  // ---------------------------------------------------------------- writes
  /** POSTs and shows the server's 400 text (or a generic line) next to the item. */
  async #act(id: string, path: string, body: unknown): Promise<void> {
    const st: ItemState = { busy: true, msg: '' };
    this.#items.set(id, st);
    this.render();
    const err = await this.#send(path, body);
    st.busy = false;
    st.msg = err ?? '';
    if (!err) this.#items.delete(id);
    this.render();
  }

  /** null on success, else the message to show. */
  async #send(path: string, body: unknown): Promise<string | null> {
    try {
      const r = await post(path, body);
      if (r.ok) return null;
      const text = (await r.text().catch(() => '')).trim();
      if (r.status === 400 && text) return text;
      if (r.status === 404) return text || 'This is no longer there.';
      return `Could not save (HTTP ${r.status}).`;
    } catch { return 'Could not reach the office server.'; }
  }

  #formMsg(id: string, text: string): void {
    const m = $(id);
    m.hidden = !text;
    m.textContent = text;
  }

  async #setEnabled(on: boolean): Promise<void> {
    this.#enabledBusy = true;
    this.#formMsg('bubEnabledMsg', '');
    this.render();
    const err = await this.#send('/api/bubbles/enabled', { enabled: on });
    this.#enabledBusy = false;
    if (err) this.#formMsg('bubEnabledMsg', err);
    this.render();
  }

  async #addInstruction(): Promise<void> {
    const ta = $<HTMLTextAreaElement>('instrText'), btn = $<HTMLButtonElement>('instrAdd');
    const text = ta.value.trim();
    if (!text) { this.#formMsg('instrMsg', 'Write the instruction first (1–1000 characters).'); ta.focus(); return; }
    const projectId = $<HTMLSelectElement>('instrScope').value || null;
    btn.disabled = true;
    const err = await this.#send('/api/bubbles/instructions', { projectId, text });
    btn.disabled = false;
    this.#formMsg('instrMsg', err ?? '');
    if (!err) ta.value = '';
  }

  async #addGrant(): Promise<void> {
    const btn = $<HTMLButtonElement>('grantAdd');
    const projectId = $<HTMLSelectElement>('grantProject').value;
    if (!projectId) return;
    const branch = $<HTMLInputElement>('grantBranch').value.trim();
    const uses = $<HTMLSelectElement>('grantUses').value === 'unlimited' ? null : 1;
    const body = { projectId, action: $<HTMLSelectElement>('grantAction').value, branch: branch || null, uses, ttlMs: Number($<HTMLSelectElement>('grantTtl').value) };
    btn.disabled = true;
    const err = await this.#send('/api/bubbles/grants', body);
    btn.disabled = false;
    this.#formMsg('grantMsg', err ?? '');
    if (!err) $<HTMLInputElement>('grantBranch').value = '';
  }
}
