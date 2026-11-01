// The Log view (#logView): Bubbles' append-only audit log, newest first. Filters (project, kind, text)
// query GET /api/log; live `log` messages that match the filters are prepended. Clicking a row shows the
// full entry as JSON and its transcript path with a copy button. Entry text is model/agent text:
// textContent only, never markup.
import type { LogEntry } from '../shared/protocol.ts';
import { logMatches, logSummary, type LogFilter, type OfficeState } from './state.ts';
import { timeText } from './bubbles-panel.ts';
import { getApi } from './panel.ts';

export const LOG_KINDS = ['triage', 'escalation', 'owner-answer', 'guard', 'grant', 'instruction', 'toggle', 'error', 'usage'] as const;
const PAGE = 200;
const MAX_ROWS = 500;
const DEBOUNCE_MS = 250;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class LogView {
  #state: OfficeState;
  #projectName: (id: string) => string;
  #dlg: HTMLDialogElement;
  #rows: LogEntry[] = []; // what the table shows, newest first
  #selected: number | null = null;
  #opener: HTMLElement | null = null;
  #req = 0; // the latest query; older answers are dropped
  #debounce: ReturnType<typeof setTimeout> | null = null;
  #projectsKey = '';

  constructor(state: OfficeState, projectName: (id: string) => string) {
    this.#state = state;
    this.#projectName = projectName;
    this.#dlg = $<HTMLDialogElement>('logView');
    const kind = $<HTMLSelectElement>('logKind');
    kind.replaceChildren(this.#opt('', 'All kinds'), ...LOG_KINDS.map((k) => this.#opt(k, k)));
    $('logBtn').addEventListener('click', (e) => this.open(e.currentTarget as HTMLElement));
    $('logClose').addEventListener('click', () => this.#dlg.close());
    this.#dlg.addEventListener('close', () => this.#closed());
    this.#dlg.addEventListener('mousedown', (e) => { if (e.target === this.#dlg) { const r = this.#dlg.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) this.#dlg.close(); } });
    $('logFilters').addEventListener('submit', (e) => { e.preventDefault(); void this.#load(); });
    $('logProject').addEventListener('change', () => void this.#load());
    kind.addEventListener('change', () => void this.#load());
    $('logGrep').addEventListener('input', () => {
      if (this.#debounce) clearTimeout(this.#debounce);
      this.#debounce = setTimeout(() => { this.#debounce = null; void this.#load(); }, DEBOUNCE_MS);
    });
    $('logCopy').addEventListener('click', () => void this.#copy());
    $('logRows').addEventListener('click', (e) => this.#pickRow(e.target as HTMLElement));
    $('logRows').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      this.#pickRow(e.target as HTMLElement);
    });
  }

  get isOpen(): boolean { return this.#dlg.open; }

  open(opener?: HTMLElement | null): void {
    if (this.#dlg.open) return;
    this.#opener = opener ?? (document.activeElement as HTMLElement | null);
    this.projectsChanged();
    this.#select(null); // a fresh look: no stale detail from last time
    this.#dlg.showModal();
    $('logProject').focus();
    void this.#load();
  }

  #closed(): void {
    if (this.#debounce) { clearTimeout(this.#debounce); this.#debounce = null; }
    this.#req++; // drop answers still in flight
    const o = this.#opener;
    this.#opener = null;
    if (o?.isConnected) o.focus(); else $('logBtn').focus();
  }

  #filter(): LogFilter {
    return { project: $<HTMLSelectElement>('logProject').value, kind: $<HTMLSelectElement>('logKind').value, grep: $<HTMLInputElement>('logGrep').value.trim() };
  }

  #opt(value: string, text: string): HTMLOptionElement {
    const o = document.createElement('option');
    o.value = value; o.textContent = text;
    return o;
  }

  /** Project filter options: every project (archived ones too: their history is still in the log). */
  projectsChanged(): void {
    const ps = [...this.#state.projects].sort((a, b) => Number(a.archived) - Number(b.archived) || a.order - b.order);
    const key = JSON.stringify(ps.map((p) => [p.id, p.name, p.archived]));
    if (key === this.#projectsKey) return;
    this.#projectsKey = key;
    const sel = $<HTMLSelectElement>('logProject'), prev = sel.value;
    sel.replaceChildren(this.#opt('', 'All projects'), ...ps.map((p) => this.#opt(p.id, p.archived ? `${p.name} (archived)` : p.name)));
    sel.value = ps.some((p) => p.id === prev) ? prev : '';
    if (this.#dlg.open) this.#renderRows(); // names in the Project column
  }

  async #load(): Promise<void> {
    const f = this.#filter();
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (f.project) q.set('project', f.project);
    if (f.kind) q.set('kind', f.kind);
    if (f.grep) q.set('grep', f.grep);
    const id = ++this.#req;
    let msg = '';
    let rows: LogEntry[] | null = null;
    try {
      const r = await getApi(`/api/log?${q}`);
      if (r.ok) rows = await r.json() as LogEntry[];
      else msg = r.status === 400 ? (await r.text()).trim() || 'The server refused this filter.' : `Could not load the log (HTTP ${r.status}).`;
    } catch { msg = 'Could not reach the office server.'; }
    if (id !== this.#req) return;
    const m = $('logMsg');
    m.hidden = !msg;
    m.textContent = msg;
    if (!rows) return;
    this.#state.mergeLog(rows);
    this.#rows = rows.sort((a, b) => b.seq - a.seq);
    if (this.#selected !== null && !this.#rows.some((e) => e.seq === this.#selected)) this.#select(null);
    this.#renderRows();
  }

  /** Live entries: prepend the ones that match the current filters (and are not already listed). */
  onLog(fresh: LogEntry[]): void {
    if (!this.#dlg.open) return;
    const f = this.#filter(), have = new Set(this.#rows.map((e) => e.seq));
    const add = fresh.filter((e) => !have.has(e.seq) && logMatches(e, f));
    if (!add.length) return;
    this.#rows = [...add, ...this.#rows].sort((a, b) => b.seq - a.seq).slice(0, MAX_ROWS);
    this.#renderRows();
  }

  #renderRows(): void {
    const body = $('logRows');
    const focusedSeq = body.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest('tr')?.dataset.seq : undefined;
    const td = (text: string, cls = '') => { const c = document.createElement('td'); c.textContent = text; if (cls) c.className = cls; return c; };
    body.replaceChildren(...this.#rows.map((e) => {
      const tr = document.createElement('tr');
      tr.dataset.seq = String(e.seq);
      tr.dataset.kind = e.kind;
      tr.tabIndex = 0;
      tr.setAttribute('aria-selected', String(e.seq === this.#selected));
      const summary = logSummary(e) || '—';
      tr.setAttribute('aria-label', `${e.kind}, ${timeText(e.ts)}: ${summary.slice(0, 160)}. Show details`);
      const k = td(e.kind, 'k'); k.dataset.k = e.kind;
      tr.append(td(timeText(e.ts), 't'), k, td(e.projectId ? this.#projectName(e.projectId) : '—', 'p'), td(agentText(e), 'a'), td(summary, 'd'));
      return tr;
    }));
    $('logEmpty').hidden = this.#rows.length > 0;
    if (focusedSeq) body.querySelector<HTMLElement>(`tr[data-seq="${focusedSeq}"]`)?.focus();
  }

  #pickRow(t: HTMLElement): void {
    const tr = t.closest<HTMLElement>('tr');
    const seq = Number(tr?.dataset.seq);
    if (!tr || !Number.isFinite(seq)) return;
    this.#select(seq);
    for (const r of $('logRows').querySelectorAll('tr')) r.setAttribute('aria-selected', String(r === tr));
  }

  #select(seq: number | null): void {
    this.#selected = seq;
    const e = seq === null ? undefined : this.#rows.find((x) => x.seq === seq);
    $('logDetail').hidden = !e;
    if (!e) return;
    $('logDetailH').textContent = `Entry #${e.seq} · ${e.kind}`;
    $('logJson').textContent = JSON.stringify(e, null, 2);
    $('logTranscriptRow').hidden = !e.transcriptPath;
    $('logTranscript').textContent = e.transcriptPath ?? '';
    $('logCopyNote').textContent = '';
    if (matchMedia('(max-width: 900px)').matches) $('logDetail').scrollIntoView({ block: 'nearest' });
  }

  async #copy(): Promise<void> {
    const text = $('logTranscript').textContent ?? '';
    const note = $('logCopyNote');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = 'Copied.';
      return;
    } catch { /* no clipboard API or permission: fall back below */ }
    // Fallback: select the path so the owner can copy it (and try the legacy copy command).
    const code = $('logTranscript'), range = document.createRange(), sel = getSelection();
    range.selectNodeContents(code);
    sel?.removeAllRanges(); sel?.addRange(range);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    note.textContent = ok ? 'Copied.' : 'Selected: press Ctrl+C (⌘C on a Mac) to copy.';
  }
}

function agentText(e: LogEntry): string {
  const who = e.agentType ?? (e.agentId ? 'subagent' : e.sessionId ? 'session' : '');
  return e.sessionId ? `${who} ${e.sessionId.slice(0, 8)}` : who || '—';
}
