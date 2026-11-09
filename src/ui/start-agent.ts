// "Start agent": a small dialog (room + optional task) that asks the server to open a new Terminal
// window running `claude` in that room (POST /api/agents/start). Opened from the header button or by
// from a room's panel (Start agent here). The agent then appears on the floor through the normal hooks.
import { post } from './panel.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LAST_KEY = 'kubicle-start-room:'; // + floor id, per browser

export interface StartAgentOptions {
  /** The floor (project id = its folder) the dialog starts agents on. */
  floor(): string;
  floorName(id: string): string;
  rooms(floor: string): { id: string; name: string }[];
  /** "Set up room": this dialog has closed; open that room's panel, returning focus to `opener`. */
  onSetup(room: string, opener: HTMLElement | null): void;
}

export class StartAgentUi {
  #o: StartAgentOptions;
  #dlg = $<HTMLDialogElement>('startDlg');
  #room = $<HTMLSelectElement>('startRoom');
  #task = $<HTMLTextAreaElement>('startTask');
  #msg = $('startMsg');
  #hint = $('startHint');
  #go = $<HTMLButtonElement>('startGo');
  #setup = $<HTMLButtonElement>('startSetup');
  #cancel = $<HTMLButtonElement>('startCancel');
  #done = $<HTMLButtonElement>('startDone');
  #opener: HTMLElement | null = null;
  #busy = false;
  /** The agent has started and the dialog is only showing its warnings: nothing here can start another. */
  #notice = false;

  constructor(o: StartAgentOptions) {
    this.#o = o;
    $('startForm').addEventListener('submit', (e) => { e.preventDefault(); void this.#start(); });
    $('startClose').addEventListener('click', () => this.close());
    this.#cancel.addEventListener('click', () => this.close());
    this.#done.addEventListener('click', () => this.close());
    this.#task.addEventListener('input', () => this.#syncChoose());
    this.#room.addEventListener('change', () => this.#syncChoose());
    this.#setup.addEventListener('click', () => this.#setUp());
    this.#task.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void this.#start(); } });
    this.#dlg.addEventListener('close', () => { this.#opener?.focus?.(); this.#opener = null; });
  }

  get isOpen(): boolean { return this.#dlg.open; }

  open(room?: string, opener?: HTMLElement | null): void {
    this.#setNotice(false);
    const floor = this.#o.floor();
    const rooms = this.#o.rooms(floor);
    const opt = (id: string, name: string) => { const op = document.createElement('option'); op.value = id; op.textContent = name; return op; };
    this.#room.replaceChildren(opt('', 'Let Bubbles choose'), ...rooms.map((r) => opt(r.id, r.name)));
    let last: string | null = null;
    try { last = localStorage.getItem(LAST_KEY + floor); } catch { /* blocked storage */ }
    const pick = [room, last].find((id) => id !== undefined && id !== null && (id === '' || rooms.some((r) => r.id === id)));
    this.#room.value = pick ?? '';
    this.#syncChoose();
    $('startWhere').textContent = `${this.#o.floorName(floor)} · ${floor}`;
    this.#setMsg('');
    this.#opener = opener ?? null;
    if (!this.#dlg.open) this.#dlg.showModal();
    this.#task.focus();
  }

  close(): void { if (this.#dlg.open) this.#dlg.close(); }

  #setNotice(on: boolean): void {
    this.#notice = on;
    this.#go.hidden = this.#cancel.hidden = on;
    this.#done.hidden = !on;
    this.#room.disabled = this.#task.disabled = on;
    if (on) this.#setup.disabled = true;
  }

  /** "Let Bubbles choose" reads the task, so it needs one: disabled (with a hint) while the task is empty. */
  #syncChoose(): void {
    const choose = this.#room.options[0];
    if (choose?.value === '') {
      const empty = this.#task.value.trim() === '';
      choose.disabled = empty;
      this.#hint.hidden = !empty;
      if (empty && this.#room.value === '') this.#room.value = this.#fallback();
    }
    this.#setup.disabled = this.#room.value === ''; // "Set up room" needs a real room
  }

  /** The keyboard route to a room's panel (door signs are canvas-only). The typed task stays for when Start reopens. */
  #setUp(): void {
    const room = this.#room.value;
    if (!room) return;
    const opener = this.#opener;
    this.#opener = null;
    this.close();
    this.#o.onSetup(room, opener);
  }

  /** The remembered room for this floor if it still exists, else the first room. */
  #fallback(): string {
    const floor = this.#o.floor();
    const rooms = this.#o.rooms(floor);
    let last: string | null = null;
    try { last = localStorage.getItem(LAST_KEY + floor); } catch { /* blocked storage */ }
    return rooms.find((r) => r.id === last)?.id ?? rooms[0]?.id ?? '';
  }

  #setMsg(text: string, problems: string[] = []): void {
    this.#msg.replaceChildren(document.createTextNode(text));
    if (problems.length > 0) {
      const ul = document.createElement('ul');
      for (const p of problems) { const li = document.createElement('li'); li.textContent = p; ul.append(li); }
      this.#msg.append(ul);
    }
    this.#msg.hidden = !text && problems.length === 0;
  }

  async #start(): Promise<void> {
    if (this.#busy || this.#notice) return;
    const floor = this.#o.floor(), room = this.#room.value, task = this.#task.value;
    this.#busy = true; this.#go.disabled = true; this.#go.textContent = 'Starting…'; this.#setMsg('');
    try {
      const r = await post('/api/agents/start', { projectId: floor, room, task });
      if (r.status === 202) {
        try { localStorage.setItem(LAST_KEY + floor, room); } catch { /* blocked storage */ }
        this.#task.value = '';
        const ok = await r.json().catch(() => null) as { room?: unknown; warnings?: unknown } | null;
        const warnings = Array.isArray(ok?.warnings) ? ok.warnings.filter((x): x is string => typeof x === 'string') : [];
        if (warnings.length === 0) { this.close(); return; }
        // Something in the room's setup did not load: this stays up until it has been read.
        const name = this.#o.rooms(floor).find((x) => x.id === ok?.room)?.name;
        this.#setMsg(`The agent started${name ? ` in ${name}` : ''}, with ${warnings.length === 1 ? 'a warning' : 'warnings'}:`, warnings);
        this.#setNotice(true);
        this.#done.focus();
        return;
      }
      let why = `Could not start it (${r.status}).`;
      let problems: string[] = [];
      try {
        const b = await r.json() as { error?: string; problems?: unknown };
        if (b.error) why = b.error;
        if (Array.isArray(b.problems) && b.problems.length > 0) {
          problems = b.problems.filter((x): x is string => typeof x === 'string');
          if (problems.length > 0) why = problems.length === 1 ? '' : 'This room cannot start an agent yet:';
        }
      } catch { /* plain text */ }
      if (r.status === 401 || r.status === 403) { why = 'Your office login expired. Restart the server for a new login link.'; problems = []; }
      this.#setMsg(why, problems);
    } catch {
      this.#setMsg('The office server did not answer. Is it still running?');
    } finally {
      this.#busy = false; this.#go.disabled = false; this.#go.textContent = 'Start';
    }
  }
}
