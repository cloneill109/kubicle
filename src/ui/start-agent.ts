// "Start agent": a small dialog (room + optional task) that asks the server to open a new Terminal
// window running `claude` in that room (POST /api/agents/start). Opened from the header button or by
// clicking a room's door sign. The agent then appears on the floor through the normal hooks.
import { post } from './panel.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LAST_KEY = 'kubicle-start-room:'; // + floor id, per browser

export interface StartAgentOptions {
  /** The floor (project id = its folder) the dialog starts agents on. */
  floor(): string;
  floorName(id: string): string;
  rooms(floor: string): { id: string; name: string }[];
}

export class StartAgentUi {
  #o: StartAgentOptions;
  #dlg = $<HTMLDialogElement>('startDlg');
  #room = $<HTMLSelectElement>('startRoom');
  #task = $<HTMLTextAreaElement>('startTask');
  #msg = $('startMsg');
  #go = $<HTMLButtonElement>('startGo');
  #opener: HTMLElement | null = null;
  #busy = false;

  constructor(o: StartAgentOptions) {
    this.#o = o;
    $('startForm').addEventListener('submit', (e) => { e.preventDefault(); void this.#start(); });
    $('startClose').addEventListener('click', () => this.close());
    $('startCancel').addEventListener('click', () => this.close());
    this.#task.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void this.#start(); } });
    this.#dlg.addEventListener('close', () => { this.#opener?.focus?.(); this.#opener = null; });
  }

  get isOpen(): boolean { return this.#dlg.open; }

  open(room?: string, opener?: HTMLElement | null): void {
    const floor = this.#o.floor();
    const rooms = this.#o.rooms(floor);
    const opt = (id: string, name: string) => { const op = document.createElement('option'); op.value = id; op.textContent = name; return op; };
    this.#room.replaceChildren(opt('', 'Let Bubbles choose (he reads the task)'), ...rooms.map((r) => opt(r.id, r.name)));
    let last: string | null = null;
    try { last = localStorage.getItem(LAST_KEY + floor); } catch { /* blocked storage */ }
    const pick = [room, last].find((id) => id !== undefined && id !== null && (id === '' || rooms.some((r) => r.id === id)));
    this.#room.value = pick ?? '';
    $('startWhere').textContent = `${this.#o.floorName(floor)} · ${floor}`;
    this.#setMsg('');
    this.#opener = opener ?? null;
    if (!this.#dlg.open) this.#dlg.showModal();
    this.#task.focus();
  }

  close(): void { if (this.#dlg.open) this.#dlg.close(); }

  #setMsg(text: string): void { this.#msg.textContent = text; this.#msg.hidden = !text; }

  async #start(): Promise<void> {
    if (this.#busy) return;
    const floor = this.#o.floor(), room = this.#room.value, task = this.#task.value;
    this.#busy = true; this.#go.disabled = true; this.#go.textContent = 'Starting…'; this.#setMsg('');
    try {
      const r = await post('/api/agents/start', { projectId: floor, room, task });
      if (r.status === 202) {
        try { localStorage.setItem(LAST_KEY + floor, room); } catch { /* blocked storage */ }
        this.#task.value = '';
        this.close();
        return;
      }
      let why = `Could not start it (${r.status}).`;
      try { const b = await r.json() as { error?: string }; if (b.error) why = b.error; } catch { /* plain text */ }
      if (r.status === 401 || r.status === 403) why = 'Your office login expired. Restart the server for a new login link.';
      this.#setMsg(why);
    } catch {
      this.#setMsg('The office server did not answer. Is it still running?');
    } finally {
      this.#busy = false; this.#go.disabled = false; this.#go.textContent = 'Start';
    }
  }
}
